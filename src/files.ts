/**
 * Workspace path indexing over node:fs. The walk streams directories one
 * dirent at a time (memory stays O(one level) even under a giant directory),
 * never follows symlinks, skips configured ignore dirs by basename, and
 * hard-stops at the configured entry cap with an honest `truncated` flag.
 */
import { opendir, stat } from 'node:fs/promises'
import type { Dir, Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { FileEntry, FileIgnoreRuleInput } from './contract.ts'
import { compileIgnoreRules } from './defaults.ts'

/** Options for one bounded index pass. */
export interface IndexOptions {
  /** Hard cap on collected files. */
  readonly maxFiles: number
  /** Directory basenames the walk skips (children never enqueue). */
  readonly ignoreDirs: readonly string[]
  /** Exact and Regex basename filters applied before files enter the index. */
  readonly ignoreFiles: readonly FileIgnoreRuleInput[]
}

/** One index pass result: the sorted file list plus the honest truncation flag. */
export interface WorkspaceIndex {
  readonly files: readonly FileEntry[]
  /** True when the walk hit `maxFiles` before the tree was exhausted. */
  readonly truncated: boolean
}

/** Directory opener seam used by the real filesystem and deterministic tests. */
export type OpenWorkspaceDirectory = (path: string) => Promise<Dir>

/** Await `operation`, rejecting with the signal's reason the moment it aborts. */
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    /* v8 ignore start -- requires a filesystem await to stall exactly while abort lands; pre-aborted callers exit before raceAbort. */
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its handle is being closed by the aborting caller,
        // and the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    /* v8 ignore stop */
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  /* v8 ignore next -- the non-Error arm needs a non-Error abort reason fired mid-await; pre-aborted signals throw their reason directly. */
  return reason instanceof Error ? reason : new Error(String(reason))
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/** Forward-slash display path of `child` relative to `root` (stable across platforms). */
function displayRelative(root: string, child: string): string {
  return relative(root, child).split(sep).join('/')
}

/** Close a departed caller's abandoned directory handle without awaiting a queued read. */
function closeOrSwallow(handle: Dir, signal: AbortSignal | undefined): Promise<void> {
  const closing = handle.close()
  /* v8 ignore start -- an abort landing between a read and the close needs a filesystem stall; the abandoned-close arm has no observable outcome. */
  if (signal?.aborted) {
    closing.catch(() => {
      // The caller already departed; a close failure has no consumer.
    })
    return Promise.resolve()
  }
  /* v8 ignore stop */
  return closing
}

/**
 * Collect every regular file under `root` (bounded, name-sorted).
 * @param root - workspace root to walk.
 * @param options - cap and ignore list.
 * @param signal - caller lifetime; every filesystem await races it.
 * @param openDirectory - directory opener; defaults to node:fs.
 * @returns the sorted file list and the truncation flag.
 */
export async function indexWorkspace(
  root: string,
  options: IndexOptions,
  signal?: AbortSignal,
  openDirectory: OpenWorkspaceDirectory = opendir,
): Promise<WorkspaceIndex> {
  const ignoreDirs = new Set(options.ignoreDirs)
  const ignoreRules = compileIgnoreRules(options.ignoreFiles)
  const compiledRegex = new Map(ignoreRules
    .filter(rule => rule.kind === 'regex')
    .map(rule => [rule, new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i')]))
  const files: FileEntry[] = []
  const queue: string[] = [root]
  let truncated = false
  while (queue.length > 0) {
    signal?.throwIfAborted()
    const dir = queue.shift() as string
    let handle: Dir
    try {
      handle = await raceAbort(openDirectory(dir), signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (dir === root) throw new Error(`at-file: cannot list "${dir}": ${messageOf(error)}`)
      console.warn(`[dsh-atlas] skipping unreadable directory "${dir}": ${messageOf(error)}`)
      continue
    }
    try {
      for (;;) {
        let dirent: Dirent | null
        try {
          dirent = await raceAbort(handle.read(), signal)
        } catch (error: unknown) {
          signal?.throwIfAborted()
          console.warn(`[dsh-atlas] stopped reading directory "${dir}": ${messageOf(error)}`)
          break
        }
        if (dirent === null) break
        if (files.length >= options.maxFiles) {
          truncated = true
          break
        }
        // Symlinked directories are never entered (a link cycle cannot strand
        // the walk); symlinked files are followed only implicitly through the
        // dirent of their parent — a symlink dirent itself is skipped.
        if (dirent.isSymbolicLink()) continue
        const child = join(dir, dirent.name)
        if (dirent.isDirectory()) {
          if (ignoreDirs.has(dirent.name)) continue
          // Directories are indexed entries too, so the picker can reference
          // one path without inspecting its descendants at send time.
          files.push({ path: child, relative: displayRelative(root, child), kind: 'dir' })
          queue.push(child)
          continue
        }
        if (dirent.isFile() && !ignoreRules.some(rule => {
          if (rule.kind === 'exact') {
            return rule.caseSensitive ? dirent.name === rule.pattern : dirent.name.toLowerCase() === rule.pattern.toLowerCase()
          }
          return (compiledRegex.get(rule) as RegExp).test(dirent.name)
        })) {
          files.push({ path: child, relative: displayRelative(root, child), kind: 'file' })
        }
      }
    } finally {
      await closeOrSwallow(handle, signal)
    }
    if (truncated) break
  }
  files.sort((a, b) => a.relative < b.relative ? -1 : 1)
  return { files, truncated }
}

/**
 * Whether one path resolves to a directory, following links.
 *
 * Only the one-level sibling listing asks, and only for entries that ARE links:
 * its recursive counterpart never follows one at all. A broken link (or a target
 * this process may not touch) answers false, so a dead junction is left out of
 * the offered rows rather than handed to the user as a folder that cannot open.
 * @param path - absolute child path.
 * @param signal - caller lifetime; every filesystem await races it.
 * @returns true when the path is a directory once links are resolved.
 */
async function isDirectory(path: string, signal?: AbortSignal): Promise<boolean> {
  const info = await raceAbort(stat(path), signal).catch(() => undefined)
  return info?.isDirectory() === true
}

/**
 * List the DIRECT subdirectories of one directory (one level, never recursive).
 *
 * Used to offer the folders around a session workspace — the sibling checkouts
 * a plugin author routinely needs, e.g. the DSH source tree beside the workspace
 * — without walking anything: one `opendir` of one directory. Symlinks are
 * skipped exactly like the workspace walk skips them (a link cycle can never
 * strand this), ignore-listed directory names are skipped by basename, and the
 * bounded result is name-sorted.
 * @param dir - absolute directory to list.
 * @param options - cap and the ignored directory basenames.
 * @param signal - caller lifetime; the filesystem awaits race it.
 * @param openDirectory - directory opener; defaults to node:fs.
 * @returns absolute child directory paths, name-sorted and capped.
 */
export async function listSubdirectories(
  dir: string,
  options: {
    readonly limit: number
    readonly ignoreDirs: readonly string[]
    readonly skipHidden?: boolean
    readonly followLinks?: boolean
  },
  signal?: AbortSignal,
  openDirectory: OpenWorkspaceDirectory = opendir,
): Promise<readonly string[]> {
  signal?.throwIfAborted()
  const ignoreDirs = new Set(options.ignoreDirs)
  const out: string[] = []
  let handle: Dir
  try {
    handle = await raceAbort(openDirectory(dir), signal)
  } catch (error: unknown) {
    signal?.throwIfAborted()
    throw new Error(`at-file: cannot list "${dir}": ${messageOf(error)}`)
  }
  try {
    for (;;) {
      if (out.length >= options.limit) break
      let dirent: Dirent | null
      try {
        dirent = await raceAbort(handle.read(), signal)
      } catch (error: unknown) {
        signal?.throwIfAborted()
        console.warn(`[dsh-atlas] stopped reading directory "${dir}": ${messageOf(error)}`)
        break
      }
      if (dirent === null) break
      // A directory ENTRY is taken as-is; a link (junction or symlink) is taken
      // only when the caller asked for links AND it resolves to a directory. The
      // recursive workspace walk skips links outright (a cycle cannot strand it),
      // but this listing is ONE level deep: a cycle is impossible here, and a
      // checkout reachable only through a junction is exactly what a caller
      // listing the folders around a workspace wants to see.
      const linked = dirent.isSymbolicLink()
      if (!dirent.isDirectory() && !(linked && options.followLinks === true)) continue
      if (ignoreDirs.has(dirent.name)) continue
      // A hidden directory is excluded HERE, before the cap counts it. The
      // directory above a working tree is where caches and scratch clones live,
      // so filtering after the cap would spend the whole budget on dot-names and
      // return almost nothing the caller wanted (measured live: 11 slots, 8 of
      // them hidden, leaving two visible folders).
      if (options.skipHidden === true && dirent.name.startsWith('.')) continue
      const child = join(dir, dirent.name)
      if (linked && !await isDirectory(child, signal)) continue
      out.push(child)
    }
  } finally {
    await closeOrSwallow(handle, signal)
  }
  out.sort((left, right) => left.localeCompare(right))
  return out
}

/** One row of a one-level directory listing: a name and what it is. */
export interface DirectoryEntryInfo {
  readonly name: string
  readonly kind: 'file' | 'dir'
}

/** One directory's direct children, name-sorted with directories first. */
export interface DirectoryContents {
  readonly entries: readonly DirectoryEntryInfo[]
  /** True when the entry cap cut the listing short. */
  readonly truncated: boolean
}

/**
 * List ONE directory's direct children, files included.
 *
 * The folder browser and the folder tab need what a file manager shows — both
 * kinds, in one level — where {@link listSubdirectories} answers "which folders
 * are next to this one". A link (junction or symlink) is reported as what it
 * POINTS AT and dropped when it points at nothing, because a row the user cannot
 * enter is worse than no row. Directories come first, then names, so the shape of
 * the tree reads before its contents do.
 * @param dir - absolute directory to list.
 * @param limit - hard cap on returned entries.
 * @param signal - caller lifetime; the filesystem awaits race it.
 * @param openDirectory - directory opener; defaults to node:fs.
 * @returns the entries and whether the cap was reached.
 */
export async function readDirectory(
  dir: string,
  limit: number,
  signal?: AbortSignal,
  openDirectory: OpenWorkspaceDirectory = opendir,
): Promise<DirectoryContents> {
  signal?.throwIfAborted()
  const entries: DirectoryEntryInfo[] = []
  let handle: Dir
  try {
    handle = await raceAbort(openDirectory(dir), signal)
  } catch (error: unknown) {
    signal?.throwIfAborted()
    throw new Error(`at-file: cannot list "${dir}": ${messageOf(error)}`)
  }
  let truncated = false
  try {
    for (;;) {
      if (entries.length >= limit) {
        truncated = true
        break
      }
      let dirent: Dirent | null
      try {
        dirent = await raceAbort(handle.read(), signal)
      } catch (error: unknown) {
        signal?.throwIfAborted()
        console.warn(`[dsh-atlas] stopped reading directory "${dir}": ${messageOf(error)}`)
        break
      }
      if (dirent === null) break
      if (dirent.isSymbolicLink()) {
        const target = await raceAbort(stat(join(dir, dirent.name)), signal).catch(() => undefined)
        if (target === undefined) continue
        entries.push({ name: dirent.name, kind: target.isDirectory() ? 'dir' : 'file' })
        continue
      }
      if (!dirent.isDirectory() && !dirent.isFile()) continue
      entries.push({ name: dirent.name, kind: dirent.isDirectory() ? 'dir' : 'file' })
    }
  } finally {
    await closeOrSwallow(handle, signal)
  }
  entries.sort((left, right) => (left.kind === right.kind
    ? left.name.localeCompare(right.name)
    : left.kind === 'dir' ? -1 : 1))
  return { entries, truncated }
}
