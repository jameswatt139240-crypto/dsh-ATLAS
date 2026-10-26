/**
 * The dsh-atlas host Remote service (`ctx.atFile`, wire namespace `atFile`).
 * Registered as a TypertRemoteService so the Host Gateway's source-mode
 * discovery exports its @Remote methods to the Web client under
 * `/api/atFile/<method>` with zero generated artifacts: `search` takes the
 * resolved live Agent (the `agent` Typert lookup) and indexes its workspace.
 * File content never crosses this wire or the Host mention boundary; the
 * plugin only indexes and marks user-selected paths.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { hasSubdirectory, indexWorkspace, pinEntry, readDirectory } from './files.ts'
import { inspectReferences } from './reference.ts'
import { NO_EXTERNAL_DISCOVERY, allowsExternal, externalPath, isAbsoluteReference, isUnder, type ExternalAccess } from './external.ts'
import { listSubdirectories } from './files.ts'
import { workspacePathKey } from './defaults.ts'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { BrowseEntry, BrowseListing, DirectoryEntry, DirectoryListing, ExternalAccessScope } from './contract.ts'
import type {
  AtFileSettings,
  AtFileSettingsUpdate,
  ChatCandidate,
  FileEntry,
  GitChange,
  PluginCandidate,
  ReferenceInfo,
  SkillCandidate,
} from './contract.ts'
import type { ResolvedConfig } from './types.ts'
import { effectiveIgnoreFiles } from './defaults.ts'
import { readDshVersion } from './runtime-info.ts'
import { AtlasRegistry, type AtlasRegistration, type AtlasRuntimeInfo } from './atlas.ts'
import { GIT_RESOLVE_PROVIDER, readGitChanges } from './git.ts'
import { rankRecentFolders, readWorkspaces, type RecentFolder } from './recent-folders.ts'

/** At-file workspace service: search the cwd index for the browser picker. */
export class AtFileRuntime extends TypertRemoteService {
  /** Host-side workspace index cache: { at, value } per cwd+filter key. */
  private readonly fileCache = new Map<string, { at: number; value: readonly FileEntry[] }>()
  /** In-flight index walks (concurrent windows share ONE workspace scan). */
  private readonly fileInFlight = new Map<string, Promise<readonly FileEntry[]>>()

  /**
   * Register the service under the `atFile` key (the wire namespace).
   * @param ctx - owning cordis context.
   * @param config - resolved plugin configuration.
   * @param isEnabled - live settings read; false refuses the endpoint.
   */
  constructor(
    ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly readSettings: () => AtFileSettings,
    private readonly writeSettings: (update: AtFileSettingsUpdate) => Promise<AtFileSettings>,
    /** The session's out-of-workspace access (see src/external.ts). */
    private readonly externalAccessFor: (agent: Agent) => ExternalAccess = () => NO_EXTERNAL_DISCOVERY,
  ) {
    super(ctx, 'atFile')
  }

  /** One TTL for the workspace index cache (matches the client cache). */
  private static readonly FILE_CACHE_TTL_MS = 30_000

  /** Read the resolved durable settings through the plugin-owned wire. */
  @Remote
  getSettings(): AtFileSettings {
    return this.readSettings()
  }

  /** Persist one settings field and return the resolved section. */
  @Remote
  updateSettings(update: AtFileSettingsUpdate): Promise<AtFileSettings> {
    return this.writeSettings(update)
  }

