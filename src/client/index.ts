/**
 * Build-time ad switch. The shipped default build stubs out the ad panel and
 * defines this flag as `false`, so no ad code or banner image reaches the
 * bundle; `node build.mjs --ads` produces the ad-bearing variant. The read is a
 * runtime one so a test can toggle the global and exercise both arms.
 */
declare const __DSH_ATLAS_ADS__: boolean | undefined

/** Whether this build carries the side ad panel. */
function adsEnabled(): boolean {
  return typeof __DSH_ATLAS_ADS__ === 'boolean' && __DSH_ATLAS_ADS__
}

/**
 * dsh-atlas client plugin: the browser half of the category-based @
 * mention surface. Mounts the combined atFile + atMention Remote
 * contribution, registers the '@' trigger source (category picker landing
 * plain-text tokens), the referenced-item dock above the composer
 * (open/remove, gated by settings), the settings section, and locale
 * dictionaries. The Host only validates and marks the chosen references;
 * neither half reads mentioned file content.
 */
// Type-only: the ctx.remote merge and the forwarded Host-event face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: the conversation SlotMap / standard-kit merges for the dock seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: brings the settings.section SlotMap declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: brings the ctx.slots Context merge (slot registration) in.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  AtFileSettings,
  AtFileSettingsUpdate,
  BrowseListing,
  ChatCandidate,
  DirectoryListing,
  FileEntry,
  FileIgnoreRuleInput,
  GitChange,
  ExternalAccessScope,
  FolderOpenTarget,
  HistoryFrameMode,
  HistoryReuseMode,
  PluginCandidate,
  RecentFolder,
  ReferenceInfo,
  SkillCandidate,
} from '../contract.ts'
import { AT_REMOTE } from './remote.ts'
import { AtlasRegistry, type AtlasCallContext, type AtlasRuntimeInfo } from '../atlas.ts'
import { isAbsoluteReference, externalPath } from '../external.ts'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createGitMenuProvider } from './git-provider.ts'
import { createMentionSource } from './source.ts'
import { FilesDock, type AtFileDockInjected, type ReferenceInfoSnapshot } from './FilesDock.tsx'
import {
  AtFileSection,
  type AtFileSectionInjected,
  type AtFileSectionViewState,
} from './SettingsSection.tsx'
import { NS, en, zh } from './locales.ts'
import { adoptStyles } from './styles.ts'
import { MentionNavigator, type MentionNavigatorInjected } from './MentionNavigator.tsx'
import { MenuIcons, type MenuIconsInjected } from './MenuIcons.tsx'
import { DraftLinks, type DraftLinksInjected } from './DraftLinks.tsx'
import {
  FrameCursor,
  FrameReadout,
  type FrameCursorInjected,
  type FrameReadoutInjected,
  type ProjectionFace,
} from './FrameCursor.tsx'
import { createRoamStore } from './roam-store.ts'
import { HistoryPalette, type HistoryPaletteInjected } from './HistoryPalette.tsx'
import { ReferenceLinks, type ReferenceLinksInjected, type ReferenceOutcome } from './ReferenceLinks.tsx'
import { folderAddress, owningFolderOf, sessionFileAddress, type FolderSelectionParams, type ReferenceLink } from './reference-links.ts'
import { draftTokens } from './draft-links.ts'
import { draftScopeOf } from './draft-scope.ts'
import { dirnameOf, referenceKey } from './model.ts'
import { FolderTab, folderTabDefinition, FOLDER_TAB_ID, type FolderTabInjected } from './FolderTab.tsx'
import { FolderPicker, type FolderPickerInjected, type PickerEntry, type PickerListing } from './FolderPicker.tsx'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { MentionAd, type MentionAdProps } from './AdPanel.tsx'
import {
  defaultAtFileSettings,
  ignoreFilesSettingsKey,
  normalizeIgnoreFiles,
  normalizeWorkspaceIgnoreFiles,
  recentFilesFor,
  recordRecentFile,
  recordUsage,
  workspacePathKey,
} from '../defaults.ts'
import { basenameOf, workspaceFromAbsolute } from './model.ts'

/** Required services: picker pipeline, session projection, carrier, Remote face, slots, and locale. */
export const inject = ['inputTriggers', 'sessions', 'connection', 'remote', 'slots', 'locale']

/** The mounted atFile namespace service's callable face. */
interface AtFileNamespaceFace {
  search(sessionId: SessionId, signal?: AbortSignal): Promise<{ ok: true; value: readonly FileEntry[] } | { ok: false; error: { code: string; message: string; details: object } }>
  inspect(sessionId: SessionId, targets: readonly string[], signal?: AbortSignal): Promise<{ ok: true; value: readonly ReferenceInfo[] } | { ok: false; error: { code: string; message: string; details: object } }>
  /** Absent on a host built before the out-of-workspace scope existed. */
  external?(sessionId: SessionId, signal?: AbortSignal): Promise<{ ok: true; value: ExternalAccessScope } | { ok: false; error: { code: string; message: string; details: object } }>
  /** Absent on a host built before the folder browser existed. */
  list?(sessionId: SessionId, path: string, include: string, signal?: AbortSignal): Promise<{ ok: true; value: DirectoryListing } | { ok: false; error: { code: string; message: string; details: object } }>
  /** Absent on a host built before the chooser could answer a half-typed path. */
  browse?(sessionId: SessionId, path: string, signal?: AbortSignal): Promise<{ ok: true; value: BrowseListing } | { ok: false; error: { code: string; message: string; details: object } }>
  /** Absent on a host built before the chooser offered recent folders. */
  recentFolders?(sessionId: SessionId, signal?: AbortSignal): Promise<{ ok: true; value: readonly RecentFolder[] } | { ok: false; error: { code: string; message: string; details: object } }>
  getSettings(): Promise<{ ok: true; value: AtFileSettings } | { ok: false; error: { code: string; message: string; details: object } }>
  updateSettings(update: AtFileSettingsUpdate): Promise<{ ok: true; value: AtFileSettings } | { ok: false; error: { code: string; message: string; details: object } }>
}

/** The mounted atMention namespace service's callable face. */
interface AtMentionNamespaceFace {
  listSkills(sessionId: SessionId, signal?: AbortSignal): Promise<{ ok: true; value: readonly SkillCandidate[] } | { ok: false; error: { code: string; message: string; details: object } }>
  listChats(sessionId: SessionId, query: string, limit: number, signal?: AbortSignal): Promise<{ ok: true; value: readonly ChatCandidate[] } | { ok: false; error: { code: string; message: string; details: object } }>
  listPlugins(signal?: AbortSignal): Promise<{ ok: true; value: readonly PluginCandidate[] } | { ok: false; error: { code: string; message: string; details: object } }>
}

/** The mounted atlas namespace service's callable face (Host half of the @ seam). */
interface AtlasNamespaceFace {
  runtime(signal?: AbortSignal): Promise<{ ok: true; value: AtlasRuntimeInfo } | { ok: false; error: { code: string; message: string; details: object } }>
  gitChanges(agentId: AtlasCallContext['sessionId'], signal?: AbortSignal): Promise<{ ok: true; value: readonly GitChange[] } | { ok: false; error: { code: string; message: string; details: object } }>
}

/** Resolve one mounted namespace service through the reflection store. */
function mountedFace<T>(ctx: ClientContext, name: string): T | undefined {
  return (ctx.reflect as unknown as { get(key: string): unknown }).get(name) as T | undefined
}

/**
 * Read one optional client service off the context.
 *
 * A service this plugin did not declare in `inject` is not readable through the
 * cordis context proxy at all: the read THROWS rather than answering undefined. The
 * right Sidebar is exactly such a service — the `@` picker must work in a profile
 * that mounts no Sidebar — so every optional read goes through here and degrades.
 * @param ctx - client root context.
 * @param name - service key.
 * @returns the service face, or undefined when this profile has none.
 */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  const reflected = mountedFace<T>(ctx, name)
  if (reflected !== undefined) return reflected
  try {
    return (ctx as unknown as Record<string, T | undefined>)[name]
  } catch {
    return undefined
  }
}

/** The one member of the right-Sidebar face this plugin uses. */
interface SidebarRightFace {
  /**
   * Reveal an address in the right Sidebar, optionally carrying one value along.
   *
   * The options are how a tab is told something that is NOT part of its address:
   * re-opening the same address reveals the SAME tab (no second tab) and always
   * delivers the new `params` to it, which is exactly what "open this folder and
   * select this row" needs — the folder is the address, the row is the value.
   */
  openResource(address: string, options?: { readonly params?: FolderSelectionParams }): void
  /** Open a page type by kind (absent on a build without the files tab). */
  openTab?(kind: string): void
}

