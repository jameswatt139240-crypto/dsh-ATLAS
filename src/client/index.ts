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
  ChatCandidate,
  DirectoryListing,
  FileEntry,
  FileIgnoreRuleInput,
  GitChange,
  ExternalAccessScope,
  FolderOpenTarget,
  PluginCandidate,
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
import { ReferenceLinks, type ReferenceLinksInjected, type ReferenceOutcome } from './ReferenceLinks.tsx'
import { folderAddress, sessionFileAddress, type ReferenceLink } from './reference-links.ts'
import { draftTokens } from './draft-links.ts'
import { draftScopeOf } from './draft-scope.ts'
import { referenceKey } from './model.ts'
import { FolderTab, folderTabDefinition, FOLDER_TAB_ID, type FolderTabInjected } from './FolderTab.tsx'
import { FolderPicker, type FolderPickerInjected, type PickerListing } from './FolderPicker.tsx'
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
  list?(sessionId: SessionId, path: string, signal?: AbortSignal): Promise<{ ok: true; value: DirectoryListing } | { ok: false; error: { code: string; message: string; details: object } }>
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
  openResource(address: string): void
  /** Open a page type by kind (absent on a build without the files tab). */
  openTab?(kind: string): void
}

/** The right Sidebar's tab-type registry, as this plugin registers into it. */
interface SidebarRightTabsFace {
  register(definition: SidebarRightTabDefinition): () => void
}

/** The workspace layer's folder chooser and its browse backend, as we call them. */
interface UIWorkspaceFace {
  pickDirectory(): Promise<string | null>
  listDirectory(path?: string, signal?: AbortSignal): Promise<PickerListing>
  createDirectory(path: string, name: string): Promise<string>
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

  const listDirectory = async (sessionId: SessionId, path: string, signal: AbortSignal): Promise<DirectoryListing> => {
    // A host built before the folder browser has no such member: the tab then says
    // so instead of showing an empty folder, which would be a lie.
    if (atFile?.list === undefined) throw new Error('dsh-atlas: this host cannot list directories')
    const result = await atFile.list(sessionId, path, signal)
    if (!result.ok) throw new Error(`list failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

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
    const actx = sessions.scope(sessionId)
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
    const actx = sessions.scope(sessionId)
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
  // workspace reference is relative and is resolved through the index.
  // `isAbsoluteReference` (src/external.ts) is the single copy of that test.

  /** Open one folder with the OS file manager, absolute or workspace-relative. */
  const openFolder = (path: string): void => {
    if (isAbsoluteReference(path)) {
      openPath(path)
      return
    }
    openRelative(path)
  }

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
   * The action a click on one mention performs, or undefined when this build
   * has none.
   *
   * A file mention lands in the right Sidebar under this session's file address
   * — the same target the framework uses when it wires the chip itself; a build
   * without that column falls back to the Host opener. A folder mention has no
   * in-product viewer of its own, so it goes straight to the Host opener (the
   * file manager), which is what the dock's directory rows always did. A skill
   * mention routes to the skill source's own opener (the framework's `openSkill`
   * gesture). A provider mention is the provider's to open: only its declared
   * `open` says what the item means, and a provider without one leaves the chip
   * inert rather than guessed at.
   * @param sessionId - the session whose transcript was clicked.
   * @param link - the decoded mention.
   * @returns the click action, or undefined when nothing can be opened.
   */
  const actionFor = (sessionId: SessionId, link: ReferenceLink): (() => ReferenceOutcome | Promise<ReferenceOutcome>) | undefined => {
    if (link.kind === 'folder' || link.kind === 'file') {
      return () => openReferenceTarget(sessionId, link)
    }
    if (link.kind === 'skill') {
      const actx = sessions.scope(sessionId)
      if (actx === undefined) return undefined
      return () => {
        inputTriggers.sessionOf(actx).openReference('skill', { ref: `/${link.name}` })
        return 'opened'
      }
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
      // A folder opens in the right Sidebar by default — the sidebar is where a
      // folder is useful — while the local (OS) open that came first stays
      // configurable: both, sidebar only, or local only.
      const target = scope.getSnapshot().value.folderOpen ?? 'both'
      const sidebar = target === 'native' ? undefined : resolveSidebarRight(ctx)
      if (sidebar !== undefined) {
        try {
          // A WORKSPACE folder opens the product's own files tab: that is the tree
          // the user already reads folders in (and 添加工作区 taught them). It cannot
          // be told WHICH folder to select — `ui-sidebar-files` declares no params
          // and no reveal API — so the tree opens at the workspace root and the row
          // is the user's own click. A folder OUTSIDE the workspace cannot be shown
          // there at all (that tree refuses to read outside), so it opens this
          // plugin's own `folder` tab, which lists it and can walk on.
          if (isAbsoluteReference(link.path)) sidebar.openResource(folderAddress(link.path))
          else if (sidebar.openTab !== undefined) sidebar.openTab('files')
          else sidebar.openResource(folderAddress(link.path))
        } catch (error) {
          console.error('[dsh-atlas] sidebar folder open failed:', error)
        }
      }
      if (target !== 'sidebar') openFolder(link.path)
      return 'opened'
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

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'atlas',
    order: 20,
    locale: NS,
    inject: (sessionId): AtFileDockInjected => ({
      // The dock opens through the same action the sent-message chips use, so a
      // referenced file behaves identically wherever it is clicked.
      onOpen: link => { actionFor(sessionId, link)?.() },
      requestInspect: targets => { requestInspect(sessionId, targets) },
      hooks: { scope, referenceInfo },
    }),
  }, FilesDock))

  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-mention-navigation',
    order: 2,
    inject: (sessionId): MentionNavigatorInjected => {
      const actx = sessions.scope(sessionId)
      if (actx === undefined) throw new Error(`dsh-atlas: session "${String(sessionId)}" has no client scope`)
      return {
        controller: inputTriggers.sessionOf(actx),
        hooks: { scope },
        sessionId,
        toggleGroup: key => mention.toggleGroup(sessionId, key),
        rebuildRows: (sid, query) => mention.rebuildRows(sid as SessionId, query),
        // A send may have grown the Host's external ledger: drop the cached scope so
        // the next `@folder:` asks again instead of hiding a folder it now knows.
        onSend: () => { mention.invalidateExternal(sessionId); void loadSettings() },
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
      actionFor: link => actionFor(sessionId, link),
      resolveLabel: resolveChipLabel,
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
      actionFor: link => actionFor(sessionId, link),
      hooks: { referenceInfo },
    }),
  }, DraftLinks))

  // Menu glyphs: the framework's row can only draw three of its own glyphs, so
  // this layer draws the plugin's icons over the slot each of our rows reserves.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'atlas-menu-icons',
    order: 6,
    inject: (sessionId): MenuIconsInjected => {
      const actx = sessions.scope(sessionId)
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
        const actx = sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`dsh-atlas: session "${String(sessionId)}" has no client scope`)
        return { menu: inputTriggers.sessionOf(actx).menu }
      },
    }, MentionAd))
  }

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
        list: (path, signal) => listDirectory(sessionId, path, signal),
        openFile: (path) => { actionFor(sessionId, { kind: 'file', path })?.() },
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
        list: (path, signal) => {
          if (workspace?.listDirectory === undefined) throw new Error(t('picker.error'))
          return workspace.listDirectory(path, signal)
        },
        create: (path, name) => {
          if (workspace?.createDirectory === undefined) throw new Error(t('picker.error'))
          return workspace.createDirectory(path, name)
        },
        confirm: (path) => { adoptPickedFolder(sessionId, path) },
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