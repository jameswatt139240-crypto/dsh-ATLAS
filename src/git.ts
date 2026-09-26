/**
 * The built-in `@git` provider's data access: what changed in the workspace, and
 * the diff for one of those changes.
 *
 * This provider exists so the seam ships with one real data source and a
 * copyable template (see the Provider API chapter of the README). It reaches for
 * exactly one thing — the `git` process — and never opens a file: an untracked
 * file's content arrives as Git's own "new file" diff. Everything degrades to
 * "nothing changed" rather than raising, because a workspace that is not a Git
 * repository is normal, not an error.
 */
import { execFile } from 'node:child_process'
import type { AtlasProvider } from './atlas.ts'
import {
  BUILTIN_TESTED_ON,
  GIT_PROVIDER_ID,
  GIT_SCOPES,
  type GitChange,
} from './contract.ts'
import { DEFAULT_IGNORE_DIRS } from './defaults.ts'

/** A slow Git call must not hold the menu open. */
const GIT_TIMEOUT_MS = 5_000
/** `git status` on a large dirty tree is still plain text; this is a safety net. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024
/** Beyond this the candidate list stops being a menu. */
const MAX_GIT_CHANGES = 400

/**
 * Run one git command in `cwd`.
 * @param cwd - the workspace directory the command runs in.
 * @param args - git arguments, already split.
 * @param signal - caller lifetime; the child is killed with it.
 * @returns stdout, or undefined when git could not answer at all (not installed,
 *   aborted, or starved of buffer). A non-zero git exit is NOT a failure here:
 *   `diff --no-index` reports "files differ" as exit 1 and its stdout is the answer.
 */
function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(undefined)
      return
    }
    const done = (error: unknown, stdout: string): void => {
      const failure = error as (Error & { code?: unknown }) | null
      // A string `code` is Node's own failure (ENOENT, maxBuffer, aborted) rather
      // than git's exit status, which is numeric.
      if (failure !== null && failure !== undefined && (failure.name === 'AbortError' || typeof failure.code === 'string')) {
        resolve(undefined)
        return
      }
      resolve(stdout)
    }
    try {
      execFile(
        'git',
        [...args],
        { cwd, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
        (error, stdout) => { done(error, stdout) },
      )
    } catch (error) {
      done(error, '')
    }
  })
}

/**
 * Whether a path lives under one of the built-in ignored directories.
 * @param path - a repository-relative path from `git status`.
 * @returns true when any segment is an ignored directory name.
 */
function underIgnoredDir(path: string): boolean {
  return path.split('/').some(segment => (DEFAULT_IGNORE_DIRS as readonly string[]).includes(segment))
}

/**
 * Parse porcelain v1 output into changes, dropping ignored directories.
 * @param output - the raw `git status --porcelain=v1` text.
 * @returns one entry per changed path, in git's order.
 */
export function parseGitStatus(output: string): readonly GitChange[] {
  const changes: GitChange[] = []
  for (const line of output.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2).trim()
    const rest = line.slice(3)
    // Renames read `R  old -> new`; everything else is the path itself.
    const arrow = rest.lastIndexOf(' -> ')
    const path = arrow < 0 ? rest : rest.slice(arrow + 4)
    if (path === '' || underIgnoredDir(path)) continue
    changes.push({ path, status: code === '' ? 'M' : code })
  }
  return changes
}

/**
 * Parse `git diff --numstat` output into per-path line counts.
 * @param output - the raw numstat text.
 * @returns a path-keyed count map; binary files have no counts and are absent.
 */
export function parseGitNumstat(output: string): ReadonlyMap<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>()
  for (const line of output.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = Number.parseInt(parts[0]!, 10)
    const removed = Number.parseInt(parts[1]!, 10)
    if (Number.isNaN(added) || Number.isNaN(removed)) continue
    const arrow = parts[2]!.lastIndexOf(' -> ')
    counts.set(arrow < 0 ? parts[2]! : parts[2]!.slice(arrow + 4), { added, removed })
  }
  return counts
}

/**
 * The workspace's changed paths, with line counts where Git can count them.
 * @param cwd - the workspace directory.
 * @param signal - caller lifetime.
 * @returns the changes, or an empty list outside a Git workspace.
 */
export async function readGitChanges(cwd: string, signal: AbortSignal): Promise<readonly GitChange[]> {
  const status = await git(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all'], signal)
  if (status === undefined || status.trim() === '') return []
  const counts = parseGitNumstat(await git(cwd, ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--numstat'], signal) ?? '')
  return parseGitStatus(status).slice(0, MAX_GIT_CHANGES).map(change => {
    const count = counts.get(change.path)
    return count === undefined ? change : { ...change, added: count.added, removed: count.removed }
  })
}

/**
 * The diff for one changed path. A path Git sees as unchanged against HEAD is
 * retried against the empty file, so an untracked path's content arrives as
 * Git's own "new file" hunk rather than as a file read.
 * @param cwd - the workspace directory.
 * @param path - the repository-relative path being committed.
 * @param signal - caller lifetime.
 * @returns the diff text, or undefined when Git produced none.
 */
export async function readGitDiff(
  cwd: string,
  path: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const tracked = await git(cwd, ['diff', 'HEAD', '--', path], signal)
  if (tracked !== undefined && tracked.trim() !== '') return tracked
  const untracked = await git(cwd, ['diff', '--no-index', '--', '/dev/null', path], signal)
  return untracked !== undefined && untracked.trim() !== '' ? untracked : undefined
}

/**
 * The built-in `@git` provider's injection half.
 *
 * This is the seam's worked example, and it is deliberately not privileged: it
 * declares `scopes`/`testedOn` and goes through the same registry and the same
 * version gate as a third-party provider. Its menu half is registered in the
 * browser (see `client/git-provider.ts`) because the candidates must be filtered
 * per keystroke while the repository lives on the Host.
 */
export const GIT_RESOLVE_PROVIDER: AtlasProvider = {
  id: GIT_PROVIDER_ID,
  display: 'Git',
  scopes: GIT_SCOPES,
  testedOn: BUILTIN_TESTED_ON,
  async resolve(item, context) {
    if (context.cwd === undefined) return ''
    return (await readGitDiff(context.cwd, item.id, context.signal)) ?? ''
  },
}