/** The right Sidebar's tab-type registry, as this plugin registers into it. */
interface SidebarRightTabsFace {
  register(definition: SidebarRightTabDefinition): () => void
}

/** The workspace layer's folder chooser and its create verb, as we call them. */
interface UIWorkspaceFace {
  pickDirectory(): Promise<string | null>
  createDirectory(path: string, name: string): Promise<string>
  /**
   * Select a Session and show its Conversation as one navigation action.
   *
   * Optional because the capability arrived with the Workspace view owner: a
   * client that predates it has no in-app navigation to offer, and the caller
   * reports that as an unreachable reference instead of throwing at the user.
   */
  openSession?(target: SessionId): void
}

/**
 * Read a session id that arrived as a plain string as the branded `SessionId`
 * the ledger and navigation helpers address.
 *
 * The brand is compile-time only — no runtime representation, and the injected
 * slot contract hands inject factories a plain string — so this is the single
 * place where the two spellings meet.
 * @param value - the id as it crossed the slot boundary.
 * @returns the same value, addressed as a SessionId.
 */
const sid = (value: string): SessionId => value as SessionId

/**
 * The crumb strip for one absolute path: each ancestor of the location, outermost
 * first, so the user can jump straight back up to any of them.
 *
 * Built from the PATH rather than taken from a backend: the plugin's own listing
 * reports `parent` (one step) but not the whole ancestry, and a drive root is its
 * own first crumb. Each crumb's `name` is the segment it represents, with the
 * drive root keeping its full spelling so it is recognisable in the strip, and
 * the POSIX root contributing a `/` crumb so it stays reachable.
 * @param path - the canonical absolute path being listed.
 * @returns one entry per ancestor, or `[]` for a path with no ancestors.
 */
export function crumbsOf(path: string): readonly PickerEntry[] {
  const canonical = path.replace(/\/+$/u, '')
  // `E:/a/b` → `['E:', 'a', 'b']`; `/a/b` → `['', 'a', 'b']`. In both shapes
  // `parts[0]` names the TOPMOST place (the drive, or the filesystem root) and
  // every later segment is one level further down, so the walk below treats the
  // two identically and only the root needs telling apart.
  const parts = canonical.split('/')
  // A lone topmost place — `/` or a bare `E:` — has nothing above it, so its strip
  // is empty. On Windows that is right: a drive root's navigation is the drive
  // list. On POSIX `/` is simply the end of the filesystem.
  if (parts.length <= 1) return []
  const crumbs: PickerEntry[] = []
  // A POSIX path splits to a leading empty segment that IS the filesystem root.
  // The Windows-shaped loop this replaced treated every empty segment as "nothing
  // to show" and skipped it, so `/` was the one ancestor missing from the strip: a
  // user who had descended could see where they were but had no way to click back
  // to the root. It is a real place, so it gets a real crumb — named the way the
  // path line spells it, and linked to the root itself.
  if (parts[0] === '') crumbs.push({ name: '/', path: '/', hidden: false })
  // One crumb per segment that names a real directory. `parts[0]` is skipped on
  // Windows because the drive already has the drive list for navigation; on POSIX
  // the root crumb above already covers it. Everything from `parts[1]` down is a
  // genuine ancestor, and the prefix is rebuilt from the raw parts so a POSIX
  // ancestor keeps the leading slash `parts[0]` holds — `/home`, never `home`.
  for (let index = 1; index < parts.length; index += 1) {
    const segment = parts[index] ?? ''
    if (segment === '') continue
    crumbs.push({ name: segment, path: parts.slice(0, index + 1).join('/'), hidden: false })
  }
  return crumbs
}

/** The scoped input machine's event dispatch (span-CAS'd inside the hub). */
interface BailFace {
  bail(subject: unknown, event: string, payload: unknown): boolean
}

/**
 * The right Sidebar's tab registry, or undefined when no Sidebar is mounted.
 * @param ctx - client root context.
 * @returns the registry face, or undefined.
 */
function resolveSidebarTabs(ctx: ClientContext): SidebarRightTabsFace | undefined {
  return optionalService<SidebarRightTabsFace>(ctx, 'sidebarRightTabs')
}

/**
 * The Session Remote namespace's opener, as this plugin calls it.
 *
 * `openWorkspacePath` hands the path to the Host's opener (the OS application
 * or file manager); `action: 'reveal'` is the only alternative mode and is
 * unused here, so omitting it means "open".
 */
interface SessionRemoteFace {
  openWorkspacePath(request: { path: string }): Promise<
    { ok: true; value: unknown } | { ok: false; error: { message: string } }
  >
}

/**
 * The right-Sidebar face, when this client build has one.
 *
 * It is provided through the same reflection store the Remote namespaces use,
 * so the store read comes first; the dotted read stays as the fallback for a
 * build that exposes it as an ordinary service. Absent means the product has no
 * in-app viewer, which the caller answers with the Host opener.
 * @param ctx - client root context.
 * @returns the face, or undefined when no right Sidebar is mounted.
 */
function resolveSidebarRight(ctx: ClientContext): SidebarRightFace | undefined {
  return optionalService<SidebarRightFace>(ctx, 'sidebarRight')
}