  /**
   * Index the addressed agent's workspace and return the bounded entry list.
   * The client caches the list per session and filters per keystroke.
   * @param agent - the live agent resolved from the `agentId` wire field; its
   *   session header owns the workspace cwd.
   * @param signal - caller lifetime; the walk races it.
   * @returns workspace-root-relative entries with their absolute paths.
   */
  @Remote
  async search(agent: Agent, signal: AbortSignal): Promise<readonly FileEntry[]> {
    const settings = this.readSettings()
    if (!settings.enabled) {
      throw new Error('at-file is disabled in Settings')
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      throw new Error('at-file: the session has no workspace directory')
    }
    const cacheKey = `${cwd}|${JSON.stringify(settings.ignoreFiles)}|${JSON.stringify(settings.workspaceIgnoreFiles)}`
    const cached = this.fileCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < AtFileRuntime.FILE_CACHE_TTL_MS) {
      return cached.value
    }
    const inflight = this.fileInFlight.get(cacheKey)
    if (inflight !== undefined) return inflight
    const run = async (): Promise<readonly FileEntry[]> => {
      const index = await indexWorkspace(cwd, {
        maxFiles: this.config.maxIndexedFiles,
        ignoreDirs: this.config.ignoreDirs,
        ignoreFiles: effectiveIgnoreFiles(settings, cwd),
      }, signal)
      this.fileCache.set(cacheKey, { at: Date.now(), value: index.files })
      return index.files
    }
    const promise = run()
    this.fileInFlight.set(cacheKey, promise)
    void promise.then(
      () => { if (this.fileInFlight.get(cacheKey) === promise) this.fileInFlight.delete(cacheKey) },
      () => { if (this.fileInFlight.get(cacheKey) === promise) this.fileInFlight.delete(cacheKey) },
    )
    return promise
  }

  /**
   * Inspect referenced workspace paths: existence, kind, and byte size only.
   * The dock uses this to price a reference and to flag one that no longer
   * resolves. Entry metadata is the only thing read; file content stays unopened.
   * @param agent - the live agent resolved from the `agentId` wire field; its
   *   session header owns the workspace cwd.
   * @param targets - workspace-relative paths, already stripped of line ranges.
   * @param signal - caller lifetime.
   * @returns one row per requested path, in request order.
   */
  @Remote
  async inspect(agent: Agent, targets: readonly string[], signal: AbortSignal): Promise<readonly ReferenceInfo[]> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return targets.map(target => ({ relative: target, exists: false }))
    return inspectReferences(cwd, targets, signal, this.externalAccessFor(agent))
  }

  /**
   * The out-of-workspace scope for one session, plus the folder rows `@folder:`
   * may offer for it.
   *
   * Two sources, both bounded and neither a search: the directories the ledger
   * already knows (usable in EVERY mode — they are paths the user referenced
   * themselves), and, only where the session may discover external paths, the
   * sibling directories of the workspace. That second list is one `opendir` of
   * one directory: it is how a plugin author reaches the DSH source tree next to
   * the workspace without any whole-disk walk.
   * @param agent - the live agent; its session header owns the workspace cwd.
   * @param signal - caller lifetime.
   * @returns the scope verdict and the folder rows to offer.
   */
  @Remote
  async external(agent: Agent, signal: AbortSignal): Promise<ExternalAccessScope> {
    const cwd = agent.session.header.cwd
    const access = this.externalAccessFor(agent)
    const roots = [...access.roots]
    if (cwd === undefined || !access.canDiscover) return { canDiscover: access.canDiscover, roots, folders: roots }
    signal.throwIfAborted()
    const parent = dirname(cwd)
    const siblings = await listSubdirectories(parent, {
      // One row of the budget goes to the parent directory itself.
      limit: EXTERNAL_FOLDER_LIMIT - 1,
      ignoreDirs: this.config.ignoreDirs,
      // Skipped INSIDE the walk, so the cap counts only folders that will be
      // offered: the directory above a working tree is mostly dot-directories
      // (caches, scratch clones), and hiding them afterwards let them eat the
      // whole budget and push the real siblings out of the list.
      skipHidden: true,
      // Links are FOLLOWED here (unlike the recursive workspace walk): this is one
      // `opendir` of one level, so a cycle is impossible, and a checkout that sits
      // beside a plugin workspace as a junction into another drive is exactly the
      // folder this feature exists for — skipping the link hid it entirely.
      followLinks: true,
    }, signal).catch(() => [] as readonly string[])
    // The parent comes first: "the DSH folder above my workspace" is the case
    // this feature exists for. Then the sibling checkouts. The workspace itself
    // is never an "outside" folder, and a ledger root that is also a sibling
    // appears once.
    const outside = [externalPath(parent), ...siblings.map(sibling => externalPath(sibling))]
    const folders = [...new Set([...roots, ...outside])]
      .filter(folder => workspacePathKey(folder) !== workspacePathKey(cwd))
    return { canDiscover: true, roots, folders: folders.slice(0, EXTERNAL_FOLDER_LIMIT) }
  }

  /**
   * One bounded, one-level listing of one directory, for the folder browser and
   * the folder tab.
   *
   * `''` means the layer the chooser opens at, which `browseRoot` picks so that
   * this session can actually browse it: the top of the file system when the
   * session may reach it, and the workspace itself when it may not — a browser
   * that opens where it is refused shows no options at all. A
   * workspace path is always allowed; an out-of-workspace one goes through the
   * SAME gate as a reference (`allowsExternal`), so browsing can never see a path
   * the session may not reference — and the refusal comes back as a reason rather
   * than a thrown error, because "this folder is outside the workspace" is a fact
   * the browser has to say in its own words instead of an exception.
   * @param agent - the live agent; its session header owns the workspace cwd.
   * @param path - absolute path, workspace-relative path, or `''` for the root.
   * @param include - ONE child name to guarantee in the page (`''` = no preference);
   * the folder tab passes the object it must select, because the entry cap can cut
   * a page that does not contain it (see {@link pinEntry}).
   * @param signal - caller lifetime.
   * @returns the listing, or the reason it could not be produced.
   */
  @Remote
  async list(agent: Agent, path: string, include: string, signal: AbortSignal): Promise<DirectoryListing> {
    const settings = this.readSettings()
    if (!settings.enabled) throw new Error('at-file is disabled in Settings')
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('at-file: the session has no workspace directory')
    const access = this.externalAccessFor(agent)
    const absolute = isAbsoluteReference(path) ? path : resolve(cwd, path === '' ? browseRoot(cwd, access) : path)
    const canonical = externalPath(absolute)
    if (!isUnder(cwd, absolute) && !allowsExternal(access, absolute)) {
      return { path: canonical, entries: [], error: 'outside' }
    }
    signal.throwIfAborted()
    const info = await stat(absolute).catch(() => undefined)
    signal.throwIfAborted()
    if (info === undefined) return { path: canonical, entries: [], error: 'missing' }
    if (!info.isDirectory()) return { path: canonical, entries: [], error: 'notDirectory' }
    const contents = await pinEntry(
      absolute,
      await readDirectory(absolute, DIRECTORY_ENTRY_LIMIT, signal),
      include,
      signal,
    )
    const root = DRIVE_ROOT.test(canonical) || canonical === '/'
    const drives = root
      ? (await Promise.all(DRIVE_LETTERS.map(letter => driveRoot(letter, signal))))
        .filter((drive): drive is string => drive !== undefined)
      : undefined
    return {
      path: canonical,
      ...(drives === undefined ? { parent: externalPath(dirname(absolute)) } : { drives }),
      entries: contents.entries,
      ...(contents.truncated ? { truncated: true as const } : {}),
    }
  }

  /**
   * One listing for the folder chooser, which browses while the user types.
   *
   * Where {@link list} answers "what is in this directory", this answers "what is
   * in the nearest directory that can be shown": a path that does not exist — a
   * half-typed folder name is the NORMAL case while the editor is typed into — is
   * answered with its longest valid directory prefix, and `requested` carries the
   * asked-for path (canonical spelling, so it always starts with `path`) so the
   * chooser filters that prefix's children by the remaining segment instead of
   * showing an error for every keystroke. The same walk-up covers a path that names
   * a file: the file's folder is listed, and the name becomes the filter.
   *
   * Every row also says whether it opens (`hasChildren`), which is what lets a row
   * be a group the user expands in place instead of a leap of faith. The probes run
   * in parallel under a deadline; a row left without the flag is a row the chooser
   * may still probe, whereas a WRONG flag would hide a folder the user asked to
   * see.
   * @param agent - the live agent; its session header owns the workspace cwd.
   * @param path - absolute path, typed text, or `''` for the default layer.
   * @param signal - caller lifetime.
   * @returns the listing, or the reason it could not be produced.
   */
  @Remote
  async browse(agent: Agent, path: string, signal: AbortSignal): Promise<BrowseListing> {
    const settings = this.readSettings()
    if (!settings.enabled) throw new Error('at-file is disabled in Settings')
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('at-file: the session has no workspace directory')
    const access = this.externalAccessFor(agent)
    const asked = path.trim()
    const wanted = isAbsoluteReference(asked)
      ? asked
      : resolve(cwd, asked === '' ? browseDefault(cwd, access) : asked)
    const found = await nearestDirectory(wanted, signal)
    if (found === undefined) return { path: externalPath(wanted), entries: [], error: 'missing' }
    const canonical = externalPath(found.directory)
    if (!isUnder(cwd, found.directory) && !allowsExternal(access, found.directory)) {
      return { path: canonical, entries: [], error: 'outside' }
    }
    signal.throwIfAborted()
    const contents = await readDirectory(found.directory, DIRECTORY_ENTRY_LIMIT, signal)
    const entries = await withChildPresence(found.directory, contents.entries, signal)
    const root = DRIVE_ROOT.test(canonical) || canonical === '/'
    const drives = root
      ? (await Promise.all(DRIVE_LETTERS.map(letter => driveRoot(letter, signal))))
        .filter((drive): drive is string => drive !== undefined)
      : undefined
    return {
      path: canonical,
      ...(found.exact ? {} : { requested: externalPath(wanted) }),
      ...(drives === undefined ? { parent: externalPath(dirname(found.directory)) } : { drives }),
      entries,
      ...(contents.truncated ? { truncated: true as const } : {}),
    }
  }

  /**
   * Folders to OFFER the folder chooser before it browses anywhere.
   *
   * The chooser's hard question is not how to browse but where the folder is, and
   * the most likely answers are already recorded: the workspaces this machine has
   * opened (`~/.dsh/storages/workspace.json`), ranked so that the current
   * workspace's siblings come first. Reading that ledger is a table lookup, where
   * searching for the same folder means walking file systems (measured: a bounded
   * whole-drive walk cost 36 s at depth 3 and did not finish unbounded), so the
   * candidates are the cheap form of the same answer.
   *
   * Not gated by `allowsExternal`: these are folders the user has ALREADY opened
   * as a workspace on this machine, so offering them reveals nothing the ledger
   * did not already hold, and the chooser re-checks every path it actually
   * browses or adopts through the normal reference gate.
   * @param agent - the live agent; its session header owns the workspace cwd.
   * @param signal - caller lifetime.
   * @returns the ranked candidates (possibly empty; never an error).
   */
  @Remote
  async recentFolders(agent: Agent, signal: AbortSignal): Promise<readonly RecentFolder[]> {
    const settings = this.readSettings()
    if (!settings.enabled) throw new Error('at-file is disabled in Settings')
    const cwd = agent.session.header.cwd ?? ''
    return rankRecentFolders(await readWorkspaces(signal), cwd)
  }
}

