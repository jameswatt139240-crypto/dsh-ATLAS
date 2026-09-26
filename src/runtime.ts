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
import { indexWorkspace, readDirectory } from './files.ts'
import { inspectReferences } from './reference.ts'
import { NO_EXTERNAL_DISCOVERY, allowsExternal, externalPath, isAbsoluteReference, isUnder, type ExternalAccess } from './external.ts'
import { listSubdirectories } from './files.ts'
import { workspacePathKey } from './defaults.ts'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DirectoryListing, ExternalAccessScope } from './contract.ts'
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
   * `''` means the session's workspace root, which is where a browser starts. A
   * workspace path is always allowed; an out-of-workspace one goes through the
   * SAME gate as a reference (`allowsExternal`), so browsing can never see a path
   * the session may not reference — and the refusal comes back as a reason rather
   * than a thrown error, because "this folder is outside the workspace" is a fact
   * the browser has to say in its own words instead of an exception.
   * @param agent - the live agent; its session header owns the workspace cwd.
   * @param path - absolute path, workspace-relative path, or `''` for the root.
   * @param signal - caller lifetime.
   * @returns the listing, or the reason it could not be produced.
   */
  @Remote
  async list(agent: Agent, path: string, signal: AbortSignal): Promise<DirectoryListing> {
    const settings = this.readSettings()
    if (!settings.enabled) throw new Error('at-file is disabled in Settings')
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('at-file: the session has no workspace directory')
    const absolute = isAbsoluteReference(path) ? path : resolve(cwd, path === '' ? '.' : path)
    const canonical = externalPath(absolute)
    if (!isUnder(cwd, absolute) && !allowsExternal(this.externalAccessFor(agent), absolute)) {
      return { path: canonical, entries: [], error: 'outside' }
    }
    signal.throwIfAborted()
    const info = await stat(absolute).catch(() => undefined)
    signal.throwIfAborted()
    if (info === undefined) return { path: canonical, entries: [], error: 'missing' }
    if (!info.isDirectory()) return { path: canonical, entries: [], error: 'notDirectory' }
    const contents = await readDirectory(absolute, DIRECTORY_ENTRY_LIMIT, signal)
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
}

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