/**
 * Compose the @ mention surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-atlas: dictionaries')

  const scope = createSnapshotStore({ value: defaultAtFileSettings() })
  // ONE roaming store per apply, handed to both halves of the feature: the
  // overlay owns the keyboard, the dock draws the readout, and the two are
  // separate React trees. Created here rather than at module scope so a second
  // apply in the same page cannot have them sharing one value.
  const roam = createRoamStore()
  // Reference facts for the dock (existence, kind, size) ride their own store:
  // the dock re-requests them per draft change and reads them through the
  // injected hooks compartment.
  const referenceInfo = createSnapshotStore<ReferenceInfoSnapshot>({ value: [] })

  // The @ data-source seam, client half. We publish `ctx.atlas` so a plugin
  // authorizes us by calling register(); nothing here reaches a provider's data
  // on its own. The running Harness version arrives asynchronously, so the gate
  // reads it lazily — until it lands, every claim stays unverified.
  let atlasRuntime: AtlasRuntimeInfo = {}
  const atlasRegistry = new AtlasRegistry(() => atlasRuntime, { list: true, open: true, resolve: false })
  ctx.provide('atlas', {
    /**
     * Register one provider declaration.
     * @param candidate - the provider's declaration.
     * @returns the disposer that withdraws it.
     */
    register: (candidate: unknown): (() => void) => atlasRegistry.register(candidate),
  })

  const loadAtlasRuntime = async (): Promise<void> => {
    try {
      const atlas = mountedFace<AtlasNamespaceFace>(ctx, 'remote.atlas')
      if (atlas === undefined) return
      const result = await atlas.runtime()
      if (result.ok) atlasRuntime = result.value
    } catch (error) {
      // Unverified is the safe default: never guess the running version.
      console.error('[dsh-atlas] atlas runtime facts unavailable:', error)
    }
  }
  void loadAtlasRuntime()
  const settingsViewState: AtFileSectionViewState = { filterScope: 'global', selectedWorkspace: '' }
  let settingsGeneration = 0
  let settingsTail: Promise<void> = Promise.resolve()

  const reportSettingsError = (
    operation: 'read' | 'update',
    error: { code: string; message: string } | unknown,
  ): void => {
    if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
      const remoteError = error as { code: string; message: string }
      console.error(`[dsh-atlas] settings ${operation} failed: ${remoteError.code}: ${remoteError.message}`)
      return
    }
    console.error(`[dsh-atlas] settings ${operation} failed:`, error)
  }

  // The mounted namespace handles resolve through the service store
  // (`ctx.reflect.get`), not through `ctx.remote.<ns>`: the generated-style
  // dotted read walks the cordis fiber chain, which stops at the Loader's
  // runtime-less internal forks between a plugin entry and the root fiber —
  // the namespace services mounted under the gateway entry are unreachable
  // that way (the store path resolves them by isolation label instead).
  let atFile: AtFileNamespaceFace | undefined
  let atMention: AtMentionNamespaceFace | undefined
  const loadSettings = async (): Promise<void> => {
    const remote = atFile
    if (remote === undefined) return
    const generation = ++settingsGeneration
    try {
      const result = await remote.getSettings()
      if (atFile !== remote || generation !== settingsGeneration) return
      if (!result.ok) {
        reportSettingsError('read', result.error)
        return
      }
      scope.set({ value: result.value })
    } catch (error) {
      if (atFile === remote && generation === settingsGeneration) reportSettingsError('read', error)
    }
  }

  const updateSettings = (update: AtFileSettingsUpdate): Promise<void> => {
    const operation = settingsTail.then(async () => {
      const remote = atFile
      if (remote === undefined) {
        reportSettingsError('update', new Error('the atFile Remote is not mounted'))
        return
      }
      const generation = ++settingsGeneration
      try {
        const result = await remote.updateSettings(update)
        if (atFile !== remote || generation !== settingsGeneration) return
        if (!result.ok) {
          reportSettingsError('update', result.error)
          return
        }
        scope.set({ value: result.value })
      } catch (error) {
        if (atFile === remote && generation === settingsGeneration) reportSettingsError('update', error)
      }
    })
    settingsTail = operation.catch(
      /* v8 ignore next -- every Remote and publication failure is contained inside operation. */
      () => {},
    )
    return operation
  }

  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(AT_REMOTE)
    atFile = mountedFace<AtFileNamespaceFace>(ctx, 'remote.atFile')
    atMention = mountedFace<AtMentionNamespaceFace>(ctx, 'remote.atMention')
    if (atFile === undefined) {
      throw new Error('dsh-atlas: the atFile Remote namespace did not mount')
    }
    await loadSettings()
    // The built-in @git source's menu half: a worked example of a provider that
    // lives in the browser yet answers from Host data. It registers through the
    // same `ctx.atlas.register` a plugin uses. The registration is gated on its
    // own data path: without the `atlas` namespace there is no repository to
    // read, and a category that can never fill is worse than no category.
    const atlas = mountedFace<AtlasNamespaceFace>(ctx, 'remote.atlas')
    const disposeGit = atlas === undefined ? undefined : atlasRegistry.register(createGitMenuProvider({
      changes: async (sessionId, signal) => {
        const result = await atlas.gitChanges(sessionId, signal)
        if (!result.ok) throw new Error(`atlas/gitChanges failed: ${result.error.code}: ${result.error.message}`)
        return result.value
      },
      // A committed `@atlas:git/<path>` mention opens that file: the provider
      // says so, and this is the file action the menu already performs. Its
      // outcome travels back so a vanished path marks the mention stale.
      open: (sessionId, path) => actionFor(sessionId, { kind: 'file', path })?.(),
    }))
    return () => {
      settingsGeneration += 1
      atFile = undefined
      atMention = undefined
      disposeGit?.()
      void dispose()
    }
  }, 'dsh-atlas: remote')

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as unknown as ISessions
  const t = ctx.locale.bind(NS)

  // Relative → entry map backing the dock's open action (resolves a draft
  // token to its absolute path from the last settled index).
  const entryByRel = new Map<string, FileEntry>()

  /**
   * Resolve a BARE `@label` to the one session it names.
   *
   * A session mention is folded to a bare label before it is durable (the host's
   * `parseSessionReferenceText` does it), and the composer keeps the wire form as
   * plain text, so the label is often all that is left. Two answers only:
   * a label that IS a listed session id, or a label that equals exactly ONE
   * session's display title. Anything else answers undefined, because a name that
   * also exists as a workspace path (`@AGENTS.md`) must stay the file reference
   * the user wrote — the plugin never turns a path into a jump on a guess.
   */
  const resolveSessionLabel = (label: string): string | undefined => {
    const snapshot = sessions.list.getSnapshot()
    const ids = snapshot.ids
    if ((ids as readonly string[]).includes(label)) return label
    const hits = ids.filter(id => snapshot.byId[id]?.displayTitle === label)
    // `SessionId` is a branded string with no runtime brand, so the id the wire
    // names is the same value the list is keyed by.
    return hits.length === 1 ? String(hits[0]) : undefined
  }

  /**
   * Switch the current session to one a mention names.
   *
   * This is main-area navigation, not a resource the Sidebar can show, so it
   * reuses the service the sidebar's own rows use — the selection, its routing,
   * and its persistence all follow. A session that is no longer listed fails
   * loud inside `select()`; that is reported as a vanished reference rather than
   * thrown at the user.
   */
  const openSession = (sessionId: string): ReferenceOutcome => {
    try {
      // Selection and routing are the Workspace view owner's business in this
      // client: the Session controller retains a generation, and
      // `uiWorkspace.openSession` is the one action that selects the Session,
      // shows its Conversation, and persists the choice. A client that still
      // carries the old controller-level `open` is honoured second so older
      // profiles keep working; a build with neither reports a vanished
      // reference rather than throwing at the user.
      const navigation = optionalService<UIWorkspaceFace>(ctx, 'uiWorkspace')
      if (navigation?.openSession !== undefined) {
        navigation.openSession(sid(sessionId))
        return 'opened'
      }
      const legacy = (sessions as unknown as { open?: (target: SessionId) => void }).open
      if (legacy !== undefined) {
        legacy.call(sessions, sid(sessionId))
        return 'opened'
      }
      console.warn(`[dsh-atlas] this client has no session navigation to open "${sessionId}" with`)
      return 'gone'
    } catch (error) {
      console.warn(`[dsh-atlas] this session reference could not be opened: ${sessionId}`, error)
      return 'gone'
    }
  }
  /**
   * Host verdicts for the draft's scope tokens, keyed `sessionId\0path`. Bounded
   * because it only ever holds the handful of paths a user types a scope from.
   */
  const scopeVerdicts = new Map<string, boolean>()
  const SCOPE_VERDICT_CACHE = 50
  const search = async (sessionId: SessionId, signal: AbortSignal): Promise<readonly FileEntry[]> => {
    if (atFile === undefined) throw new Error('dsh-atlas: the atFile Remote is not mounted')
    const result = await atFile.search(sessionId, signal)
    if (!result.ok) throw new Error(`search failed: ${result.error.code}: ${result.error.message}`)
    for (const entry of result.value) entryByRel.set(entry.relative, entry)
    return result.value
  }

  /**
   * The Host's out-of-workspace scope for one session (whether external paths
   * may be discovered at all, plus the folder rows to offer). A host built
   * before this endpoint answers with the narrow verdict, so an older host can
   * never widen anything.
   */
  const external = async (sessionId: SessionId, signal: AbortSignal): Promise<ExternalAccessScope> => {
    if (atFile?.external === undefined) return { canDiscover: false, roots: [], folders: [] }
    const result = await atFile.external(sessionId, signal)
    if (!result.ok) throw new Error(`external failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  const listDirectory = async (
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
    include = '',
  ): Promise<DirectoryListing> => {
    // A host built before the folder browser has no such member: the tab then says
    // so instead of showing an empty folder, which would be a lie.
    if (atFile?.list === undefined) throw new Error('dsh-atlas: this host cannot list directories')
    const result = await atFile.list(sessionId, path, include, signal)
    if (!result.ok) throw new Error(`list failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  /**
   * The chooser's listing call, which answers a half-typed path instead of an error.
   *
   * A host older than `browse` still has `list`, and the chooser degrades to it: the
   * filter then has nothing to filter against, which is a smaller loss than a dialog
   * that refuses to open. That is also why the fallback is here and not in the
   * component — the component cannot tell an old host from a broken one.
   */
  const browseDirectory = async (sessionId: SessionId, path: string, signal: AbortSignal): Promise<BrowseListing> => {
    if (atFile?.browse === undefined) return { ...await listDirectory(sessionId, path, signal) }
    const result = await atFile.browse(sessionId, path, signal)
    if (!result.ok) throw new Error(`browse failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  /**
   * The folders worth offering before the chooser browses anywhere.
   *
   * Deliberately NOT fatal when the host is older or the ledger is unreadable: an
   * empty preset list is a legitimate state the chooser already renders, whereas
   * throwing here would take the whole dialog down over a convenience.
   */
  const recentFolders = async (sessionId: SessionId, signal: AbortSignal): Promise<readonly RecentFolder[]> => {
    if (atFile?.recentFolders === undefined) return []
    const result = await atFile.recentFolders(sid(sessionId), signal)
    return result.ok ? result.value : []
  }

  /**
   * Reshape this plugin's directory listing into the chooser's own shape.
   *
   * Two differences matter. First, `atFile.list` reports FILES as well as folders
   * (the Sidebar's folder tab shows both), while a folder chooser must not offer a
   * row that cannot be chosen — so files are dropped here rather than rendered and
   * refused. Second, the plugin's listing spells "the way up" as `parent` and a
   * drive root as `drives`, both of which the chooser needs verbatim; `home` and
   * `crumbs` are not part of the plugin's contract, so the chooser's crumb strip is
   * built from the path itself.
   */
  const toPickerListing = (listing: BrowseListing): PickerListing => ({
    path: listing.path,
    home: '',
    crumbs: crumbsOf(listing.path),
    entries: listing.entries
      .filter(entry => entry.kind === 'dir')
      .map(entry => ({
        name: entry.name,
        path: `${listing.path}/${entry.name}`,
        hidden: entry.name.startsWith('.'),
        ...(entry.hasChildren === undefined ? {} : { hasChildren: entry.hasChildren }),
      })),
    truncated: listing.truncated === true,
    ...(listing.requested === undefined ? {} : { requested: listing.requested }),
    ...(listing.drives === undefined ? {} : { drives: listing.drives }),
    ...(listing.parent === undefined ? {} : { parent: listing.parent }),
    ...(listing.error === undefined ? {} : { error: listing.error }),
  })

  /**
   * Open the product's own folder chooser (the dialog "add workspace" uses) and
   * insert the picked folder as a reference where the token was.
   *
   * The chooser is asynchronous and the framework's pick path is synchronous, so
   * this takes over the insertion: the span rides the input machine's own
   * `slash/input-insert-text` request (span-CAS'd, so a draft the user edited
   * while the dialog was open refuses the write instead of corrupting it), and the
   * token is replaced exactly as a returned outcome would have replaced it.
   * @param sessionId - the session whose composer owns the token.
   * @param span - the trigger span the menu reported.
   * @returns whether a chooser exists and took over.
   */
  const chooseFolder = (sessionId: SessionId, span: TokenSpan): boolean => {
    const workspace = optionalService<UIWorkspaceFace>(ctx, 'uiWorkspace')
    const actx = sessions.scope(sid(sessionId))
    if (workspace === undefined || actx === undefined) return false
    const bail = actx as unknown as BailFace
    /** Replace the token with one folder mention (the same write a returned outcome makes). */
    const insert = (path: string): void => {
      const text = `@${externalPath(path).replace(/[/\\]+$/u, '')}/ `
      bail.bail(actx, 'slash/input-insert-text', { text, span, continue: true })
    }
    const openOwnDialog = (error?: unknown): void => {
      if (error !== undefined) {
        // The product's native chooser is capability-gated: a profile whose picker
        // serves the in-app BROWSER capability answers `directory-picker/unavailable`,
        // and the product's own dialog is a private child slot of the workspace
        // picker, which a plugin can neither declare nor render. Our own dialog over
        // the SAME browse backend is then the chooser.
        console.warn('[dsh-atlas] the native folder chooser is unavailable here; opening this plugin\'s own:', error)
      }
      folderPicker.set({ value: { span } })
    }
    if (workspace.pickDirectory === undefined) {
      openOwnDialog()
      return true
    }
    void Promise.resolve()
      .then(() => workspace.pickDirectory())
      .then((picked) => {
        if (picked !== null && picked !== undefined && picked !== '') insert(picked)
      })
      .catch((error: unknown) => { openOwnDialog(error) })
    return true
  }

  /**
   * Adopt one folder the dialog confirmed: replace the reported token span with
   * `@<path>/` through the input machine's own span-CAS'd request, then close.
   */
  const adoptPickedFolder = (sessionId: SessionId, path: string): void => {
    const pending = folderPicker.getSnapshot().value as { span: TokenSpan } | null
    folderPicker.set({ value: null })
    const actx = sessions.scope(sid(sessionId))
    if (pending === null || actx === undefined) return
    const text = `@${externalPath(path).replace(/[/\\]+$/u, '')}/ `
    ;(actx as unknown as BailFace).bail(actx, 'slash/input-insert-text', { text, span: pending.span, continue: true })
  }

  const inspectReferences = async (sessionId: SessionId, targets: readonly string[]): Promise<readonly ReferenceInfo[]> => {
    // A host built before this endpoint simply has no such member; the dock then
    // shows no cost badges instead of failing.
    if (atFile === undefined || typeof atFile.inspect !== 'function') return []
    const result = await atFile.inspect(sessionId, targets)
    if (!result.ok) throw new Error(`inspect failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  // Monotonic revision: a slow response must never overwrite a newer one.
  let inspectRev = 0
  const requestInspect = (sessionId: SessionId, targets: readonly string[]): void => {
    const rev = ++inspectRev
    if (targets.length === 0) {
      referenceInfo.set({ value: [] })
      return
    }
    void inspectReferences(sessionId, targets).then(
      infos => { if (rev === inspectRev) referenceInfo.set({ value: infos }) },
      (error: unknown) => { console.error('[dsh-atlas] reference inspection failed:', error) },
    )
  }

  const listSkills = async (sessionId: SessionId, signal: AbortSignal): Promise<readonly SkillCandidate[]> => {
    if (!scope.getSnapshot().value.enableSkills) return []
    if (atMention === undefined) return []
    const result = await atMention.listSkills(sessionId, signal)
    if (!result.ok) throw new Error(`listSkills failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  const listChats = async (sessionId: SessionId, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]> => {
    if (!scope.getSnapshot().value.enableChats) return []
    if (atMention === undefined) return []
    const result = await atMention.listChats(sessionId, query, limit, signal)
    if (!result.ok) throw new Error(`listChats failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  const listPlugins = async (signal: AbortSignal): Promise<readonly PluginCandidate[]> => {
    if (!scope.getSnapshot().value.enablePlugins) return []
    if (atMention === undefined) return []
    const result = await atMention.listPlugins(signal)
    if (!result.ok) throw new Error(`listPlugins failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  // Recently referenced files: durable per-workspace history (most recent
  // first), recorded on file picks and read back for the @file: initial view.
  const onRecent = (sessionId: SessionId, relative: string): void => {
    const entry = entryByRel.get(relative)
    if (entry === undefined) return
    const workspace = workspaceFromAbsolute(entry.path, relative)
    const current = scope.getSnapshot().value
    void updateSettings({ field: 'recentFiles', value: recordRecentFile(current, workspace, relative) })
  }
  const recentFiles = (sessionId: SessionId, workspace: string): readonly string[] =>
    recentFilesFor(scope.getSnapshot().value, workspace)

  // Cross-category pick counters feed the menu's "most used" section. The key
  // is `${mentionKind}:${value}`, so every category — including ones added
  // later — counts through this one path. `sessionId` is unused: the counters
  // are plugin-global, not per session.
  const onUsage = (_sessionId: SessionId, kind: string, value: string): void => {
    const current = scope.getSnapshot().value
    void updateSettings({ field: 'usage', value: recordUsage(current, `${kind}:${value}`) })
  }

  /**
   * The folder the composer's draft is currently SCOPED by (内部需求 R-05): the
   * nearest folder reference typed before the active category token, so
   * `@e:/work/docs/ @file:` lists that folder's files. The scope is positional, which
   * is why no connective word is needed.
   *
   * The composer is the only place this fact exists — the input machine hands a
   * source the live query and nothing about what precedes it — so the tokens come
   * from the same DOM reader the draft bridge uses, and the folder verdict for a
   * token without a trailing separator comes from the Host. That verdict is
   * memoised: `candidates` runs on every keystroke, and a path's kind does not
   * change while the user is typing the next token.
   * @param sessionId - the session whose composer is being read.
   * @returns the scoping folder path, or undefined when the draft names none.
   */
  const scopeFolder = async (sessionId: SessionId): Promise<string | undefined> => {
    if (typeof document === 'undefined') return undefined
    const tokens = draftTokens().map(token => token.token)
    if (tokens.length === 0) return undefined
    return draftScopeOf(tokens, {
      async isFolder(path: string): Promise<boolean> {
        const key = `${sessionId}\u0000${path}`
        const cached = scopeVerdicts.get(key)
        if (cached !== undefined) return cached
        if (atFile === undefined || typeof atFile.inspect !== 'function') return false
        const result = await atFile.inspect(sessionId, [path])
        if (!result.ok) return false
        const verdict = result.value.find(info => referenceKey(info.relative) === referenceKey(path))
        const isFolder = verdict?.kind === 'dir'
        if (scopeVerdicts.size >= SCOPE_VERDICT_CACHE) scopeVerdicts.delete(scopeVerdicts.keys().next().value as string)
        scopeVerdicts.set(key, isFolder)
        return isFolder
      },
    })
  }

  const mention = createMentionSource({
    search,
    listSkills,
    listChats,
    listPlugins,
    external,
    list: listDirectory,
    scopeFolder,
    chooseFolder,
    t: t as (key: string, params?: Record<string, string>) => string,
    onRecent,
    recentFiles,
    onUsage,
    usage: () => scope.getSnapshot().value.usage ?? [],
    atlasProviders: () => atlasRegistry.entries(),
    // A client that activates a reference token in the composer opens it through
    // the same action the sent-message bridge runs.
    actionFor: (sessionId, link) => actionFor(sessionId, link),
  })
  const { source, invalidateAll } = mention
  // Reconnect may have rebuilt the host: cached indexes and path maps die with it.
  ctx.on('connection/reset', () => {
    invalidateAll()
    entryByRel.clear()
    void loadSettings()
  })
  // The settings switch gates the picker live. The schema default applies
  // until the first Host read, then every returned update replaces the snapshot.
  let sourceRegistered = false
  /* v8 ignore next -- replaced before use whenever a source is registered. */
  let sourceDispose = (): void => {}
  let ignoreFilesKey: string | undefined
  const syncSource = (): void => {
    const value = scope.getSnapshot().value
    const enabled = value.enabled
    const nextIgnoreFilesKey = ignoreFilesSettingsKey(value)
    if (ignoreFilesKey !== undefined && ignoreFilesKey !== nextIgnoreFilesKey) {
      invalidateAll()
      entryByRel.clear()
    }
    ignoreFilesKey = nextIgnoreFilesKey
    if (enabled && !sourceRegistered) {
      sourceDispose = inputTriggers.registerSource(source)
      sourceRegistered = true
    } else if (!enabled && sourceRegistered) {
      sourceDispose()
      /* v8 ignore next -- keeps teardown callable after the live registration is removed. */
      sourceDispose = () => {}
      sourceRegistered = false
    }
  }
  ctx.effect(() => {
    syncSource()
    const off = scope.subscribe(syncSource)
    return () => {
      off()
      sourceDispose()
    }
  }, 'dsh-atlas: source (settings-gated)')

  // The Session Remote's openWorkspacePath is the Host opener in the current
  // contract; the old `connection.api.host.openPath` face no longer exists.
  // Omitting `action` means "open" (the Host only special-cases 'reveal').
  //
  // The namespace is read through the service store, NOT as `ctx.remote.session`:
  // the dotted read is a cordis service access and throws "cannot get property
  // \"remote.session\" without inject" — verified live in the browser, where it
  // broke this very button. The store read is the same one the other Remote
  // namespaces use, and it needs no inject declaration.
  const openPath = (path: string): void => {
    const remote = mountedFace<SessionRemoteFace>(ctx, 'remote.session')
    if (remote === undefined) {
      console.error('[dsh-atlas] open failed: the session Remote namespace is not mounted')
      return
    }
    void remote.openWorkspacePath({ path }).then((response) => {
      if (!response.ok) console.error('[dsh-atlas] open failed:', response.error.message)
    }, (error: unknown) => {
      console.error('[dsh-atlas] open failed:', error)
    })
  }

  const openRelative = (relative: string): void => {
    const entry = entryByRel.get(relative)
    if (entry === undefined) {
      console.error('[dsh-atlas] open failed: no index entry for', relative)
      return
    }
    openPath(entry.path)
  }

  // An out-of-workspace reference carries an ABSOLUTE path (`E:/…`, `/…`, or a
  // UNC `//server/share`): it must reach the Host and the sidebar as such, while a
  // workspace reference is relative and is resolved for the sidebar through the
  // index. `isAbsoluteReference` (src/external.ts) is the single copy of that test,
  // and `absoluteReferenceOf` is the single place that turns a relative reference
  // into an absolute path for an interface that takes nothing else.

  /**
   * Resolve one composer chip's label to a workspace-relative path.
   *
   * A chip another source inserted carries only its display label in the DOM,
   * and the sidebar plugin labels a chip with the file's BASENAME while the
   * draft serializes the full relative path. A label that already carries a
   * separator is a path and is handed back as it is; a bare name is looked up in
   * the index the menu already fetched.
   *
   * A name the index cannot place is handed back unchanged — the click's own
   * existence check then decides, exactly as it does for a sent chip — but a
   * name that TWO different indexed paths answer to is `undefined`: the label
   * alone cannot say which file is meant, and an unplaced chip stays inert
   * rather than opening the wrong one (the bridge then asks the draft, which
   * keeps the full mention).
   * @param label - the chip's visible label.
   * @returns the workspace-relative path, the label unchanged, or undefined when it is ambiguous.
   */
  const resolveChipLabel = (label: string): string | undefined => {
    if (/[\\/]/u.test(label)) return label
    let match: string | undefined
    for (const relative of entryByRel.keys()) {
      if (basenameOf(relative) !== label) continue
      if (match !== undefined && match !== relative) return undefined
      match = relative
    }
    return match ?? label
  }

  /**
   * The object each session's LAST click opened, by reference key.
   *
   * "Click a reference twice" cannot be told from the click event: a browser
   * reports a double click only through `detail`, which the OS synthesizes from
   * the double-click interval the platform chose, and a slow second click is
   * indistinguishable from a first one. The user's own ruling (`m02489`: the
   * feature "must not rely on a fast double click") turns that into the design:
   * the plugin keeps its own ledger instead. There is no time limit — what counts
   * is the ORDER of clicks on one object, not how fast they came — so a slow
   * second click behaves exactly like a fast one.
   *
   * The key is the same reference identity the rest of the plugin compares with
   * ({@link referenceKey}: separators normalized, trailing ones dropped), so a
   * differently-spelled mention of one file is still "the same object", while two
   * objects that merely sit in the same place are not. The ledger is per session
   * and knows no surface: the chip in the transcript and the row in the dock are
   * the same object, and clicking either continues the same sequence.
   *
   * A tracked object is one that HAS a folder: only a file and a folder. A skill,
   * a session and a provider item have no owning directory, so they are never
   * recorded and never answer as a repeat — their second click is their first.
   */
  const lastClick = new Map<SessionId, string>()

  /**
   * The ledger key of one mention, or undefined when it cannot own a folder.
   * @param link - the decoded mention.
   * @returns the identity to remember, or undefined.
   */
  const ledgerKeyOf = (link: ReferenceLink): string | undefined =>
    link.kind === 'file' || link.kind === 'folder' ? referenceKey(link.path) : undefined

  /**
   * Whether the previous click on this session opened exactly this object.
   * @param sessionId - the session whose transcript was clicked.
   * @param link - the decoded mention.
   * @returns true when this click continues a pair rather than starting one.
   */
  const repeatClick = (sessionId: SessionId, link: ReferenceLink): boolean => {
    const key = ledgerKeyOf(link)
    return key !== undefined && lastClick.get(sessionId) === key
  }

  /**
   * Record that a click opened this object.
   *
   * The write FLIPS: recording the object already recorded clears the entry, so
   * the click after a completed pair starts over as a first click. Both of an
   * object's behaviours therefore stay reachable by clicking alone, instead of
   * the second one becoming a state the user cannot leave.
   * @param sessionId - the session whose transcript was clicked.
   * @param link - the decoded mention.
   */
  const noteClick = (sessionId: SessionId, link: ReferenceLink): void => {
    const key = ledgerKeyOf(link)
    if (key === undefined) return
    if (lastClick.get(sessionId) === key) lastClick.delete(sessionId)
    else lastClick.set(sessionId, key)
  }

  /**
   * The action a click on one mention performs, or undefined when this build
   * has none.
   *
   * A file mention lands in the right Sidebar under this session's file address
   * — the same target the framework uses when it wires the chip itself; a build
   * without that column falls back to the Host opener. A folder mention opens in
   * that same Sidebar, at its own row, so that a click puts the user inside the
   * folder rather than at the top of the workspace (m05904). A skill
   * mention routes to the skill source's own opener (the framework's `openSkill`
   * gesture). A provider mention is the provider's to open: only its declared
   * `open` says what the item means, and a provider without one leaves the chip
   * inert rather than guessed at.
   * @param sessionId - the session whose transcript was clicked.
   * @param link - the decoded mention.
   * @param again - true for the SECOND click on this object: on a FILE, open the
   * folder it lives in with the object selected there; on a FOLDER, open that
   * folder in the desktop's own file manager.
   * @returns the click action, or undefined when nothing can be opened.
   */
  const actionFor = (sessionId: SessionId, link: ReferenceLink, again = false): (() => ReferenceOutcome | Promise<ReferenceOutcome>) | undefined => {
    if (link.kind === 'folder') {
      // A folder's two clicks answer two different questions: the first shows the
      // folder's CONTENT in the right Sidebar (see openReferenceTarget), the second
      // hands the folder to the desktop's own file manager. Both were wrong before
      // m05904: the first opened the product's param-less files tab, which could
      // never select the folder, and the second re-opened this plugin's own tab
      // instead of the OS window the user asked for.
      return again
        ? () => openNativeFolder(sessionId, link.path)
        : () => openReferenceTarget(sessionId, link)
    }
    if (link.kind === 'file') {
      return again ? () => openOwningFolder(sessionId, link) : () => openReferenceTarget(sessionId, link)
    }
    if (link.kind === 'skill') {
      const actx = sessions.scope(sid(sessionId))
      if (actx === undefined) return undefined
      return () => {
        inputTriggers.sessionOf(actx).openReference('skill', { ref: `/${link.name}` })
        return 'opened'
      }
    }
    if (link.kind === 'session') {
      // Only the wire form names its session outright; a bare label never gets
      // here (the draft resolves one through `resolveSessionLabel` first, and a
      // sent bubble does not promote labels at all).
      return () => openSession(link.sessionId)
    }
    if (link.kind === 'atlas') {
      const open = atlasRegistry.get(link.provider)?.provider.open
      if (open === undefined) return undefined
      return async () => {
        try {
          // The click has no supersession of its own, so the signal never fires.
          const outcome = await open(link.item, { sessionId, signal: new AbortController().signal })
          return outcome === 'gone' ? 'gone' : 'opened'
        } catch (error) {
          console.error(`[dsh-atlas] atlas provider "${link.provider}" open failed:`, error)
          return 'opened'
        }
      }
    }
    /* v8 ignore next -- the union above is exhaustive; this keeps the switch total. */
    return undefined
  }

  /**
   * Open one file or folder reference, but only while its target still exists.
   *
   * A reference outlives the file it names — the user can delete, move or rename
   * it long after the mention was sent. Handing a vanished target to the product
   * is worse than doing nothing: the right Sidebar is a plugin surface (in this
   * profile a third-party one), and its path canonicalizer answers a missing
   * write target with a thrown 400 (`cannot resolve target "…"`, ENOENT) that the
   * user sees as an error. So the target is confirmed first through the plugin's
   * own read-only inspection; a target the Host reports as gone is left alone and
   * reported as such — the chip then reads stale, which is a normal state, not a
   * failure — while an unavailable inspection (an older Host) still opens.
   * @param sessionId - the session the mention belongs to.
   * @param link - the file or folder mention.
   * @returns what the click was able to do.
   */
  const openReferenceTarget = async (sessionId: SessionId, link: ReferenceLink & { kind: 'file' | 'folder' }): Promise<ReferenceOutcome> => {
    try {
      const infos = await inspectReferences(sessionId, [link.path])
      if (infos[0]?.exists === false) {
        // Not an error: the reference simply outlived its target. The bridge
        // marks the chip stale, so this stays a quiet, actionable line.
        console.warn(`[dsh-atlas] this reference no longer exists, so it was not opened: ${link.path}`)
        return 'gone'
      }
    } catch (error) {
      // Inspection is a courtesy, not a gate: if it cannot answer, open anyway.
      console.error('[dsh-atlas] reference check failed:', error)
    }
    if (link.kind === 'folder') {
      // A folder's FIRST click opens it in the right Sidebar with its own row
      // revealed — the same reveal a second click on a FILE performs — so the tree
      // roots at the folder's parent and the user lands on the folder itself. The
      // local (OS) open that used to ride along with this click is still pinned off
      // by the user (A.16.7); the desktop file manager is now the SECOND click
      // instead (m05904, see actionFor), which is why it is not reached here except
      // as the fallback below.
      //
      // The product's own files tab is deliberately NOT used any more. It cannot be
      // told WHICH folder to show — `ui-sidebar-files` declares no params and no
      // reveal API — so it could only ever open at the workspace root, which is
      // exactly the "clicked a folder and nothing happened" defect, and a folder
      // outside the workspace has no files page at all.
      if (resolveSidebarRight(ctx) !== undefined) return openOwningFolder(sessionId, link)
      // A profile with no right Sidebar has no second surface to suppress, and `@`
      // is documented to keep working there, so a click that could open nothing at
      // all would be the worse bug.
      return openNativeFolder(sessionId, link.path)
    }
    const sidebar = resolveSidebarRight(ctx)
    if (sidebar !== undefined) {
      try {
        sidebar.openResource(sessionFileAddress(sessionId, link.path))
        return 'opened'
      } catch (error) {
        // A build whose Sidebar claims no such address must still open the file
        // somehow, so this is a fall-through rather than a dead end.
        console.error('[dsh-atlas] sidebar open failed:', error)
      }
    }
    openRelative(link.path)
    return 'opened'
  }

  /**
   * The session's own workspace root, as the Session list records it.
   *
   * {@link workspaceRootFromIndex} can only answer once a file has been indexed,
   * and a folder never enters that index at all; the Session summary carries the
   * directory the Host launched the session in, which is the root every relative
   * reference in this transcript is written against. This is a plain snapshot read
   * rather than a subscription: a click needs the value now, and nothing renders
   * from it.
   * @param sessionId - the session the reference belongs to.
   * @returns the root in forward-slash spelling with no trailing separator, or
   * undefined when the session has no directory of its own.
   */
  const sessionWorkspaceRoot = (sessionId: SessionId): string | undefined => {
    const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
    return cwd === undefined || cwd === '' ? undefined : cwd.replace(/[/\\]+$/u, '')
  }

  /**
   * The absolute path a reference names, for an interface that accepts only that.
   *
   * The Host opener resolves nothing: `session.openWorkspacePath` is documented as
   * receiving its path "after best-effort Session workspace resolution", and it
   * hands the string it is given straight to the desktop. A relative reference
   * therefore has to be joined onto the workspace root here.
   * @param sessionId - the session the reference belongs to.
   * @param path - the reference path, either separator spelling.
   * @returns the absolute path, or undefined when no root is known.
   */
  const absoluteReferenceOf = (sessionId: SessionId, path: string): string | undefined => {
    if (isAbsoluteReference(path)) return path
    const root = sessionWorkspaceRoot(sessionId)
    return root === undefined ? undefined : `${root}/${path.replace(/^[/\\]+/u, '')}`
  }

  /**
   * The absolute directory a folder reference names, resolved by the HOST.
   *
   * The opener resolves nothing, and this side is not the authority on where the
   * workspace begins: the Session summary {@link absoluteReferenceOf} reads is a
   * snapshot that may carry no directory at all, and the folder a second click has
   * to name is the folder the FIRST click just showed — which the Host placed. So
   * the reference goes through the Host's own listing: `atFile/list` resolves a
   * relative path against the session header's directory (the same resolution the
   * folder tab went through to render) and answers the canonical spelling of the
   * directory it was asked about even when that directory is missing or refused, so
   * one listing call is a complete answer. That is deliberately the call the tab
   * itself lists through, which is what makes a second click hand the opener the
   * same absolute path the tab's own "open in system" button (`folder.system`)
   * opens (m02155).
   * @param sessionId - the session the reference belongs to.
   * @param path - the reference path, either separator spelling.
   * @returns the canonical absolute path, or undefined when neither the Host nor the
   * Session summary can place it.
   */
  const hostResolvedFolder = async (sessionId: SessionId, path: string): Promise<string | undefined> => {
    try {
      return (await listDirectory(sessionId, path, new AbortController().signal)).path
    } catch {
      // A Host without the folder browser (or one whose at-file layer is switched
      // off) cannot answer, and the older summary join is then the only spelling
      // available. It is the weaker answer, not a refused gesture.
      return absoluteReferenceOf(sessionId, path)
    }
  }

  /**
   * Open one folder in the desktop's own file manager — a folder's second click.
   *
   * The plain open, not the `reveal` mode: reveal means "select this inside its
   * parent", which for a folder would open the parent directory and highlight the
   * folder, when what the user asked for was to be taken INTO the folder.
   * @param sessionId - the session the reference belongs to.
   * @param path - the reference path, either separator spelling.
   * @returns what the click was able to do.
   */
  const openNativeFolder = async (sessionId: SessionId, path: string): Promise<ReferenceOutcome> => {
    const absolute = await hostResolvedFolder(sessionId, path)
    if (absolute === undefined) {
      console.warn(`[dsh-atlas] this folder has no absolute path to open: ${path}`)
      return 'gone'
    }
    openPath(absolute)
    return 'opened'
  }

  /**
   * The workspace root the index implies, for an object whose owning folder is
   * the top of the relative path space.
   *
   * `''` from {@link owningFolderOf} means "no directory part of its own", and that
   * is NOT necessarily the workspace in a folder address: the Host's `list('')`
   * starts at its browse root, which is the top of the file system whenever the
   * session may read outside the workspace. So the root has to come from the paths
   * the index already holds — an entry's `path` is that entry's `relative` spelled
   * from the workspace root, so subtracting the suffix leaves the root. Any entry
   * answers, because one session's index has one root.
   * @returns the canonical workspace root, or undefined with an empty index.
   */
  const workspaceRootFromIndex = (): string | undefined => {
    for (const entry of entryByRel.values()) {
      const normalized = entry.path.replaceAll('\\', '/')
      const root = workspaceFromAbsolute(entry.path, entry.relative)
      if (root !== normalized) return root
    }
    return undefined
  }

  /**
   * The directory a folder tab can actually be opened at.
   *
   * A mention spells a path the way the user typed it, while a folder tab is
   * opened by a path the Host can list, so a relative mention has to be turned
   * into the absolute path the workspace index already knows — and the index holds
   * files, so a relative FOLDER may not be in it at all. That case is left relative
   * on purpose: the Host resolves a relative listing path against the session's
   * working directory ({@link listDirectory} → `atFile.list`), so
   * `dsh-resource://folder/<relative>` lists the same folder either way.
   * @param path - the clicked reference's own path.
   * @param dir - the owning directory {@link owningFolderOf} answered with.
   * @returns the path to name in the folder address.
   */
  const resolveOwningDir = (path: string, dir: string): string => {
    if (isAbsoluteReference(dir)) return dir
    const entry = entryByRel.get(dir === '' ? path : dir)
    if (entry !== undefined) {
      // A top-of-workspace name has no directory part of its own, so the owning
      // folder is the object's OWN parent — which is exactly what the index entry
      // is there for.
      return dir === '' ? dirnameOf(entry.path.replaceAll('\\', '/')) : entry.path
    }
    // No entry: a top-level FOLDER is never in an index that holds files only, and
    // there `''` would land on the Host's browse root instead of the workspace.
    return dir === '' ? workspaceRootFromIndex() ?? dir : dir
  }

  /**
   * Open the folder a reference lives in, with the reference itself selected there.
   *
   * Two gestures share this reveal: the FIRST click on a folder (the tree roots at
   * the folder's parent and the folder row is the selected one, so the user lands
   * inside the folder — m05904), and the SECOND click on a file (the file's own
   * folder opens with that file selected). The user's ruling (`m02489`) is that the
   * second click must not depend on a fast double click, so nothing here looks at
   * click timing or at `detail` — the caller has already decided, through the
   * ledger, that this click continues a pair. The folder goes through this plugin's
   * own `folder` tab rather than the product's files page because that page claims
   * no address at all: it cannot be told WHICH folder to reveal, let alone which row
   * to select, and an out-of-workspace folder has no files page to begin with.
   *
   * There is deliberately NO existence check here: a reference whose file is gone
   * still has an owning folder (A.16.5), and that folder is where the user would
   * go looking for it.
   * @param sessionId - the session whose transcript was clicked.
   * @param link - the decoded mention.
   * @returns the outcome, which only decides the chip's own styling.
   */
  const openOwningFolder = async (sessionId: SessionId, link: ReferenceLink & { kind: 'file' | 'folder' }): Promise<ReferenceOutcome> => {
    const { dir, select } = owningFolderOf(link.path)
    const sidebar = resolveSidebarRight(ctx)
    // With no right Sidebar a file still has the OS opener through the reference
    // path, and a folder's own arm sends it to the file manager; that arm is what
    // stops this from being a mutual recursion between the two functions.
    if (sidebar === undefined) return openReferenceTarget(sessionId, link)
    try {
      sidebar.openResource(folderAddress(resolveOwningDir(link.path, dir)), { params: { select } })
      return 'opened'
    } catch (error) {
      // The address may be one this build's tab type does not claim. Opening the
      // reference itself is what the FIRST click does, and a click that still
      // opens something beats a click that does nothing.
      console.error('[dsh-atlas] sidebar folder open failed:', error)
      return openReferenceTarget(sessionId, link)
    }
  }

  /**
   * One click on a reference, ledger included — the dock's way in.
   *
   * The dock has no selection to guard against (that guard lives in the chip
   * bridge), so it runs the whole sequence here: read the ledger, ask for the
   * action, then record. Recording happens only when there IS an action, so an
   * inert reference never advances the sequence.
   * @param sessionId - the session the dock belongs to.
   * @param link - the decoded mention.
   * @returns the action to run, or undefined when nothing can be opened.
   */
  const clickReference = (sessionId: SessionId, link: ReferenceLink): (() => ReferenceOutcome | Promise<ReferenceOutcome>) | undefined => {
    const again = repeatClick(sid(sessionId), link)
    const action = actionFor(sid(sessionId), link, again)
    if (action === undefined) return undefined
    noteClick(sid(sessionId), link)
    return action
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'atlas',
    order: 20,
    locale: NS,
    inject: (sessionId): AtFileDockInjected => ({
      // The dock opens through the same action the sent-message chips use, so a
      // referenced file behaves identically wherever it is clicked — including the
      // second click, which is why it goes through the ledger too.
      onOpen: link => { clickReference(sid(sessionId), link)?.() },
      requestInspect: targets => { requestInspect(sid(sessionId), targets) },
      hooks: { scope, referenceInfo },
    }),
  }, FilesDock))

  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-mention-navigation',
    order: 2,
    inject: (sessionId): MentionNavigatorInjected => {
      const actx = sessions.scope(sid(sessionId))
      if (actx === undefined) throw new Error(`dsh-atlas: session "${String(sessionId)}" has no client scope`)
      return {
        controller: inputTriggers.sessionOf(actx),
        hooks: { scope },
        sessionId,
        toggleGroup: key => mention.toggleGroup(sid(sessionId), key),
        rebuildRows: (sid, query) => mention.rebuildRows(sid as SessionId, query),
        // A send may have grown the Host's external ledger: drop the cached scope so
        // the next `@folder:` asks again instead of hiding a folder it now knows.
        onSend: () => { mention.invalidateExternal(sid(sessionId)); void loadSettings() },
      }
    },
  }, MentionNavigator))

  // Sent-message `@path` click-through. The installed client draws the chip but
  // never wires its click, so the plugin opens the reference itself; the entry
  // is per session because the file address is scoped to the session workspace.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-reference-links',
    order: 4,
    inject: (sessionId): ReferenceLinksInjected => ({
      actionFor: (link, again) => actionFor(sid(sessionId), link, again),
      resolveLabel: resolveChipLabel,
      repeatClick: link => repeatClick(sid(sessionId), link),
      noteClick: link => noteClick(sid(sessionId), link),
    }),
  }, ReferenceLinks))

  // The draft half of the same bridge: a reference token in the composer gets the
  // click the framework never wired, and the tail its own decoration leaves plain
  // gets the framework's reference colour. It reads the dock's verdicts instead of
  // inspecting again, so both surfaces agree on what is openable.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-draft-links',
    order: 5,
    inject: (sessionId): DraftLinksInjected => ({
      // The composer token shares the dock's ledger: the surfaces differ, the
      // object does not, so the second click on the same reference is the second
      // click wherever it is made (A-27).
      actionFor: (link, again) => actionFor(sid(sessionId), link, again),
      repeatClick: link => repeatClick(sid(sessionId), link),
      noteClick: link => noteClick(sid(sessionId), link),
      hooks: { referenceInfo },
      resolveSession: resolveSessionLabel,
    }),
  }, DraftLinks))

  // Menu glyphs: the framework's row can only draw three of its own glyphs, so
  // this layer draws the plugin's icons over the slot each of our rows reserves.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-menu-icons',
    order: 6,
    inject: (sessionId): MenuIconsInjected => {
      const actx = sessions.scope(sid(sessionId))
      if (actx === undefined) throw new Error(`dsh-atlas: session "${String(sessionId)}" has no client scope`)
      return { hooks: { menu: inputTriggers.sessionOf(actx).menu } }
    },
  }, MenuIcons))

  // Display-only side ad next to the @ menu (never affects warm/match). The
  // default build has no ad panel at all; only an ad-enabled build registers it.
  if (adsEnabled()) {
    ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
      name: 'conversation.input.overlay',
      id: 'atlas-ad',
      order: 3,
      inject: (sessionId): MentionAdProps => {
        const actx = sessions.scope(sid(sessionId))
        if (actx === undefined) throw new Error(`dsh-atlas: session "${String(sessionId)}" has no client scope`)
        return { menu: inputTriggers.sessionOf(actx).menu }
      },
    }, MentionAd))
  }

  // Session history jump (F2): Escape hands the keyboard to the conversation and
  // ↑/↓ walk back through the user's own messages, Enter puts one back in the
  // composer; Ctrl/Cmd+↑/↓ do the same walk straight from the composer. The
  // frames come from the session's own Chat snapshot (a standard prop), so this
  // reads no new endpoint and never touches file content.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-history-jump',
    order: 7,
    locale: NS,
    inject: (sessionId): FrameCursorInjected => {
      const actx = sessions.scope(sid(sessionId))
      if (actx === undefined) throw new Error(`dsh-atlas: session "${String(sessionId)}" has no client scope`)
      // A-05: the jump loader is what lets the walk continue past the oldest
      // LOADED frame. It is optional on purpose — a client build whose session
      // face lacks it keeps the degraded walk (stop at the oldest loaded frame)
      // rather than failing to register the gesture at all.
      const face = sessions.sessionOf(actx)
      return {
        scope,
        // Optional by design: a profile without the input-trigger service still
        // gets the history gesture, it just cannot know the @ menu is open.
        menu: inputTriggers.sessionOf(actx).menu as SnapshotStore<{ readonly open: boolean }>,
        loadThrough: face === undefined ? undefined : seq => face.loadThrough(seq as never),
        // A-13: the session-wide turn outline, which is what keeps the walk's
        // total equal to the page's own turn ruler. Read off the SAME session
        // face as `loadThrough` because `useProjection` is declared on
        // `ChatViewInjected` (the `conversation.view` slot's own bundle), which
        // this overlay never receives. Optional like `loadThrough`.
        projections: face === undefined ? undefined : (face.projections as ProjectionFace | undefined),
        roam,
      }
    },
  }, FrameCursor))

  // The roaming READOUT lives in the input dock rather than in the overlay, so it
  // renders as a sibling of `/goal` and `/todo` instead of floating over them.
  //
  // The dock is a `flex-direction: column` list with a 6px gap (ui-conversation's
  // `composerStack`), which is what makes the two guarantees the user asked for
  // structural rather than a matter of z-index tuning: the readout cannot overlap
  // another dock view, and it sits ABOVE the composer without displacing the
  // conversation. Reading the geometry is unnecessary here — the flex column lays
  // it out — which retires the `position: fixed` strip and the measuring effect
  // that used to align it with the composer card.
  //
  // `order: 30` puts it below this plugin's own files dock (20) and below the
  // todo/goal docks (0/…), i.e. closest to the composer, where the position
  // readout is read as a caption for what the composer will receive.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'atlas-history-readout',
    order: 30,
    locale: NS,
    // The readout only needs the store: the cursor itself is computed once, by the
    // overlay half, and recomputing it here would double the walk for a value that
    // would then have to be kept in step.
    inject: (): FrameReadoutInjected => ({ roam }),
  }, FrameReadout))

  // Session history palette (F1): Ctrl/Cmd+Shift+H (or without Shift; see
  // `isPaletteChord`) opens a searchable list of
  // every user message, Enter puts one back in the composer. It shares the frame
  // index and the write-back with F2 but owns the keyboard while open, which is
  // why it is a separate overlay rather than more state in the cursor.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-history-palette',
    order: 8,
    locale: NS,
    inject: (): HistoryPaletteInjected => ({ scope }),
  }, HistoryPalette))

  // The folder tab: a directory, one level, walked in place. A folder has nowhere
  // else to go — the `file` viewers answer a directory with "is a directory", and
  // the built-in files tab is a page that claims no address — so this plugin
  // registers the `folder` resource type it opens folders through.
  const sidebarTabs = resolveSidebarTabs(ctx)
  if (sidebarTabs !== undefined) {
    ctx.effect(() => sidebarTabs.register(folderTabDefinition(t)), 'dsh-atlas: folder tab type')
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: FOLDER_TAB_ID,
      locale: NS,
      inject: (sessionId): FolderTabInjected => ({
        list: (path, signal, include) => listDirectory(sid(sessionId), path, signal, include),
        openFile: (path) => { actionFor(sid(sessionId), { kind: 'file', path })?.() },
        openNative: (path) => { openPath(path) },
      }),
    }, FolderTab))
  }

  /**
   * The folder chooser's own open state: the token span a confirmed pick replaces.
   * Written by the source's picker row, read by the dialog overlay.
   */
  const folderPicker = createSnapshotStore<{ value: { span: TokenSpan } | null }>({ value: null })

  // The folder chooser dialog: the product's browse backend with this plugin's face.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-folder-picker',
    order: 7,
    locale: NS,
    inject: (sessionId): FolderPickerInjected => {
      const workspace = optionalService<UIWorkspaceFace>(ctx, 'uiWorkspace')
      return {
        // This plugin's OWN backend, not the product's `uiWorkspace.listDirectory`:
        // a listing at a drive root carries `drives` in place of `parent` (that is
        // how the chooser offers the other drives), and the product's
        // `DirectoryListing` has no such field. The plugin's listing also answers a
        // refusal as a reason instead of an exception, which is what lets the dialog
        // keep the user's place and explain itself.
        list: (path, signal) => listDirectory(sid(sessionId), path ?? '', signal).then(toPickerListing),
        browse: (path, signal) => browseDirectory(sid(sessionId), path ?? '', signal).then(toPickerListing),
        create: (path, name) => {
          if (workspace?.createDirectory === undefined) throw new Error(t('picker.error'))
          return workspace.createDirectory(path, name)
        },
        recent: (signal) => recentFolders(sid(sessionId), signal).then(rows => rows.map(row => ({
          path: row.path,
          name: row.name,
          reason: row.reason,
        }))),
        confirm: (path) => { adoptPickedFolder(sid(sessionId), path) },
        close: () => { folderPicker.set({ value: null }) },
        hooks: { folderPicker },
      }
    },
  }, FolderPicker))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'atlas',
    order: 55,
    label: () => t('nav'),
    locale: NS,
    inject: (): AtFileSectionInjected => ({
      hooks: { scope },
      viewState: settingsViewState,
      setEnabled: async (enabled: boolean) => { await updateSettings({ field: 'enabled', value: enabled }) },
      setEnableSkills: async (enableSkills: boolean) => { await updateSettings({ field: 'enableSkills', value: enableSkills }) },
      setEnableChats: async (enableChats: boolean) => { await updateSettings({ field: 'enableChats', value: enableChats }) },
      setEnablePlugins: async (enablePlugins: boolean) => { await updateSettings({ field: 'enablePlugins', value: enablePlugins }) },
      setIgnorePastedMentions: async (ignorePastedMentions: boolean) => {
        await updateSettings({ field: 'ignorePastedMentions', value: ignorePastedMentions })
      },
      setFolderOpen: async (folderOpen: FolderOpenTarget) => {
        await updateSettings({ field: 'folderOpen', value: folderOpen })
      },
      setHistoryJump: async (historyJump: boolean) => {
        await updateSettings({ field: 'historyJump', value: historyJump })
      },
      setHistoryJumpFrames: async (historyJumpFrames: HistoryFrameMode) => {
        await updateSettings({ field: 'historyJumpFrames', value: historyJumpFrames })
      },
      setHistoryJumpReuseMode: async (historyJumpReuseMode: HistoryReuseMode) => {
        await updateSettings({ field: 'historyJumpReuseMode', value: historyJumpReuseMode })
      },
      setHistoryJumpSmartFollow: async (historyJumpSmartFollow: boolean) => {
        await updateSettings({ field: 'historyJumpSmartFollow', value: historyJumpSmartFollow })
      },
      setIgnoreFiles: async (ignoreFiles: readonly FileIgnoreRuleInput[]) => {
        await updateSettings({ field: 'ignoreFiles', value: [...ignoreFiles] })
      },
      setWorkspaceIgnoreFiles: async (workspace: string, ignoreFiles: readonly FileIgnoreRuleInput[]) => {
        const current = normalizeWorkspaceIgnoreFiles(scope.getSnapshot().value.workspaceIgnoreFiles)
        const target = workspacePathKey(workspace)
        const next = current.filter(entry => workspacePathKey(entry.workspace) !== target)
        const normalized = normalizeIgnoreFiles(ignoreFiles)
        if (normalized.length > 0) next.push({ workspace, ignoreFiles: normalized })
        await updateSettings({ field: 'workspaceIgnoreFiles', value: next })
      },
    }),
  }, AtFileSection))
}