/**
 * The layer the folder chooser opens at when it has not been told where to look.
 *
 * A browser that opens SOMEWHERE has to pick a somewhere, and the two platforms
 * answer that differently because their file systems are shaped differently. On
 * Windows the natural entry is the drive list, which the listing itself produces:
 * any drive root reports `drives` in place of `parent`. POSIX has no drive list,
 * so the equivalent entry is the single filesystem root `/`.
 *
 * Resolving the empty path against the workspace — what `resolve(cwd, '.')` does —
 * quietly makes the workspace the default layer on BOTH platforms. On Windows that
 * is invisible, because the chooser is opened at a drive root and the workspace
 * answer is never the one shown; on POSIX it was the defect: the dialog opened on
 * the user's own project with no way up to `/`, which is indistinguishable from
 * "the options are missing".
 * The top is only an entry when the session may BROWSE it. `/` is outside every
 * workspace, so a session without external discovery answers the listing with
 * `error: 'outside'` — measured in a browser on Linux: the dialog opened at `/`,
 * showed the refusal notice and the shortcut list, and not one directory, which is
 * the very symptom this function exists to remove. So ask the same gate the
 * listing asks and fall back to the workspace when it refuses: `danger-full-access`
 * keeps the `/` it has today, and a narrow session opens on the only level it can
 * walk instead of on a refusal.
 * @param cwd - the session's workspace directory.
 * @param access - what this session may reach beyond the workspace.
 * @returns the absolute path the empty request should resolve to.
 */
function browseRoot(cwd: string, access: ExternalAccess): string {
  const root = DRIVE_ROOT.test(externalPath(cwd)) || cwd.startsWith('/') ? '/' : '.'
  if (root === '.') return root
  const candidate = resolve(cwd, root)
  return isUnder(cwd, candidate) || allowsExternal(access, candidate) ? root : '.'
}

/**
 * The layer the chooser opens at, which is the folder the WORKSPACE lives in.
 *
 * The chooser's own question is "which folder do you want", and the likeliest
 * answer by far is one of the folders next to the workspace — the sibling
 * projects, the drive it sits on. Opening ON the workspace hides exactly that
 * layer: the user sees their own project's contents and has to walk up by hand
 * before the folder they came for is even visible. So start one level up, and ask
 * the same gate the listing asks, because a narrow session is refused there and a
 * dialog that opens on a refusal shows nothing; walking further up is the fallback
 * for an access scope whose configured root sits above the workspace, and the
 * workspace itself is the floor when nothing above it may be reached.
 * @param cwd - the session's workspace directory.
 * @param access - what this session may reach beyond the workspace.
 * @returns the absolute path the empty request should resolve to.
 */
function browseDefault(cwd: string, access: ExternalAccess): string {
  let candidate = dirname(resolve(cwd))
  for (;;) {
    if (allowsExternal(access, candidate)) return candidate
    const above = dirname(candidate)
    if (above === candidate) return '.'
    candidate = above
  }
}

/**
 * The nearest directory at or above `path` that exists, and whether it IS `path`.
 *
 * A typed path is a promise the user has not finished making: the useful answer to
 * `/mnt/EShare/Pro` is the children of `/mnt/EShare` filtered by `Pro`, not an
 * error. A file name is the same shape of answer, which is why "exists but is not a
 * directory" walks up exactly like "does not exist".
 * @param path - absolute path to locate.
 * @param signal - caller lifetime.
 * @returns the directory to list and whether the request named it exactly.
 */
async function nearestDirectory(
  path: string,
  signal: AbortSignal,
): Promise<{ readonly directory: string; readonly exact: boolean } | undefined> {
  let candidate = path
  let exact = true
  for (;;) {
    signal.throwIfAborted()
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isDirectory() === true) return { directory: candidate, exact }
    const above = dirname(candidate)
    if (above === candidate) return undefined
    candidate = above
    exact = false
  }
}

/**
 * Attach "does this row open" to every directory row, in parallel and under a cap.
 *
 * The answer is what makes a row expandable instead of merely enterable, so it is
 * worth one `opendir` per folder — but not an unbounded number of them: the budget
 * ends the sweep and the untouched rows simply carry no flag. Hidden children
 * count, because the flag answers "is there anything below", while which of those
 * rows are DRAWN is the chooser's own hidden-files setting.
 * @param directory - the directory the entries came from.
 * @param entries - its direct children.
 * @param signal - caller lifetime.
 * @returns the same rows, directories carrying `hasChildren` when probed in time.
 */
async function withChildPresence(
  directory: string,
  entries: readonly DirectoryEntry[],
  signal: AbortSignal,
): Promise<readonly BrowseEntry[]> {
  const out: BrowseEntry[] = entries.map(entry => ({ ...entry }))
  const deadline = Date.now() + CHILD_PROBE_BUDGET_MS
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const entry = entries[index]
      if (entry === undefined || signal.aborted || Date.now() > deadline) return
      if (entry.kind !== 'dir') continue
      try {
        out[index] = { ...entry, hasChildren: await hasSubdirectory(join(directory, entry.name), {}, signal) }
      } catch {
        // A refused or timed-out probe leaves the flag off; the chooser covers that.
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(CHILD_PROBE_CONCURRENCY, entries.length) },
    worker,
  ))
  return out
}

/** How many child probes one listing runs at once. */
const CHILD_PROBE_CONCURRENCY = 8

/** How long the child probes of one listing may take before flags are dropped. */
const CHILD_PROBE_BUDGET_MS = 600

/** How many rows one directory listing may carry (bounded browser, bounded wire). */
const DIRECTORY_ENTRY_LIMIT = 200

/** One drive root as the wire spells it (`E:/`). */
const DRIVE_ROOT = /^[a-z]:\/$/iu

/** The drive letters a listing at a drive root offers. */
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/**
 * One drive root, or undefined when this machine has no such drive.
 *
 * Probed with `stat` and never cached: a drive can be mapped or unmapped while
 * the window is open, and the sweep only runs while a listing IS at a drive root
 * (the one place a browser needs the other drives). A missing letter answers
 * ENOENT at once, so an absent drive costs one syscall.
 * @param letter - one upper-case drive letter.
 * @param signal - caller lifetime.
 * @returns the drive root, or undefined when there is none.
 */
async function driveRoot(letter: string, signal: AbortSignal): Promise<string | undefined> {
  const root = `${letter}:/`
  const info = await stat(root).catch(() => undefined)
  signal.throwIfAborted()
  return info?.isDirectory() === true ? root : undefined
}

/** How many out-of-workspace folder rows `@folder:` may be offered (bounded). */
const EXTERNAL_FOLDER_LIMIT = 12

/** Host-side capability faces the atMention service forwards to. */
export interface MentionRuntimeDeps {
  /** List discoverable skills for the @skill picker (settings-gated). */
  listSkills(agent: Agent, signal: AbortSignal): Promise<readonly SkillCandidate[]>
  /** List past-session candidates for the @chat picker (settings-gated). */
  listChats(agent: Agent, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]>
  /** List installed plugin entries for the @plugin picker (settings-gated). */
  listPlugins(signal: AbortSignal): Promise<readonly PluginCandidate[]>
}

/**
 * The dsh-atlas host Remote service (`ctx.atMention`, wire namespace
 * `atMention`). Registered as a TypertRemoteService so the Host Gateway
 * exports its @Remote methods to the Web client under
 * `/api/atMention/<method>`: skills and past chats resolve the live Agent
 * (the `agent` Typert lookup); plugins need no agent. Every method is a
 * thin pass-through to the wiring closures so the boundary stays unit-testable
 * without an assembled Cordis scope.
 */
export class AtMentionRuntime extends TypertRemoteService {
  /**
   * Register the service under the `atMention` key (the wire namespace).
   * @param ctx - owning cordis context.
   * @param deps - settings-gated capability closures wired in apply().
   */
  constructor(ctx: Context, private readonly deps: MentionRuntimeDeps) {
    super(ctx, 'atMention')
  }

  /** List discoverable skills for the @skill picker. */
  @Remote
  async listSkills(agent: Agent, signal: AbortSignal): Promise<readonly SkillCandidate[]> {
    return this.deps.listSkills(agent, signal)
  }

  /** List past-session candidates for the @chat picker. */
  @Remote
  async listChats(agent: Agent, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]> {
    return this.deps.listChats(agent, query, limit, signal)
  }

  /** List installed plugin entries for the @plugin picker. */
  @Remote
  async listPlugins(signal: AbortSignal): Promise<readonly PluginCandidate[]> {
    return this.deps.listPlugins(signal)
  }
}

/**
 * The `@` seam's Host-half service (`ctx.atlas`, wire namespace `atlas`).
 *
 * The seam has two halves because DSH plugins do: the browser half answers
 * `list` for the open menu, while this half answers `resolve` when a committed
 * reference becomes model-visible text. This service reports the facts a
 * provider's `testedOn` claim is judged against, and is where the Host-half
 * provider registry lands as the seam grows.
 */
export class AtlasRuntime extends TypertRemoteService {
  /** The Host half of the seam: provides `resolve`, the injection-side callback. */
  private readonly registry: AtlasRegistry

  /**
   * Register the service under the `atlas` key (the wire namespace).
   * @param ctx - owning cordis context.
   * @param readVersion - how to establish the running DSH version; injectable so
   *   an unresolvable install stays testable.
   */
  constructor(
    ctx: Context,
    private readonly readVersion: () => string | undefined = readDshVersion,
  ) {
    super(ctx, 'atlas')
    this.registry = new AtlasRegistry(() => this.facts(), { list: false, resolve: true })
    // The built-in @git source registers exactly the way a plugin does, and
    // through the same gate — if our own provider could skip the checks, the
    // governance layer would be decoration.
    this.registry.register(GIT_RESOLVE_PROVIDER)
  }

  /**
   * The running Harness facts for the version gate.
   * @returns the version when established, otherwise an empty record.
   */
  private facts(): AtlasRuntimeInfo {
    const dshVersion = this.readVersion()
    return dshVersion === undefined ? {} : { dshVersion }
  }

  /**
   * Register one provider's injection half. This is a plain local call (not a
   * wire endpoint): the provider authorizes us by calling it, and the returned
   * disposer withdraws it.
   * @param candidate - the provider declaration, which must carry `resolve`.
   * @returns the disposer that withdraws the registration.
   */
  register(candidate: unknown): () => void {
    return this.registry.register(candidate)
  }

  /** The live injection-side registrations, in registration order. */
  registrations(): readonly AtlasRegistration[] {
    return this.registry.entries()
  }

  /**
   * Report the running Harness facts.
   * @param signal - caller lifetime.
   * @returns the version when it could be established, otherwise an empty record
   *   (an unknown version must never read as a matching one).
   */
  @Remote
  runtime(signal: AbortSignal): AtlasRuntimeInfo {
    signal.throwIfAborted()
    return this.facts()
  }

  /**
   * The addressed workspace's changed paths — the built-in `@git` provider's
   * candidate list. The browser half filters this per keystroke, so the answer
   * is the whole bounded list rather than a server-side search.
   * @param agent - the live agent resolved from the `agentId` wire field.
   * @param signal - caller lifetime.
   * @returns the changes, or an empty list outside a Git workspace.
   */
  @Remote
  async gitChanges(agent: Agent, signal: AbortSignal): Promise<readonly GitChange[]> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return []
    return readGitChanges(cwd, signal)
  }
}