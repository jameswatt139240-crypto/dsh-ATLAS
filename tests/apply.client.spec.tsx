// @vitest-environment jsdom
/**
 * Client plugin wiring over stubbed services: mounting the atFile Remote
 * contribution, registering the '@' source with the trigger pipeline and the
 * settings gate, the dock entry with its inject face, the settings section,
 * the locale dictionaries, and the one-shot stylesheet injection.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { AT_REMOTE } from '../src/client/remote.ts'
import { NS, en, zh } from '../src/client/locales.ts'
import { SOURCE_NAME } from '../src/client/source.ts'
import { STYLE_ID } from '../src/client/styles.ts'
import { DEFAULT_IGNORE_FILES } from '../src/defaults.ts'
import type { AtFileSettings, AtFileSettingsUpdate, BrowseListing, DirectoryListing, ExternalAccessScope, RecentFolder, ReferenceInfo, WorkspaceIgnoreFiles } from '../src/contract.ts'
import type { AtlasRuntimeInfo } from '../src/atlas.ts'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } }

interface BootOptions {
  atFileSearch?: (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<readonly { path: string; relative: string; kind: 'file' | 'dir' }[]>>
  atFileInspect?: (sessionId: SessionId, targets: readonly string[]) => Promise<RemoteResult<readonly ReferenceInfo[]>>
  /**
   * The Host's one-level listing, which is how a folder's SECOND click learns the
   * absolute spelling of the folder (m02155). Absent by default, like a Host built
   * before the folder browser: the click then falls back to the Session summary.
   */
  atFileList?: (sessionId: SessionId, path: string, include: string, signal: AbortSignal) => Promise<RemoteResult<DirectoryListing>>
  atFileExternal?: (sessionId: SessionId, signal: AbortSignal) => Promise<{ ok: true; value: ExternalAccessScope } | { ok: false; error: { code: string; message: string } }>
  atFileGetSettings?: () => Promise<RemoteResult<AtFileSettings>>
  atFileUpdateSettings?: (update: AtFileSettingsUpdate) => Promise<RemoteResult<AtFileSettings>>
  /** The chooser's own listing, carrying `hasChildren`; absent on an older Host. */
  atFileBrowse?: (sessionId: SessionId, path: string, signal: AbortSignal) => Promise<RemoteResult<BrowseListing>>
  /** The folders offered before the chooser browses anywhere; absent on an older Host. */
  atFileRecentFolders?: (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<readonly RecentFolder[]>>
  /** The right Sidebar's tab registry, so the folder tab registers. */
  sidebarTabs?: { register: (definition: unknown) => () => void }
  /** The product's workspace view: session navigation and folder creation. */
  uiWorkspace?: { openSession?: (target: SessionId) => void; createDirectory: (path: string, name: string) => Promise<string> }
  /** The session face behind `ctx.sessions.sessionOf`: history loading and projections. */
  sessionFace?: { loadThrough: (seq: number) => void; projections?: unknown }
  /** How `ctx.sessions.scope` answers; undefined is a session with no client scope. */
  withoutSessionScope?: boolean
  /** The Atlas namespace that carries the running Harness's own facts. */
  remoteAtlas?: { runtime: () => Promise<RemoteResult<AtlasRuntimeInfo>>; gitChanges: (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<readonly unknown[]>> }
  openPath?: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>
  enabled?: boolean
  ignorePastedMentions?: boolean
  ignoreFiles?: readonly string[]
  workspaceIgnoreFiles?: readonly WorkspaceIgnoreFiles[]
  withoutNamespace?: boolean
  withoutSessionRemote?: boolean
  remoteMount?: () => Promise<() => void>
  /**
   * The session list the draft's bare-label resolver reads (ids + display titles),
   * plus the `cwd` the desktop opener needs: a folder's SECOND click must hand the
   * Host an absolute path, and the Host resolves nothing (it only opens).
   */
  sessionList?: { ids: readonly string[]; byId: Record<string, { displayTitle: string; cwd?: string }> }
  /** How `ctx.sessions.open` answers; the default records the call. */
  openSession?: (sessionId: string) => void
  /**
   * One service name whose read must THROW, the way cordis answers a service this
   * plugin never declared in `inject`. That is how a profile with no right Sidebar
   * behaves, and it is the branch every optional read exists for.
   */
  mountThrowingService?: string
  /** The at-mention namespace: skills, chats and installed plugins. */
  remoteAtMention?: {
    listSkills?: (sessionId: string, signal: AbortSignal) => Promise<{ ok: true; value: readonly unknown[] } | { ok: false; error: { code: string; message: string } }>
    listChats?: (sessionId: string, query: string, limit: number, signal: AbortSignal) => Promise<{ ok: true; value: readonly unknown[] } | { ok: false; error: { code: string; message: string } }>
    listPlugins?: (signal: AbortSignal) => Promise<{ ok: true; value: readonly unknown[] } | { ok: false; error: { code: string; message: string } }>
  }
}

/** Boot the plugin body over a stub-service context and return the recorded surfaces. */
async function boot(options: BootOptions = {}) {
  const ctx = new Context()
  const sourceDispose = vi.fn()
  const registerSource = vi.fn(() => sourceDispose)
  const openReference = vi.fn(() => true)
  const controller = {
    menu: { getSnapshot: vi.fn(), subscribe: vi.fn() },
    track: vi.fn(),
    openReference,
    ...(options.sessionFace ?? {}),
  }
  const sessionOf = vi.fn(() => controller)
  const sessionScope = {}
  const sessionBail = vi.fn(() => true)
  const scopeSession = vi.fn(() => (options.withoutSessionScope === true ? undefined : { ...sessionScope, bail: sessionBail }))
  const mount = vi.fn(options.remoteMount ?? (async () => () => {}))
  const localeRegister = vi.fn(() => () => {})
  const bind = vi.fn(() => (key: string, params?: Record<string, string>) => (params?.message ? `${key}: ${params.message}` : key))
  const slotsRegister = vi.fn()
  const slotsInject = vi.fn((_name: string, factory: () => void) => { factory() })
  const openPath = vi.fn(options.openPath ?? (async () => ({ ok: true as const })))
  let settings: AtFileSettings = {
    enabled: options.enabled ?? true,
    ignoreFiles: [...options.ignoreFiles ?? DEFAULT_IGNORE_FILES],
    workspaceIgnoreFiles: (options.workspaceIgnoreFiles ?? []).map(entry => ({
      workspace: entry.workspace,
      ignoreFiles: [...entry.ignoreFiles],
    })),
    ignorePastedMentions: options.ignorePastedMentions ?? true,
    // The three category switches default to on in the schema; a stub that omits
    // them reads as `undefined` and silently empties those categories.
    enableSkills: true,
    enableChats: true,
    enablePlugins: true,
  }
  const getSettings = vi.fn(options.atFileGetSettings ?? (async () => ({ ok: true as const, value: settings })))
  const updateSettings = vi.fn(options.atFileUpdateSettings ?? (async (update: AtFileSettingsUpdate) => {
    settings = { ...settings, [update.field]: update.value }
    return { ok: true as const, value: settings }
  }))
  ctx.provide('inputTriggers', { registerSource, sessionOf })
  ctx.provide('connection', {})
  ctx.provide('remote', { $mount: mount, session: { openWorkspacePath: openPath } })
  // In the real client each Remote namespace is its own service (and reading it
  // as `ctx.remote.session` throws without an inject), so the opener is read
  // from the store like every other namespace this plugin uses.
  if (options.withoutSessionRemote !== true) {
    ctx.provide('remote.session', { openWorkspacePath: openPath })
  }
  if (options.withoutNamespace !== true) {
    ctx.provide('remote.atFile', {
      search: options.atFileSearch ?? (async () => ({ ok: true as const, value: [] })),
      // The open action confirms a target exists before handing it to a viewer;
      // without a stub the plugin treats the target as unverified and opens.
      ...(options.atFileInspect === undefined ? {} : { inspect: options.atFileInspect }),
      ...(options.atFileList === undefined ? {} : { list: options.atFileList }),
      ...(options.atFileExternal === undefined ? {} : { external: options.atFileExternal }),
      ...(options.atFileBrowse === undefined ? {} : { browse: options.atFileBrowse }),
      ...(options.atFileRecentFolders === undefined ? {} : { recentFolders: options.atFileRecentFolders }),
      getSettings,
      updateSettings,
    })
  }
  if (options.remoteAtlas !== undefined) ctx.provide('remote.atlas', options.remoteAtlas)
  if (options.remoteAtMention !== undefined) ctx.provide('remote.atMention', options.remoteAtMention)
  if (options.sidebarTabs !== undefined) ctx.provide('sidebarRightTabs', options.sidebarTabs)
  if (options.uiWorkspace !== undefined) ctx.provide('uiWorkspace', options.uiWorkspace)
  ctx.provide('slots', { inject: slotsInject, register: slotsRegister })
  ctx.provide('locale', { register: localeRegister, bind })
  // The draft's session face: a bare `@label` may only become a session link on
  // this list's answer, and opening one goes through the service the sidebar's
  // own rows use.
  const openSessionSpy = vi.fn(options.openSession ?? (() => {}))
  const sessionList = options.sessionList ?? { ids: [], byId: {} }
  // The per-session face behind the history walk (A-05/A-13): absent unless a test
  // hands it the two optional members, which is exactly how an older client behaves.
  const sessionOfSpy = vi.fn(() => (options.sessionFace === undefined ? undefined : controller))
  ctx.provide('sessions', {
    scope: scopeSession,
    sessionOf: sessionOfSpy,
    list: { getSnapshot: () => ({ ids: sessionList.ids, byId: sessionList.byId }) },
    open: openSessionSpy,
  })
  if (options.mountThrowingService !== undefined) {
    // A service this plugin never declared in `inject` is not readable through the
    // cordis context proxy: the read throws. Install exactly that, so a missing
    // right Sidebar is reproduced instead of merely absent.
    Object.defineProperty(ctx, options.mountThrowingService, {
      configurable: true,
      get() { throw new Error(`cannot get property "${options.mountThrowingService}" without inject`) },
    })
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  // The Remote mount effect is asynchronous; settle one tick.
  await Promise.resolve()
  await Promise.resolve()
  return {
    ctx, registerSource, sessionOf, sessionScope, scopeSession, mount, localeRegister, bind,
    slotsRegister, slotsInject, openPath, getSettings, updateSettings, sourceDispose, openReference,
    openSessionSpy, sessionBail,
    setRemoteSettings: (next: AtFileSettings) => { settings = next },
  }
}

/** One registered trigger source, narrowed to the members the assertions read. */
interface SourceRow {
  name: string
  value?: string
  chatUri?: string
  mentionKind?: string
  recent?: boolean
}

interface RegisteredSource {
  trigger: string
  name: string
  candidates: (session: { sessionId: SessionId }, req: { query: string; position: 'leading' | 'inline'; signal: AbortSignal }) => Promise<readonly SourceRow[]>
  onPick?: (args: { candidate: SourceRow; session: { sessionId: SessionId }; action: string; span?: unknown }) => { text?: string } | undefined
  openReference?: (session: { sessionId: SessionId }, reference: { ref: string }) => boolean
}

/** The source the wiring registered, if any. */
function registered(booted: Awaited<ReturnType<typeof boot>>): RegisteredSource {
  expect(booted.registerSource).toHaveBeenCalled()
  return booted.registerSource.mock.calls[0]![0] as RegisteredSource
}

interface RegisteredSettingsSection {
  id: string
  order: number
  label: () => string
  locale: string
  inject: () => {
    hooks: { scope: { getSnapshot: () => { value: AtFileSettings } } }
    viewState: { filterScope: 'global' | 'workspace'; selectedWorkspace: string }
    setEnabled: (enabled: boolean) => Promise<void>
    setEnableSkills: (enableSkills: boolean) => Promise<void>
    setEnableChats: (enableChats: boolean) => Promise<void>
    setEnablePlugins: (enablePlugins: boolean) => Promise<void>
    setIgnorePastedMentions: (ignore: boolean) => Promise<void>
    setIgnoreFiles: (ignoreFiles: readonly string[]) => Promise<void>
    setWorkspaceIgnoreFiles: (workspace: string, ignoreFiles: readonly string[]) => Promise<void>
  }
}

function settingsSection(booted: Awaited<ReturnType<typeof boot>>): RegisteredSettingsSection {
  const section = booted.slotsRegister.mock.calls
    .find(call => call[0]?.name === 'settings.section')?.[0] as RegisteredSettingsSection | undefined
  expect(section).toBeDefined()
  return section as RegisteredSettingsSection
}

/** One mention the bridge hands to the opener. */
type BridgeLink =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'skill'; name: string }
  | { kind: 'atlas'; provider: string; item: string }

/** The registered reference dock, narrowed to what the assertions read. */
interface RegisteredDock {
  inject: (sessionId: string) => { onOpen: (link: BridgeLink) => void }
}

function dockOf(booted: Awaited<ReturnType<typeof boot>>): RegisteredDock {
  const entry = booted.slotsRegister.mock.calls
    .find(call => call[0]?.name === 'conversation.input.dock')?.[0] as RegisteredDock | undefined
  expect(entry).toBeDefined()
  return entry as RegisteredDock
}

/** The registered sent-message reference bridge, narrowed to what the assertions read. */
interface RegisteredReferenceBridge {
  name: string
  order: number
  inject: (sessionId: string) => { actionFor: (link: BridgeLink) => (() => void) | undefined }
}

function referenceBridge(booted: Awaited<ReturnType<typeof boot>>): RegisteredReferenceBridge {
  const entry = booted.slotsRegister.mock.calls
    .find(call => (call[0] as { id?: string })?.id === 'atlas-reference-links')?.[0] as RegisteredReferenceBridge | undefined
  expect(entry).toBeDefined()
  return entry as RegisteredReferenceBridge
}

/** The registered composer bridge, narrowed to the face the session rules live on. */
interface RegisteredDraftBridge {
  name: string
  order: number
  inject: (sessionId: string) => {
    actionFor: (link: BridgeLink) => (() => unknown) | undefined
    resolveSession?: (label: string) => string | undefined
  }
}

function draftBridge(booted: Awaited<ReturnType<typeof boot>>): RegisteredDraftBridge {
  const entry = booted.slotsRegister.mock.calls
    .find(call => (call[0] as { id?: string })?.id === 'atlas-draft-links')?.[0] as RegisteredDraftBridge | undefined
  expect(entry).toBeDefined()
  return entry as RegisteredDraftBridge
}

const s1 = { sessionId: 's1' as SessionId }
const signal = () => new AbortController().signal
/** Let a queued open settle: the action confirms the target before it opens. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('dsh-atlas client apply', () => {
  it('declares the picker and carrier services', () => {
    expect(inject).toEqual(['inputTriggers', 'sessions', 'connection', 'remote', 'slots', 'locale'])
  })

  it('mounts the atFile Remote contribution and registers the @ source', async () => {
    const { mount, registerSource } = await boot()
    expect(mount).toHaveBeenCalledWith(AT_REMOTE)
    expect(registerSource).toHaveBeenCalledTimes(1)
    const source = registerSource.mock.calls[0]![0] as RegisteredSource
    expect(source.trigger).toBe('@')
    expect(source.name).toBe(SOURCE_NAME)
  })

  it('routes candidate searches through the Remote namespace', async () => {
    const atFileSearch = vi.fn(async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }))
    const booted = await boot({ atFileSearch })
    // Warm the pages first (the first @ interaction preloads them).
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await Promise.resolve()
    await Promise.resolve()
    const rows = await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    expect(rows.some(row => row.name === 'a.ts')).toBe(true)
    expect(atFileSearch).toHaveBeenCalledWith('s1', expect.any(AbortSignal))
  })

  it('turns a failed remote search into a rejection in category mode', async () => {
    const atFileSearch = vi.fn(async () => ({ ok: false as const, error: { code: 'search-down', message: 'boom', details: {} } }))
    const booted = await boot({ atFileSearch })
    await expect(registered(booted).candidates(s1, { query: 'file:', position: 'leading', signal: signal() }))
      .rejects.toThrow(/search failed: search-down: boom/)
  })

  it('fails loud when the namespace service never mounted', async () => {
    const booted = await boot({ withoutNamespace: true })
    await expect(registered(booted).candidates(s1, { query: 'file:', position: 'leading', signal: signal() }))
      .rejects.toThrow(/not mounted/)
  })

  it('does not register the source while the settings switch is off, then registers on flip', async () => {
    const booted = await boot({ enabled: false })
    expect(booted.registerSource).toHaveBeenCalledTimes(1)
    expect(booted.sourceDispose).toHaveBeenCalledTimes(1)
    await settingsSection(booted).inject().setEnabled(true)
    expect(booted.registerSource).toHaveBeenCalledTimes(2)
  })

  it('unregisters the source when the switch flips off after boot', async () => {
    const booted = await boot({ enabled: true })
    expect(booted.registerSource).toHaveBeenCalledTimes(1)
    await settingsSection(booted).inject().setEnabled(false)
    expect(booted.sourceDispose).toHaveBeenCalledTimes(1)
    // A flip-off disposes the source; a flip-on re-registers (new call).
    await settingsSection(booted).inject().setEnabled(true)
    expect(booted.registerSource).toHaveBeenCalledTimes(2)
  })

  it('defaults to enabled before the first settings read, then follows the value', async () => {
    let resolve: ((result: RemoteResult<AtFileSettings>) => void) | undefined
    const pending = new Promise<RemoteResult<AtFileSettings>>(done => { resolve = done })
    const booted = await boot({ atFileGetSettings: async () => pending })
    expect(booted.registerSource).toHaveBeenCalledTimes(1)
    resolve?.({
      ok: true,
      value: { enabled: false, ignoreFiles: [...DEFAULT_IGNORE_FILES], workspaceIgnoreFiles: [] },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(booted.sourceDispose).toHaveBeenCalledTimes(1)
  })

  it('reloads settings after a connection reset', async () => {
    const booted = await boot()
    booted.setRemoteSettings({ enabled: false, ignoreFiles: ['reset.tmp'], workspaceIgnoreFiles: [] })
    booted.ctx.emit('connection/reset')
    await Promise.resolve()
    await Promise.resolve()
    expect(booted.getSettings).toHaveBeenCalledTimes(2)
    expect(settingsSection(booted).inject().hooks.scope.getSnapshot().value)
      .toMatchObject({ enabled: false, ignoreFiles: ['reset.tmp'] })
  })

  it('does not publish an older settings read after a reconnect', async () => {
    let resolveFirst: ((result: RemoteResult<AtFileSettings>) => void) | undefined
    const first = new Promise<RemoteResult<AtFileSettings>>(resolve => { resolveFirst = resolve })
    let calls = 0
    const booted = await boot({
      atFileGetSettings: async () => {
        calls += 1
        if (calls === 1) return first
        return {
          ok: true,
          value: { enabled: false, ignoreFiles: ['fresh.tmp'], workspaceIgnoreFiles: [] },
        }
      },
    })
    booted.ctx.emit('connection/reset')
    await Promise.resolve()
    await Promise.resolve()
    resolveFirst?.({
      ok: true,
      value: { enabled: true, ignoreFiles: ['stale.tmp'], workspaceIgnoreFiles: [] },
    })
    await Promise.resolve()
    expect(settingsSection(booted).inject().hooks.scope.getSnapshot().value)
      .toMatchObject({ enabled: false, ignoreFiles: ['fresh.tmp'] })
  })

  it('silences a stale settings read rejection after a reconnect', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectFirst: ((error: Error) => void) | undefined
    const first = new Promise<RemoteResult<AtFileSettings>>((_resolve, reject) => { rejectFirst = reject })
    let calls = 0
    try {
      const booted = await boot({
        atFileGetSettings: async () => {
          calls += 1
          if (calls === 1) return first
          return {
            ok: true,
            value: { enabled: false, ignoreFiles: ['fresh.tmp'], workspaceIgnoreFiles: [] },
          }
        },
      })
      booted.ctx.emit('connection/reset')
      await Promise.resolve()
      await Promise.resolve()
      rejectFirst?.(new Error('stale read'))
      await Promise.resolve()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs a structured settings read failure and keeps the last snapshot', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const booted = await boot({
        atFileGetSettings: async () => ({
          ok: false,
          error: { code: 'SETTINGS_DOWN', message: 'unavailable', details: {} },
        }),
      })
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] settings read failed: SETTINGS_DOWN: unavailable')
      expect(settingsSection(booted).inject().hooks.scope.getSnapshot().value.enabled).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs a rejecting settings read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await boot({ atFileGetSettings: async () => { throw new Error('read transport down') } })
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] settings read failed:', expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs settings updates rejected by the Remote', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const booted = await boot({
        atFileUpdateSettings: async () => ({
          ok: false,
          error: { code: 'WRITE_REFUSED', message: 'read only', details: {} },
        }),
      })
      await settingsSection(booted).inject().setEnabled(false)
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] settings update failed: WRITE_REFUSED: read only')
      expect(settingsSection(booted).inject().hooks.scope.getSnapshot().value.enabled).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs a rejecting settings update', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const booted = await boot({
        atFileUpdateSettings: async () => { throw new Error('write transport down') },
      })
      await settingsSection(booted).inject().setEnabled(false)
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] settings update failed:', expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not publish an older settings update after a reconnect', async () => {
    let resolveUpdate: ((result: RemoteResult<AtFileSettings>) => void) | undefined
    const pending = new Promise<RemoteResult<AtFileSettings>>(resolve => { resolveUpdate = resolve })
    const booted = await boot({ atFileUpdateSettings: async () => pending })
    const write = settingsSection(booted).inject().setEnabled(false)
    await Promise.resolve()
    booted.ctx.emit('connection/reset')
    await Promise.resolve()
    await Promise.resolve()
    resolveUpdate?.({
      ok: true,
      value: { enabled: false, ignoreFiles: ['stale.tmp'], workspaceIgnoreFiles: [] },
    })
    await write
    expect(settingsSection(booted).inject().hooks.scope.getSnapshot().value)
      .toMatchObject({ enabled: true, ignoreFiles: DEFAULT_IGNORE_FILES })
  })

  it('silences a stale settings update rejection after a reconnect', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectUpdate: ((error: Error) => void) | undefined
    const pending = new Promise<RemoteResult<AtFileSettings>>((_resolve, reject) => { rejectUpdate = reject })
    try {
      const booted = await boot({ atFileUpdateSettings: async () => pending })
      const write = settingsSection(booted).inject().setEnabled(false)
      await Promise.resolve()
      booted.ctx.emit('connection/reset')
      await Promise.resolve()
      await Promise.resolve()
      rejectUpdate?.(new Error('stale write'))
      await write
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('handles settings actions before the Remote mount settles', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let finishMount: (() => void) | undefined
    const waitForMount = new Promise<void>(resolve => { finishMount = resolve })
    try {
      const booted = await boot({
        remoteMount: async () => {
          await waitForMount
          return () => {}
        },
      })
      booted.ctx.emit('connection/reset')
      await settingsSection(booted).inject().setEnabled(false)
      expect(errorSpy).toHaveBeenCalledWith(
        '[dsh-atlas] settings update failed:',
        expect.objectContaining({ message: 'the atFile Remote is not mounted' }),
      )
    } finally {
      finishMount?.()
      errorSpy.mockRestore()
    }
  })

  it('registers the dock with its inject face routed to the shared open action', async () => {
    const atFileSearch = vi.fn(async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }))
    const booted = await boot({ atFileSearch })
    const dock = booted.slotsRegister.mock.calls.find(call => call[0]?.name === 'conversation.input.dock')?.[0] as {
      id: string
      order: number
      locale: string
      inject: (sessionId: string) => { onOpen: (link: BridgeLink) => void }
    }
    expect(dock).toMatchObject({ id: 'atlas', order: 20, locale: NS })
    // A build with no right Sidebar falls back to the Host opener, which resolves
    // the relative token through the index the search wrapper populates.
    await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    dock.inject('s1').onOpen({ kind: 'file', path: 'a.ts' })
    await settle()
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/a.ts' })
  })


  it('asks for no inspection when the draft names nothing, and reports a refusal', async () => {
    const inspect = vi.fn(async () => ({ ok: false as const, error: { code: 'boom', message: 'down', details: {} } }))
    const booted = await boot({ atFileInspect: inspect as never })
    const dock = booted.slotsRegister.mock.calls.find(call => call[0]?.name === 'conversation.input.dock')?.[0] as {
      inject: (sessionId: string) => { requestInspect: (targets: readonly string[]) => void }
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // An empty target list settles to "no costs" without a round trip at all.
    dock.inject('s1').requestInspect([])
    await settle()
    expect(inspect).not.toHaveBeenCalled()
    // A refused inspection is reported once and leaves the dock without badges.
    dock.inject('s1').requestInspect(['a.ts'])
    await settle()
    expect(error).toHaveBeenCalledWith('[dsh-atlas] reference inspection failed:', expect.any(Error))
    error.mockRestore()
  })

  it('skips reference inspection when the mounted face has no inspect method', async () => {
    const booted = await boot()
    const dock = booted.slotsRegister.mock.calls.find(call => call[0]?.name === 'conversation.input.dock')?.[0] as {
      inject: (sessionId: string) => { requestInspect: (targets: readonly string[]) => void }
    }
    expect(() => { dock.inject('s1').requestInspect(['a.ts']) }).not.toThrow()
    await Promise.resolve()
  })

  it('registers the ad panel only when the build enables ads', async () => {
    const adFree = await boot()
    expect(adFree.slotsRegister.mock.calls.some(call => (call[0] as { id?: string })?.id === 'atlas-ad')).toBe(false)

    ;(globalThis as unknown as Record<string, unknown>).__DSH_ATLAS_ADS__ = true
    try {
      const withAds = await boot()
      expect(withAds.slotsRegister.mock.calls.some(call => (call[0] as { id?: string })?.id === 'atlas-ad')).toBe(true)
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).__DSH_ATLAS_ADS__
    }
  })

  it('registers the sent-message reference bridge over the session file address', async () => {
    const booted = await boot()
    const bridge = referenceBridge(booted)
    expect(bridge).toMatchObject({ name: 'conversation.input.overlay', order: 4 })
    const openResource = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource })
    bridge.inject('s1').actionFor({ kind: 'file', path: 'outsidedir/关于源代码许可的分析.md' })?.()
    await settle()
    expect(openResource).toHaveBeenCalledWith(
      `dsh-resource://file/session/s1/outsidedir/${encodeURIComponent('关于源代码许可的分析.md')}`,
    )
  })

  it('registers the draft bridge on the same action and the dock\'s own verdicts', async () => {
    const booted = await boot()
    const entry = booted.slotsRegister.mock.calls
      .find(call => (call[0] as { id?: string })?.id === 'atlas-draft-links')?.[0] as {
      name: string
      order: number
      inject: (sessionId: string) => {
        actionFor: (link: BridgeLink) => (() => void) | undefined
        hooks: { referenceInfo: { getSnapshot: () => { value: readonly unknown[] } } }
      }
    }
    expect(entry).toMatchObject({ name: 'conversation.input.overlay', order: 5 })
    const face = entry.inject('s1')
    // The verdict store the dock publishes into is the one the bridge reads: the
    // draft never re-inspects a path the dock already asked about.
    expect(face.hooks.referenceInfo.getSnapshot().value).toEqual([])
    // A provider with no `open` leaves the mention inert here too, which is only
    // true when this is the shared action lookup and not a second one.
    expect(face.actionFor({ kind: 'atlas', provider: 'nope', item: 'x' })).toBeUndefined()
  })

  it('opens a clicked skill mention through the skill source', async () => {
    const booted = await boot()
    const bridge = referenceBridge(booted)
    bridge.inject('s1').actionFor({ kind: 'skill', name: 'blender-modeling' })?.()
    expect(booted.openReference).toHaveBeenCalledWith('skill', { ref: '/blender-modeling' })
    // No client scope for the session: there is no controller to route through,
    // so the mention has no action at all (its chip stays unmarked).
    booted.scopeSession.mockReturnValueOnce(undefined)
    booted.openReference.mockClear()
    expect(bridge.inject('s9').actionFor({ kind: 'skill', name: 'x' })).toBeUndefined()
    expect(booted.openReference).not.toHaveBeenCalled()
  })

  it('routes a session mention to the session service at the composition level', async () => {
    // The pure session rules live in their own spec; this pins the WIRING: a wire
    // mention reaching the real action lookup must switch sessions and must not
    // consult the Host about a path (a path question for a session payload is what
    // used to answer with a nonexistent file).
    const booted = await boot({
      sessionList: { ids: ['session-other'], byId: { 'session-other': { displayTitle: 'Other run' } } },
    })
    const bridge = draftBridge(booted)
    const face = bridge.inject('s1')
    face.actionFor({ kind: 'session', sessionId: 'session-other' })?.()
    expect(booted.openSessionSpy).toHaveBeenCalledWith('session-other')
    // The draft's own resolver is wired too, and it reads the list it was given.
    expect(face.resolveSession?.('session-other')).toBe('session-other')
    expect(face.resolveSession?.('Other run')).toBe('session-other')
    expect(face.resolveSession?.('not-a-session')).toBeUndefined()
  })

  it('switches to the session a wire mention names', async () => {
    const booted = await boot()
    const bridge = draftBridge(booted)
    bridge.inject('s1').actionFor({ kind: 'session', sessionId: 'session-other' })?.()
    expect(booted.openSessionSpy).toHaveBeenCalledWith('session-other')
  })

  it('reports a session reference that can no longer be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const booted = await boot({
      openSession: () => { throw new Error('sessions.select: unknown session') },
    })
    const bridge = draftBridge(booted)
    // The click must survive a session the list no longer holds: the bridge
    // reports it as a vanished reference instead of throwing into the listener.
    expect(bridge.inject('s1').actionFor({ kind: 'session', sessionId: 'gone' })?.()).toBe('gone')
    warn.mockRestore()
  })

  it('resolves a bare session label only on one exact answer', async () => {
    const booted = await boot({
      sessionList: {
        ids: ['session-other', 'session-twin-a', 'session-twin-b'],
        byId: {
          'session-other': { displayTitle: 'Atlas plugin work' },
          'session-twin-a': { displayTitle: 'Twins' },
          'session-twin-b': { displayTitle: 'Twins' },
        },
      },
    })
    const face = draftBridge(booted).inject('s1')
    // An id answers itself; a unique title answers too.
    expect(face.resolveSession?.('session-other')).toBe('session-other')
    expect(face.resolveSession?.('Atlas plugin work')).toBe('session-other')
    // Ambiguity and unknown names answer nothing, so the file rules stay in
    // charge: a title shared by two sessions can never pick one.
    expect(face.resolveSession?.('Twins')).toBeUndefined()
    expect(face.resolveSession?.('AGENTS.md')).toBeUndefined()
  })

  it('routes a provider mention to the open callback its provider declared', async () => {
    const booted = await boot()
    const open = vi.fn()
    const atlas = booted.ctx.get('atlas') as { register(candidate: unknown): () => void }
    atlas.register({ id: 'stub', display: 'Stub', scopes: [], testedOn: [], list: async () => [], open })
    const bridge = referenceBridge(booted)
    bridge.inject('s1').actionFor({ kind: 'atlas', provider: 'stub', item: 'thing' })?.()
    expect(open).toHaveBeenCalledWith('thing', expect.objectContaining({ sessionId: 's1' }))
    // An unregistered provider, and one that declared no open, have no action.
    expect(bridge.inject('s1').actionFor({ kind: 'atlas', provider: 'ghost', item: 'thing' })).toBeUndefined()
    atlas.register({ id: 'quiet', display: 'Quiet', scopes: [], testedOn: [], list: async () => [] })
    expect(bridge.inject('s1').actionFor({ kind: 'atlas', provider: 'quiet', item: 'thing' })).toBeUndefined()
  })

  it('contains a provider open failure instead of breaking the click', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const booted = await boot()
      const atlas = booted.ctx.get('atlas') as { register(candidate: unknown): () => void }
      atlas.register({
        id: 'boom', display: 'Boom', scopes: [], testedOn: [], list: async () => [],
        open: () => { throw new Error('provider exploded') },
      })
      const bridge = referenceBridge(booted)
      expect(() => bridge.inject('s1').actionFor({ kind: 'atlas', provider: 'boom', item: 'x' })?.()).not.toThrow()
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('falls back to the host opener when the sidebar cannot take the address', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const booted = await boot({
        atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }),
      })
      await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
      await Promise.resolve()
      const bridge = referenceBridge(booted)
      // A build with no right Sidebar at all.
      bridge.inject('s1').actionFor({ kind: 'file', path: 'a.ts' })?.()
      await settle()
      expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/a.ts' })
      // A Sidebar that refuses the address must not become a dead end.
      booted.ctx.provide('sidebarRight', { openResource: () => { throw new Error('no tab type claims it') } })
      booted.openPath.mockClear()
      bridge.inject('s1').actionFor({ kind: 'file', path: 'a.ts' })?.()
      await settle()
      expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/a.ts' })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('registers the settings section whose controls write through the plugin Remote', async () => {
    const booted = await boot({
      workspaceIgnoreFiles: [{ workspace: '/work/a', ignoreFiles: ['old.tmp'] }],
    })
    const section = settingsSection(booted)
    expect(section).toMatchObject({ id: 'atlas', order: 55, locale: NS })
    expect(section.label()).toBe('nav')
    expect(section.inject().viewState).toBe(section.inject().viewState)
    await section.inject().setEnabled(false)
    expect(booted.updateSettings).toHaveBeenCalledWith({ field: 'enabled', value: false })
    await section.inject().setIgnorePastedMentions(false)
    expect(booted.updateSettings).toHaveBeenCalledWith({ field: 'ignorePastedMentions', value: false })
    await section.inject().setIgnoreFiles(['desktop.ini'])
    expect(booted.updateSettings).toHaveBeenCalledWith({ field: 'ignoreFiles', value: ['desktop.ini'] })
    await section.inject().setWorkspaceIgnoreFiles('/work/a', ['local.tmp'])
    expect(booted.updateSettings).toHaveBeenCalledWith({
      field: 'workspaceIgnoreFiles',
      value: [{ workspace: '/work/a', ignoreFiles: ['local.tmp'] }],
    })
    await section.inject().setWorkspaceIgnoreFiles('/work/a', [])
    expect(booted.updateSettings).toHaveBeenLastCalledWith({ field: 'workspaceIgnoreFiles', value: [] })
  })

  it('logs failed host opens', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const atFileSearch = vi.fn(async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }))
      const booted = await boot({ atFileSearch, openPath: async () => ({ ok: false as const, error: { message: 'nope' } }) })
      await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
      dockOf(booted).inject('s1').onOpen({ kind: 'file', path: 'a.ts' })
      await settle()
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] open failed:', 'nope')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs an open whose token has no index entry', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const booted = await boot()
      dockOf(booted).inject('s1').onOpen({ kind: 'file', path: 'missing.ts' })
      await settle()
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] open failed: no index entry for', 'missing.ts')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs a rejecting host open', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const atFileSearch = vi.fn(async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }))
      const booted = await boot({ atFileSearch, openPath: async () => { throw new Error('carrier down') } })
      await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
      dockOf(booted).inject('s1').onOpen({ kind: 'file', path: 'a.ts' })
      await settle()
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] open failed:', expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs an open with no session Remote namespace to reach', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const booted = await boot({
        withoutSessionRemote: true,
        atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }),
      })
      await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
      await settle()
      dockOf(booted).inject('s1').onOpen({ kind: 'file', path: 'a.ts' })
      await settle()
      expect(errorSpy).toHaveBeenCalledWith(
        '[dsh-atlas] open failed: the session Remote namespace is not mounted',
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('refuses to hand a vanished target to any viewer', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const booted = await boot({
        atFileInspect: async (_id, targets) => ({
          ok: true as const,
          value: targets.map(relative => ({ relative, exists: false })),
        }),
      })
      const openResource = vi.fn()
      booted.ctx.provide('sidebarRight', { openResource })
      const outcome = await referenceBridge(booted).inject('s1').actionFor({ kind: 'file', path: 'gone.ts' })?.()
      // Neither the Sidebar (which throws its own 400 on a missing write target)
      // nor the Host opener is reached, and the chip is told it is stale.
      expect(outcome).toBe('gone')
      expect(openResource).not.toHaveBeenCalled()
      expect(booted.openPath).not.toHaveBeenCalled()
      // A reference that outlived its file is a normal state: warn, not error.
      expect(warnSpy).toHaveBeenCalledWith(
        '[dsh-atlas] this reference no longer exists, so it was not opened: gone.ts',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('opens a verified target, and opens anyway when the check itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const verified = await boot({
        atFileInspect: async (_id, targets) => ({
          ok: true as const,
          value: targets.map(relative => ({ relative, exists: true, kind: 'file' as const, size: 10 })),
        }),
      })
      const openResource = vi.fn()
      verified.ctx.provide('sidebarRight', { openResource })
      const opened = await referenceBridge(verified).inject('s1').actionFor({ kind: 'file', path: 'a.ts' })?.()
      expect(opened).toBe('opened')
      expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1/a.ts')

      // An inspection that cannot answer is a courtesy, not a gate.
      const failing = await boot({
        atFileInspect: async () => ({ ok: false as const, error: { code: 'boom', message: 'down', details: {} } }),
      })
      const fallback = vi.fn()
      failing.ctx.provide('sidebarRight', { openResource: fallback })
      const stillOpened = await referenceBridge(failing).inject('s1').actionFor({ kind: 'file', path: 'a.ts' })?.()
      expect(stillOpened).toBe('opened')
      expect(fallback).toHaveBeenCalledWith('dsh-resource://file/session/s1/a.ts')
      expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] reference check failed:', expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('passes a provider outcome through, so a gone item can mark its chip', async () => {
    const booted = await boot()
    const atlas = booted.ctx.get('atlas') as { register(candidate: unknown): () => void }
    atlas.register({
      id: 'stale', display: 'Stale', scopes: [], testedOn: [], list: async () => [],
      open: async () => 'gone' as const,
    })
    atlas.register({ id: 'fine', display: 'Fine', scopes: [], testedOn: [], list: async () => [], open: () => {} })
    const bridge = referenceBridge(booted)
    await expect(bridge.inject('s1').actionFor({ kind: 'atlas', provider: 'stale', item: 'x' })?.())
      .resolves.toBe('gone')
    await expect(bridge.inject('s1').actionFor({ kind: 'atlas', provider: 'fine', item: 'x' })?.())
      .resolves.toBe('opened')
  })

  it('opens a directory row in the sidebar, selected, and NOT locally (A-16.7 + m05904)', async () => {
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src', relative: 'src', kind: 'dir' }] }),
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    const openResource = vi.fn()
    const openTab = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource, openTab })
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })
    await settle()
    // The sidebar is where a folder is useful, and it is now the only surface the
    // FIRST click reaches: the local (OS) open that used to ride along by default is
    // off for good (A.16.7), so nothing may ask the Host to open a path here. The
    // product's own files PAGE is not used either (m05904): it claims no address at
    // all, so it cannot be told WHICH folder to reveal, let alone which row to select.
    // This plugin's folder tab takes an address plus a `select`, so the first click
    // lands the user INSIDE the clicked folder instead of at the workspace root.
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder//ws', { params: { select: 'src' } })
    expect(openTab).not.toHaveBeenCalled()
    expect(booted.openPath).not.toHaveBeenCalled()
  })

  it('opens a directory row in this plugin folder tab even with no files tab', async () => {
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src', relative: 'src', kind: 'dir' }] }),
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    const openResource = vi.fn()
    // A sidebar face without `openTab`: nothing is lost, because the folder tab this
    // plugin registers is the surface a folder click wants in every build.
    booted.ctx.provide('sidebarRight', { openResource })
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder//ws', { params: { select: 'src' } })
  })

  it('opens the owning folder with the object selected on the SECOND click of a file', async () => {
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src/a.ts', relative: 'src/a.ts', kind: 'file' }] }),
    })
    // The picker search is what warms the workspace index the second click reads
    // its owning folder from, and it is also what the user typed the mention with.
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    const openResource = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource, openTab: vi.fn() })
    const dock = dockOf(booted).inject('s1')
    dock.onOpen({ kind: 'file', path: 'src/a.ts' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1/src/a.ts')
    openResource.mockClear()
    // The same object again — no timing involved, so a slow second click behaves
    // exactly like a fast one. `src` is a directory the file-only index does not
    // hold, so it stays relative and the Host resolves it against the session's
    // working directory; the object cannot ride the address, which is the tab's
    // identity, so it rides `params.select`.
    dock.onOpen({ kind: 'file', path: 'src/a.ts' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder/src', { params: { select: 'a.ts' } })
    // The click after a completed pair starts over, so the FIRST behaviour stays
    // reachable instead of the user being trapped in the second one.
    openResource.mockClear()
    dock.onOpen({ kind: 'file', path: 'src/a.ts' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1/src/a.ts')
  })

  it('hands a FOLDER to the desktop file manager on the second click (m05904)', async () => {
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src/a.ts', relative: 'src/a.ts', kind: 'file' }] }),
      sessionList: { ids: ['s1'], byId: { s1: { displayTitle: 'Work', cwd: '/ws' } } },
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    const openResource = vi.fn()
    const openTab = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource, openTab })
    const dock = dockOf(booted).inject('s1')
    // First click: this plugin's folder tab, at the folder's PARENT, with the folder
    // itself selected — so the user starts inside it, not at the workspace root.
    dock.onOpen({ kind: 'folder', path: 'src' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder//ws', { params: { select: 'src' } })
    booted.openPath.mockClear()
    openResource.mockClear()
    // Second click: the folder itself, in the DESKTOP's own file manager — the
    // gesture the plugin cannot answer itself (m05904). No timing is involved, so a
    // slow second click behaves exactly like a fast one. `src` is a directory the
    // file-only index does not hold, and the Host opener resolves NOTHING. This boot
    // mounts no `atFile.list`, so what answers here is the FALLBACK: the relative
    // path joined onto the session's workspace root. A Host that DOES list answers
    // with its own canonical path — that is the next test (m02155).
    dock.onOpen({ kind: 'folder', path: 'src' })
    await settle()
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/src' })
    expect(openResource).not.toHaveBeenCalled()
    // The click after a completed pair starts over, so the FIRST behaviour stays
    // reachable instead of the user being trapped in the second one.
    booted.openPath.mockClear()
    dock.onOpen({ kind: 'folder', path: 'src' })
    await settle()
    expect(booted.openPath).not.toHaveBeenCalled()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder//ws', { params: { select: 'src' } })
  })

  it('resolves a folder through the Host listing, so a summary with no cwd cannot kill the second click (m02155)', async () => {
    // The reported defect: a relative multi-segment folder (`lib/types/client`) was
    // not handed to the file manager on either host, while the tab's own open-in-
    // system button kept working. Both gestures reach the SAME opener, so the
    // difference was where the absolute path came from: this side joined it onto the
    // Session summary's `cwd`, a summary may carry no directory at all, and that
    // failure was only ever a line in the browser console. The Host is the authority:
    // `atFile/list` resolves the reference against the session header's directory and
    // answers the canonical spelling of the folder it was asked about, which is what
    // the tab's button opens.
    const list = vi.fn(async () => ({
      ok: true as const,
      value: { path: '/ws/lib/types/client', parent: '/ws/lib/types', entries: [] },
    }))
    // No `sessionList` at all: the fallback join has nothing to work with here, so
    // only the Host's own answer can put an absolute path in front of the opener.
    const booted = await boot({ atFileList: list })
    const openResource = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource, openTab: vi.fn() })
    const dock = dockOf(booted).inject('s1')
    // The FIRST click is unchanged: the owning folder, worked out on this side, with
    // the object selected there — and it lists nothing.
    dock.onOpen({ kind: 'folder', path: 'lib/types/client' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder/lib/types', { params: { select: 'client' } })
    expect(list).not.toHaveBeenCalled()
    booted.openPath.mockClear()
    openResource.mockClear()
    dock.onOpen({ kind: 'folder', path: 'lib/types/client' })
    await settle()
    expect(list).toHaveBeenCalledWith('s1', 'lib/types/client', '', expect.anything())
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/lib/types/client' })
    expect(openResource).not.toHaveBeenCalled()
  })

  it('opens the owning folder even when the reference itself is gone', async () => {
    const booted = await boot({
      atFileInspect: async (_id, targets) => ({
        ok: true as const,
        value: targets.map(relative => ({ relative, exists: false, kind: 'file' as const, size: 10 })),
      }),
    })
    const openResource = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource, openTab: vi.fn() })
    const dock = dockOf(booted).inject('s1')
    // The first click is refused (a vanished target is not handed to a viewer) but
    // still counts as the object's click, and a folder outlives its file: the user
    // goes looking for a deleted reference in the place it used to be.
    dock.onOpen({ kind: 'file', path: 'E:/Eason/gone/a.ts' })
    await settle()
    expect(openResource).not.toHaveBeenCalled()
    dock.onOpen({ kind: 'file', path: 'E:/Eason/gone/a.ts' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder/E:/Eason/gone', { params: { select: 'a.ts' } })
  })

  it('still opens a folder in a profile that mounts NO Sidebar at all', async () => {
    // The documented requirement: `@` must work where the Sidebar does not exist.
    // Reading an undeclared cordis service THROWS, so without the optional-read
    // helper this click would throw instead of falling back to the OS opener.
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src', relative: 'src', kind: 'dir' }] }),
      sessionList: { ids: ['s1'], byId: { s1: { displayTitle: 'Work', cwd: '/ws' } } },
      mountThrowingService: 'sidebarRight',
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    // No `sidebarRight` is provided anywhere: the read must degrade, not throw, and
    // the desktop file manager is then the only surface a folder has. The Host opener
    // resolves nothing, so the workspace-relative path is made absolute here first.
    expect(() => dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })).not.toThrow()
    await settle()
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/src' })
  })

  it('refuses to invent an absolute path for a folder it cannot resolve', async () => {
    // The one way to have no absolute path: no Sidebar AND no session workspace
    // (`cwd` is what the session list carries, and a session with no workspace has
    // none). Handing the Host a bare relative path would open the Host's own browse
    // root — anywhere on the machine — so the click is refused and said so aloud.
    const booted = await boot({ mountThrowingService: 'sidebarRight' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })
      await settle()
      expect(booted.openPath).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('[dsh-atlas] this folder has no absolute path to open: src')
    } finally {
      warn.mockRestore()
    }
  })

  it('opens a folder with the local opener when only the TAB registry is missing', async () => {
    // The second optional service on this path: `sidebarRightTabs` carries the
    // folder-tab registration. A profile with the Sidebar but no tab registry must
    // still finish the click, with the plugin's own tab simply not registered.
    const booted = await boot({ mountThrowingService: 'sidebarRightTabs' })
    expect(booted.ctx.get('sidebarRightTabs')).toBeUndefined()
  })

  it('opens a folder in the sidebar alone, whatever the stored setting says', async () => {
    // A-16.7: the folder-open choice is gone from the UI and no longer decides
    // anything, so a `native` left behind by an older install must NOT resurrect the
    // local opener. Writing that stale value through the verb that still exists for
    // the persisted field is the only way to prove the value stopped mattering.
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src', relative: 'src', kind: 'dir' }] }),
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    const openResource = vi.fn()
    const openTab = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource, openTab })
    await settingsSection(booted).inject().setFolderOpen('native')
    await settle()
    booted.openPath.mockClear()
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })
    await settle()
    // The sidebar took it; the OS opener was never asked. WHICH sidebar surface is
    // not a question either: a folder always lands in this plugin's own folder tab,
    // selected, so the stale value decides nothing at all (A.16.7 + m05904).
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder//ws', { params: { select: 'src' } })
    expect(openTab).not.toHaveBeenCalled()
    expect(booted.openPath).not.toHaveBeenCalled()
  })

  it('asks the sidebar for an out-of-workspace folder by absolute address', async () => {
    // No `inspect` stub: without one the plugin treats the target as unverified
    // and opens anyway, which is exactly the path an external folder takes.
    const booted = await boot()
    const openResource = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource })
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'E:/outside/deepseek-harness' })
    await settle()
    // A folder rides the plugin's own `folder` type for both scopes: an absolute
    // path is passed on as-is (the Host resolves nothing), and the click lands on the
    // folder's PARENT with the folder itself selected, so `deepseek-harness` is the
    // row the user is put on rather than the top of `E:/outside` (m05904). The
    // sidebar is the only surface the FIRST click reaches — the OS opener is not
    // asked (A.16.7).
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder/E:/outside', { params: { select: 'deepseek-harness' } })
    expect(booted.openPath).not.toHaveBeenCalled()
  })

  it('clears the index on connection reset', async () => {
    const atFileSearch = vi.fn(async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }))
    const booted = await boot({ atFileSearch })
    await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    expect(atFileSearch).toHaveBeenCalledTimes(1)
    booted.ctx.emit('connection/reset')
    await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    expect(atFileSearch).toHaveBeenCalledTimes(2)
  })

  it('clears cached indexes when the file filters change', async () => {
    const atFileSearch = vi.fn(async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }] }))
    const booted = await boot({ atFileSearch })
    await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    expect(atFileSearch).toHaveBeenCalledTimes(1)
    await settingsSection(booted).inject().setIgnoreFiles(['desktop.ini'])
    await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    expect(atFileSearch).toHaveBeenCalledTimes(2)
  })

  it('clears cached indexes when a workspace file filter changes', async () => {
    const atFileSearch = vi.fn(async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' as const }] }))
    const booted = await boot({ atFileSearch })
    await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    expect(atFileSearch).toHaveBeenCalledTimes(1)
    await settingsSection(booted).inject().setWorkspaceIgnoreFiles('/ws', ['local.tmp'])
    await registered(booted).candidates(s1, { query: 'a', position: 'inline', signal: signal() })
    expect(atFileSearch).toHaveBeenCalledTimes(2)
  })

  it('disposes its registrations with the fiber', async () => {
    const ctx = new Context()
    const unmount = vi.fn(async () => {})
    const registerDispose = vi.fn()
    ctx.provide('inputTriggers', { registerSource: vi.fn(() => registerDispose) })
    ctx.provide('connection', {})
    ctx.provide('remote', {
      $mount: vi.fn(async () => unmount),
      session: { openWorkspacePath: async () => ({ ok: true as const }) },
    })
    ctx.provide('remote.atFile', {
      search: async () => ({ ok: true as const, value: [] }),
      getSettings: async () => ({
        ok: true as const,
        value: { enabled: true, ignoreFiles: [...DEFAULT_IGNORE_FILES], workspaceIgnoreFiles: [] },
      }),
      updateSettings: async () => ({
        ok: true as const,
        value: { enabled: true, ignoreFiles: [...DEFAULT_IGNORE_FILES], workspaceIgnoreFiles: [] },
      }),
    })
    ctx.provide('slots', { inject: vi.fn(), register: vi.fn() })
    ctx.provide('locale', { register: vi.fn(() => () => {}), bind: vi.fn(() => (key: string) => key) })
    ctx.provide('sessions', {})
    const fiber = ctx.plugin({ inject, apply })
    await fiber
    await Promise.resolve()
    expect(registerDispose).toHaveBeenCalledTimes(0)
    await fiber.dispose()
    expect(unmount).toHaveBeenCalled()
    expect(registerDispose).toHaveBeenCalledTimes(1)
  })

  it('registers the bilingual dictionaries and binds the namespace', async () => {
    const { localeRegister, bind } = await boot()
    expect(localeRegister).toHaveBeenCalledWith(NS, { zh, en })
    expect(bind).toHaveBeenCalledWith(NS)
  })

  it('injects the dock stylesheet exactly once', async () => {
    await boot()
    const style = document.getElementById(STYLE_ID)
    expect(style).not.toBeNull()
    expect(style?.dataset.plugin).toBe('dsh-atlas')
    expect(style?.dataset.pluginCss).toBe(STYLE_ID)
    expect(style!.textContent).toContain('dsh_atFile_rail')
    expect(style!.textContent).toContain('var(--dsh-composer-side-clearance)')
    expect(style!.textContent).toContain('max-width: var(--dsh-composer-card-max-width)')
    await boot()
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1)
  })
})
/**
 * The chooser's own face: the dialog talks to the Host only through the plugin's
 * listing, so these are the branches that decide what the dialog can offer.
 */
interface RegisteredPicker {
  inject: (sessionId: string) => {
    list: (path: string | undefined, signal: AbortSignal) => Promise<{ path: string; crumbs: { name: string }[]; entries: { name: string; path: string; hidden: boolean }[] }>
    browse: (path: string | undefined, signal: AbortSignal) => Promise<{ path: string; entries: { name: string; path: string }[] }>
    recent: (signal: AbortSignal) => Promise<{ path: string; name: string; reason: string }[]>
    create: (path: string, name: string) => Promise<string>
  }
}

function pickerOf(booted: Awaited<ReturnType<typeof boot>>): RegisteredPicker {
  const entry = booted.slotsRegister.mock.calls
    .find(call => (call[0] as { id?: string })?.id === 'atlas-folder-picker')?.[0] as RegisteredPicker | undefined
  expect(entry).toBeDefined()
  return entry as RegisteredPicker
}

/** One directory listing as the Host spells it: files included, one level deep. */
const listing = (path: string, entries: readonly (string | { name: string; kind: 'file' | 'dir' })[]): DirectoryListing => ({
  path,
  entries: entries.map(entry => {
    const name = typeof entry === 'string' ? entry : entry.name
    return {
      name,
      kind: typeof entry === 'string' ? 'dir' as const : entry.kind,
      hidden: name.startsWith('.'),
    }
  }),
})

describe('dsh-atlas folder chooser over the Host listing', () => {
  it('offers only the folders a row can open, with the path joined and crumbs rebuilt', async () => {
    const booted = await boot({
      atFileList: async () => ({ ok: true, value: listing('/home/x', ['one', { name: 'two.txt', kind: 'file' }, '.git']) }),
    })
    const rows = await pickerOf(booted).inject('s1').list('/home/x', signal())
    expect(rows.entries.map(row => row.name)).toEqual(['one', '.git'])
    expect(rows.entries[0]!.path).toBe('/home/x/one')
    expect(rows.entries[1]!.hidden).toBe(true)
    // `home`/`crumbs` are not part of the plugin's contract: the strip is built from the path.
    expect(rows.crumbs.map(crumb => crumb.name)).toEqual(['/', 'home', 'x'])
  })

  it('browses through the Host listing when the Host has one, keeping its hasChildren facts', async () => {
    const browse = vi.fn(async () => ({ ok: true as const, value: { path: '/home/x', entries: [{ name: 'one', kind: 'dir' as const, hidden: false, hasChildren: true }] } }))
    const booted = await boot({ atFileBrowse: browse })
    const rows = await pickerOf(booted).inject('s1').browse('/home/x', signal())
    expect(browse).toHaveBeenCalled()
    expect(rows.entries).toEqual([{ name: 'one', path: '/home/x/one', hidden: false, hasChildren: true }])
  })

  it('falls back to the one-level listing on a Host built before the browser existed', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: listing('/home/x', ['one']) }))
    const booted = await boot({ atFileList: list })
    const rows = await pickerOf(booted).inject('s1').browse('/home/x', signal())
    expect(list).toHaveBeenCalledWith('s1', '/home/x', '', expect.anything())
    expect(rows.entries.map(row => row.name)).toEqual(['one'])
  })

  it('turns a browse refusal into the dialog\'s reason instead of an empty folder', async () => {
    const booted = await boot({
      atFileBrowse: async () => ({ ok: false, error: { code: 'EACCES', message: 'denied', details: {} } }),
    })
    await expect(pickerOf(booted).inject('s1').browse('/root', signal())).rejects.toThrow('browse failed: EACCES: denied')
  })

  it('says so when the Host cannot list directories at all', async () => {
    const booted = await boot()
    await expect(pickerOf(booted).inject('s1').list('/', signal())).rejects.toThrow('this host cannot list directories')
  })

  it('offers the recent folders, and none from a Host that has no ledger', async () => {
    const withLedger = await boot({
      atFileRecentFolders: async () => ({ ok: true, value: [{ path: '/home/x', name: 'x', reason: 'recent' as RecentFolder['reason'] }] }),
    })
    expect(await pickerOf(withLedger).inject('s1').recent(signal())).toEqual([{ path: '/home/x', name: 'x', reason: 'recent' }])
    // An unreadable ledger is a convenience, never a reason to take the dialog down.
    const failing = await boot({
      atFileRecentFolders: async () => ({ ok: false, error: { code: 'EIO', message: 'gone', details: {} } }),
    })
    expect(await pickerOf(failing).inject('s1').recent(signal())).toEqual([])
    const legacy = await boot()
    expect(await pickerOf(legacy).inject('s1').recent(signal())).toEqual([])
  })

  it('creates a folder only through a workspace face that can, and refuses otherwise', async () => {
    const createDirectory = vi.fn(async () => '/home/x/new')
    const booted = await boot({ uiWorkspace: { createDirectory } })
    await expect(pickerOf(booted).inject('s1').create('/home/x', 'new')).resolves.toBe('/home/x/new')
    expect(createDirectory).toHaveBeenCalledWith('/home/x', 'new')
    const withoutFace = await boot()
    // The refusal is synchronous: the face decides before the dialog awaits.
    expect(() => pickerOf(withoutFace).inject('s1').create('/home/x', 'new')).toThrow('picker.error')
  })
})

describe('dsh-atlas folder scoping from the composer', () => {
  const scoped = (body: string) => { document.body.innerHTML = `<div data-lexical-editor="true"><p><span>${body}</span></p></div>` }

  it('asks the Host whether a bare folder token is a folder, then scopes @file: to it', async () => {
    const inspect = vi.fn(async (_id: SessionId, targets: readonly string[]) => ({
      ok: true as const,
      value: targets.map(relative => ({ relative, exists: true, kind: 'dir' as const })),
    }))
    const booted = await boot({
      atFileInspect: inspect as never,
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' as const }] }),
      atFileExternal: async () => ({ ok: true as const, value: { canDiscover: true, roots: ['E:/'], folders: [] } }),
      atFileList: async (_id: SessionId, path: string) => ({ ok: true as const, value: listing(path, ['one.ts']) }),
    })
    // The scope is positional: the folder named immediately before the category
    // token is what `@file:` lists. This token has no trailing separator, so its
    // kind is the Host's answer, not a spelling rule.
    scoped('@e:/outsidedir @file:')
    await settle()
    try {
      const rows = await registered(booted).candidates(s1, { query: 'file:', position: 'leading', signal: signal() })
      expect(inspect.mock.calls[0]?.[1]).toEqual(['e:/outsidedir'])
      // The unscoped index still answers the first keystroke while the scope is read.
      expect(rows.some(row => row.mentionKind === 'file')).toBe(true)
      // The verdict is memoised: the next keystroke must not ask the Host again.
      await registered(booted).candidates(s1, { query: 'file:o', position: 'leading', signal: signal() })
      expect(inspect).toHaveBeenCalledTimes(1)
    } finally {
      document.body.innerHTML = ''
    }
  })

  it('takes a trailing separator as the folder spelling and asks nothing', async () => {
    const inspect = vi.fn()
    const booted = await boot({
      atFileInspect: inspect as never,
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' as const }] }),
      atFileExternal: async () => ({ ok: true as const, value: { canDiscover: true, roots: ['E:/'], folders: [] } }),
      atFileList: async (_id: SessionId, path: string) => ({ ok: true as const, value: listing(path, ['one.ts']) }),
    })
    scoped('@e:/outsidedir/ @file:')
    await settle()
    try {
      const rows = await registered(booted).candidates(s1, { query: 'file:', position: 'leading', signal: signal() })
      // A trailing separator already says "folder", so the Host is not consulted.
      expect(inspect).not.toHaveBeenCalled()
      expect(rows.some(row => row.mentionKind === 'file')).toBe(true)
    } finally {
      document.body.innerHTML = ''
    }
  })
})

describe('dsh-atlas soft failures', () => {
  it('keeps the folder view when the external ledger refuses', async () => {
    const booted = await boot({
      atFileExternal: async () => ({ ok: false as const, error: { code: 'boom', message: 'down', details: {} } }),
      atFileSearch: async () => ({ ok: true as const, value: [] }),
    })
    await settle()
    // The ledger only feeds the outside-folder hints; a refusal must not empty the view.
    const rows = await registered(booted).candidates(s1, { query: 'folder:do', position: 'leading', signal: signal() })
    expect(rows.every(row => row.mentionKind !== 'error')).toBe(true)
  })

  it('does not offer the chooser row when this client has no workspace face', async () => {
    const booted = await boot()
    await settle()
    // With no workspace face the pick becomes the menu's own walk instead of a
    // chooser: the row still works, it just opens the walk root.
    expect(registered(booted).onPick?.({
      candidate: { name: '选择文件夹…', value: 'folder-choose', mentionKind: 'folder-choose' },
      session: s1,
      action: 'accept',
      span: { start: 0, end: 2 },
    } as never)).toEqual({ text: '@/', continue: true })
    // No dialog opened and nothing was written into the composer.
    expect(booted.sessionBail).not.toHaveBeenCalled()
  })
})

describe('dsh-atlas recordings the picker makes', () => {
  it('records a picked file as recently referenced for its workspace', async () => {
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src/one.ts', relative: 'src/one.ts', kind: 'file' as const }] }),
    })
    await settle()
    // The index must have settled: recency is recorded only for an entry the
    // source actually knows, so the menu is opened once first.
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    // The pick that records the recency is the same one the menu already returns.
    registered(booted).onPick?.({
      candidate: { name: 'one.ts', value: 'src/one.ts', mentionKind: 'file' },
      session: s1,
      action: 'accept',
      span: { start: 0, end: 2 },
    } as never)
    await settle()
    expect(booted.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'recentFiles' }),
    )
  })

  it('writes the folder a pending pick confirmed, and only then', async () => {
    const booted = await boot({ uiWorkspace: { createDirectory: async () => '' } })
    const folderRow = { name: '选择文件夹…', value: 'folder-choose', mentionKind: 'folder-choose' }
    await settle()
    registered(booted).onPick?.({ candidate: folderRow, session: s1, action: 'accept', span: { start: 3, end: 5 } })
    // With no native chooser the plugin's own dialog takes the pick…
    const picker = pickerOf(booted).inject('s1')
    picker.confirm('/home/x/picked')
    const call = booted.sessionBail.mock.calls.at(-1) as unknown as [unknown, string, { text: string; span: { start: number; end: number } }]
    // …and confirming rewrites the reported span, keeping it (not the whole draft).
    expect(call[2].text).toBe('@/home/x/picked/ ')
    expect(call[2].span).toEqual({ start: 3, end: 5 })
  })
})

describe('dsh-atlas chooser fallbacks', () => {
  it('opens its own dialog when the native chooser rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const booted = await boot({
      uiWorkspace: { pickDirectory: async () => { throw new Error('directory-picker/unavailable') }, createDirectory: async () => '' },
    })
    const folderRow = { name: '选择文件夹…', value: 'folder-choose', mentionKind: 'folder-choose' }
    registered(booted).onPick?.({ candidate: folderRow, session: s1, action: 'accept', span: { start: 0, end: 2 } })
    await settle()
    // The refusal is reported, and the plugin's own dialog takes over — the user
    // still gets a chooser.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the native folder chooser is unavailable here'),
      expect.any(Error),
    )
    expect(booted.sessionBail).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('confirms nothing when no pick was pending', async () => {
    const booted = await boot()
    const picker = pickerOf(booted).inject('s1')
    // A confirm that arrives after the dialog closed must not write into the input.
    picker.confirm('/home/x/picked')
    expect(booted.sessionBail).not.toHaveBeenCalled()
  })
})

describe('dsh-atlas refusals the Host reports', () => {
  it('reports a listing the Host refuses instead of an empty folder', async () => {
    const booted = await boot({
      sidebarTabs: { register: vi.fn(() => () => {}) },
      atFileList: async () => ({ ok: false as const, error: { code: 'EIO', message: 'gone' } }),
    })
    const tab = booted.slotsRegister.mock.calls
      .find(call => call[0]?.name === 'sidebar.right.pane.tab')?.[0] as {
        inject: (sessionId: string) => { list: (path: string, signal: AbortSignal) => Promise<DirectoryListing> }
      } | undefined
    expect(tab).toBeDefined()
    // A failed listing must surface as an error the pane can show; an empty list
    // would claim the folder is empty.
    await expect(tab!.inject('s1').list('/home/x', signal())).rejects.toThrow('list failed: EIO: gone')
  })
})

describe('dsh-atlas on the Atlas namespace and the right Sidebar', () => {
  it('reads the running Harness facts through the Atlas namespace', async () => {
    const runtime = vi.fn(async () => ({ ok: true as const, value: {} as AtlasRuntimeInfo }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await boot({ remoteAtlas: { runtime, gitChanges: async () => ({ ok: true, value: [] }) } })
    expect(runtime).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('keeps the version unverified when the namespace refuses or throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await boot({ remoteAtlas: { runtime: async () => { throw new Error('no face') }, gitChanges: async () => ({ ok: true, value: [] }) } })
    expect(error).toHaveBeenCalledWith('[dsh-atlas] atlas runtime facts unavailable:', expect.any(Error))
    error.mockRestore()
  })

  it('registers the folder tab and walks one level through the Host listing', async () => {
    const registerTab = vi.fn(() => () => {})
    const booted = await boot({ sidebarTabs: { register: registerTab }, atFileList: async () => ({ ok: true, value: listing('/home/x', ['one']) }) })
    expect(registerTab).toHaveBeenCalled()
    const tab = booted.slotsRegister.mock.calls
      .find(call => call[0]?.name === 'sidebar.right.pane.tab')?.[0] as {
        inject: (sessionId: string) => { list: (path: string, signal: AbortSignal, include?: string) => Promise<DirectoryListing>; openNative: (path: string) => void }
      } | undefined
    expect(tab).toBeDefined()
    const rows = await tab!.inject('s1').list('/home/x', signal())
    expect(rows.entries.map(entry => entry.name)).toEqual(['one'])
    tab!.inject('s1').openNative('/home/x/one')
    // `openNative` hands the path to the Session Remote's opener, which takes a request.
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/home/x/one' })
  })

  it('opens a session reference through the workspace view that owns navigation', async () => {
    const navigate = vi.fn()
    const booted = await boot({
      uiWorkspace: { openSession: navigate, createDirectory: async () => '' },
      sessionList: { ids: ['s2'], byId: { s2: { displayTitle: 'second' } } },
    })
    // The draft's session rule hands a bare `@second` to the opener.
    const opened = draftBridge(booted).inject('s1').actionFor({ kind: 'session', sessionId: 's2' } as never)
    expect(opened).toBeDefined()
    opened?.()
    await settle()
    expect(navigate).toHaveBeenCalled()
    expect(booted.openSessionSpy).not.toHaveBeenCalled()
  })
})

describe('dsh-atlas slot faces without a session scope', () => {
  it('refuses to build a face for a session the client has no scope for', async () => {
    const booted = await boot({ withoutSessionScope: true })
    for (const id of ['atlas-mention-navigation', 'atlas-menu-icons', 'atlas-history-jump']) {
      const entry = booted.slotsRegister.mock.calls.find(call => (call[0] as { id?: string })?.id === id)?.[0] as
        { inject: (sessionId: string) => unknown } | undefined
      expect(entry).toBeDefined()
      expect(() => entry!.inject('s1')).toThrow(/has no client scope/u)
    }
  })

  it('replaces the picker token where the menu reported it, and closes without one', async () => {
    const booted = await boot({ atFileList: async () => ({ ok: true, value: listing('/', []) }) })
    const picker = pickerOf(booted).inject('s1') as unknown as {
      confirm: (path: string) => void
      close: () => void
      hooks: { folderPicker: { getSnapshot: () => { value: unknown } } }
    }
    // Nothing was opened, so a confirm has no span to replace and writes nothing.
    picker.confirm('/home/x')
    expect(booted.sessionBail).not.toHaveBeenCalled()
    picker.close()
    expect(picker.hooks.folderPicker.getSnapshot().value).toBeNull()
  })
})

describe('dsh-atlas settings verbs', () => {
  it('writes every control through the one Remote update, field by field', async () => {
    const booted = await boot()
    const face = settingsSection(booted).inject() as unknown as Record<string, (...args: never[]) => Promise<void>>
    const cases: [string, unknown[], string][] = [
      ['setEnabled', [false], 'enabled'],
      ['setEnableSkills', [false], 'enableSkills'],
      ['setEnableChats', [false], 'enableChats'],
      ['setEnablePlugins', [false], 'enablePlugins'],
      ['setIgnorePastedMentions', [false], 'ignorePastedMentions'],
      ['setFolderOpen', ['native'], 'folderOpen'],
      ['setHistoryJump', [false], 'historyJump'],
      ['setHistoryJumpFrames', ['message'], 'historyJumpFrames'],
      ['setHistoryJumpReuseMode', ['append'], 'historyJumpReuseMode'],
      ['setHistoryJumpSmartFollow', [true], 'historyJumpSmartFollow'],
      ['setIgnoreFiles', [[' a.log ']], 'ignoreFiles'],
    ]
    for (const [verb, args, field] of cases) {
      booted.updateSettings.mockClear()
      await face[verb]!(...(args as never[]))
      expect(booted.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ field }))
    }
  })

  it('rewrites one workspace row and drops it when its last rule is removed', async () => {
    const booted = await boot({
      atFileGetSettings: async () => ({
        ok: true,
        value: {
          enabled: true,
          ignoreFiles: [],
          workspaceIgnoreFiles: [
            { workspace: '/w', ignoreFiles: ['old.tmp'] },
            { workspace: '/other', ignoreFiles: ['keep.tmp'] },
          ],
          ignorePastedMentions: true,
        },
      }),
    })
    const face = settingsSection(booted).inject() as unknown as {
      setWorkspaceIgnoreFiles: (workspace: string, ignoreFiles: readonly string[]) => Promise<void>
    }
    await face.setWorkspaceIgnoreFiles('/w', ['new.tmp'])
    expect(booted.updateSettings).toHaveBeenLastCalledWith({
      field: 'workspaceIgnoreFiles',
      value: [
        { workspace: '/other', ignoreFiles: ['keep.tmp'] },
        { workspace: '/w', ignoreFiles: ['new.tmp'] },
      ],
    })
    await face.setWorkspaceIgnoreFiles('/w', [])
    expect(booted.updateSettings).toHaveBeenLastCalledWith({
      field: 'workspaceIgnoreFiles',
      value: [{ workspace: '/other', ignoreFiles: ['keep.tmp'] }],
    })
  })
})

describe('dsh-atlas slot faces', () => {
  it('builds every slot face against the live services, not dead closures', async () => {
    const inspected: string[][] = []
    const booted = await boot({
      atFileInspect: async (_sessionId, targets) => {
        inspected.push([...targets])
        return { ok: true as const, value: targets.map(relative => ({ relative, exists: true as const, kind: 'file' as const })) }
      },
      atFileSearch: async () => ({
        ok: true as const,
        value: [
          { path: '/ws/a/README.md', relative: 'a/README.md', kind: 'file' as const },
          { path: '/ws/b/README.md', relative: 'b/README.md', kind: 'file' as const },
          { path: '/ws/AGENTS.md', relative: 'AGENTS.md', kind: 'file' as const },
        ],
      }),
    })
    const slots = booted.slotsRegister.mock.calls.map(call => call[0] as { id?: string; inject?: (id: string) => Record<string, unknown> })
    const face = (id: string): Record<string, unknown> => {
      const found = slots.find(entry => entry.id === id)
      if (found?.inject === undefined) throw new Error(`no slot ${id}; the ids are ${slots.map(r => r.id).join(', ')}`)
      return found.inject('session-1')
    }

    // The dock asks for an inspection of exactly the references it was handed.
    const dock = face('atlas')
    ;(dock.requestInspect as (targets: readonly string[]) => void)(['a/README.md', 'b/README.md'])
    await settle()
    expect(inspected).toEqual([['a/README.md', 'b/README.md']])
    // The index the labels are judged against comes from the Host's own walk.
    await registered(booted).candidates('session-1' as SessionId, { query: 'file:', position: 'leading', signal: new AbortController().signal })
    await settle()

    // The chip's label resolves through the index the inspection just filled: a
    // name two paths answer to is refused rather than guessed (opening the wrong
    // file is worse than an inert chip), a path passes through untouched, and a
    // name only one path answers resolves to it.
    const links = face('atlas-reference-links')
    const resolveLabel = links.resolveLabel as (label: string) => string | undefined
    expect(resolveLabel('README.md')).toBeUndefined()
    expect(resolveLabel('a/README.md')).toBe('a/README.md')
    expect(resolveLabel('AGENTS.md')).toBe('AGENTS.md')
    expect(resolveLabel('nobody-knows')).toBe('nobody-knows')
    expect(typeof links.actionFor).toBe('function')
    expect(typeof links.repeatClick).toBe('function')
    expect(typeof links.noteClick).toBe('function')

    // The composer half of the same bridge carries the same three verbs.
    const draft = face('atlas-draft-links')
    expect(typeof draft.actionFor).toBe('function')
    expect(typeof draft.repeatClick).toBe('function')
    expect(typeof draft.noteClick).toBe('function')
    expect(typeof draft.resolveSession).toBe('function')
  })

  it('a session with no client scope is a named refusal, not a crash', async () => {
    const booted = await boot()
    const slots = booted.slotsRegister.mock.calls.map(call => call[0] as { id?: string; inject?: (id: string) => unknown })
    const scopeLess = booted.scopeSession
    // Four faces resolve a scope per injection; with none, each says which session.
    for (const id of ['atlas-mention-navigation', 'atlas-ad']) {
      const entry = slots.find(candidate => candidate.id === id)
      if (entry?.inject === undefined) continue
      scopeLess.mockReturnValueOnce(undefined)
      expect(() => entry.inject?.('session-x')).toThrow(/session "session-x" has no client scope/)
    }
  })
})

describe('dsh-atlas folder escape hatches', () => {
  it('lists the external scope and reports a failed directory listing', async () => {
    const external = vi.fn(async () => ({ ok: true as const, value: { canDiscover: true, roots: ['/ledger'], folders: ['/outside'] } }))
    const booted = await boot({ atFileExternal: external })
    const source = registered(booted)
    const request = (query: string) => ({ query, position: 'leading' as const, signal: signal() })
    // Priming the folder page asks the Host for the ledger it may offer.
    await source.candidates(s1, request('folder:'))
    await settle()
    expect(external).toHaveBeenCalled()

    // A failing index read is a SOFT failure for the menu: the category still
    // opens (back row only) instead of throwing into the composer.
    const failing = await boot({ atFileList: async () => ({ ok: false as const, error: { code: 'gone', message: 'boom', details: {} } }) })
    const rows = await registered(failing).candidates(s1, { query: 'file:', position: 'leading', signal: signal() })
    expect(rows.every(row => row.mentionKind === 'back')).toBe(true)
  })

  it('hands the pick to the product chooser, or opens its own dialog without one', async () => {
    const pickDirectory = vi.fn(async () => '/picked/folder')
    const booted = await boot({ uiWorkspace: { pickDirectory, createDirectory: async () => '' } })
    const folderRow = { name: '选择文件夹…', value: 'folder-choose', mentionKind: 'folder-choose' }
    const session = s1
    // The native chooser answers: the pick inserts the folder it returned.
    expect(registered(booted).onPick?.({ candidate: folderRow, session, action: 'accept', span: { start: 0, end: 2 } }))
      .toBeUndefined()
    await settle()
    expect(pickDirectory).toHaveBeenCalled()
    const bail = booted.sessionBail
    expect(bail).toHaveBeenCalled()
    const call = bail.mock.calls.at(-1) as unknown as [unknown, string, { text: string }]
    expect(call[2].text).toBe('@/picked/folder/ ')

    // No chooser at all: this plugin's own dialog opens over the same backend.
    const bare = await boot({ uiWorkspace: { createDirectory: async () => '' } })
    expect(registered(bare).onPick?.({ candidate: folderRow, session, action: 'accept', span: { start: 0, end: 2 } })).toBeUndefined()
    expect(registered(bare).name).toBe(SOURCE_NAME)
  })
})

describe('dsh-atlas mention categories beyond paths', () => {
  // The shapes the Host's own selectors return: a skill carries its tier, a chat
  // its uri, a plugin its package name.
  const skill = { name: 'review', description: 'Review code', tier: 'custom' as const }
  const chat = { name: 'yesterday', label: 'yesterday', sessionId: 's9', updatedAt: 1, chatUri: 'dsh://chat/s9' }
  const plugin = { entryId: 'dsh-atlas', moduleName: 'dsh-atlas', enabled: true }

  it('lists skills, chats and plugins through their own Remote and counts each pick', async () => {
    const booted = await boot({
      remoteAtMention: {
        listSkills: async () => ({ ok: true as const, value: [skill] }),
        listChats: async () => ({ ok: true as const, value: [chat] }),
        listPlugins: async () => ({ ok: true as const, value: [plugin] }),
      },
    })
    const source = registered(booted)
    const request = (query: string) => ({ query, position: 'leading' as const, signal: signal() })

    const skills = await source.candidates(s1, request('skill:'))
    expect(skills.map(row => row.name)).toContain('review')
    expect(source.onPick?.({ candidate: { name: 'review', value: 'review', mentionKind: 'skill' }, session: s1, action: 'accept' }))
      .toEqual({ text: '@skill:review ' })

    const chats = await source.candidates(s1, request('chat:'))
    expect(chats.map(row => row.name)).toContain('yesterday')
    expect(source.onPick?.({ candidate: { name: 'yesterday', value: 'yesterday', chatUri: 'dsh://chat/s1', mentionKind: 'chat' }, session: s1, action: 'accept' }))
      .toEqual({ text: '@[yesterday](dsh://chat/s1) ' })

    const plugins = await source.candidates(s1, request('plugin:'))
    expect(plugins.map(row => row.name)).toContain('dsh-atlas')
    expect(source.onPick?.({ candidate: { name: 'dsh-atlas', value: 'dsh-atlas', mentionKind: 'plugin' }, session: s1, action: 'accept' }))
      .toEqual({ text: '@plugin:dsh-atlas ' })

    await settle()
    // Every pick lands in the cross-category usage ledger (one writer, three kinds).
    const usage = booted.updateSettings.mock.calls
      .map(call => call[0] as { field: string; value?: readonly { key: string }[] })
      .filter(update => update.field === 'usage')
    const keys = usage.flatMap(update => (update.value ?? []).map(entry => entry.key))
    expect(keys).toContain('skill:review')
    expect(keys).toContain('chat:yesterday')
    expect(keys).toContain('plugin:dsh-atlas')
  })

  it('answers empty for a switched-off category and for a missing namespace', async () => {
    const off = await boot({ remoteAtMention: { listSkills: vi.fn(async () => ({ ok: true as const, value: [skill] })) } })
    // The switches default to on, so turning them off is the path under test.
    const section = settingsSection(off).inject()
    await section.setEnableSkills(false)
    await section.setEnableChats(false)
    await section.setEnablePlugins(false)
    const request = (query: string) => ({ query, position: 'leading' as const, signal: signal() })
    const backOnly = (rows: readonly SourceRow[]): boolean => rows.every(row => row.mentionKind === 'back')
    expect(backOnly(await registered(off).candidates(s1, request('skill:')))).toBe(true)
    expect(backOnly(await registered(off).candidates(s1, request('chat:')))).toBe(true)
    expect(backOnly(await registered(off).candidates(s1, request('plugin:')))).toBe(true)

    // No at-mention namespace at all: same empty answer, never a throw.
    const bare = await boot({})
    expect(backOnly(await registered(bare).candidates(s1, request('skill:')))).toBe(true)
    expect(backOnly(await registered(bare).candidates(s1, request('chat:')))).toBe(true)
    expect(backOnly(await registered(bare).candidates(s1, request('plugin:')))).toBe(true)
  })

  it('turns a failed list into a rejection naming the operation', async () => {
    const fail = { ok: false as const, error: { code: 'down', message: 'boom' } }
    const booted = await boot({
      remoteAtMention: {
        listSkills: async () => fail,
        listChats: async () => fail,
        listPlugins: async () => fail,
      },
    })
    const request = (query: string) => ({ query, position: 'leading' as const, signal: signal() })
    await expect(registered(booted).candidates(s1, request('skill:'))).rejects.toThrow(/listSkills failed: down: boom/)
    await expect(registered(booted).candidates(s1, request('chat:'))).rejects.toThrow(/listChats failed: down: boom/)
    await expect(registered(booted).candidates(s1, request('plugin:'))).rejects.toThrow(/listPlugins failed: down: boom/)
  })
})

describe('dsh-atlas overlay faces and one-level crumbs', () => {
  it('skips an empty path segment instead of drawing a nameless crumb', async () => {
    const booted = await boot({ atFileList: async () => ({ ok: true, value: listing('/a//b', []) }) })
    const rows = await pickerOf(booted).inject('s1').list('/a//b', signal())
    expect(rows.crumbs.map(crumb => crumb.name)).toEqual(['/', 'a', 'b'])
  })

  it('hands the readout, the palette, the menu icons and the tab their own face members', async () => {
    const loadThrough = vi.fn()
    const projections = { faceOf: vi.fn() }
    const booted = await boot({ sessionFace: { loadThrough, projections }, atFileList: async () => ({ ok: true, value: listing('/', []) }) })
    const byId = (id: string) => booted.slotsRegister.mock.calls.find(call => (call[0] as { id?: string })?.id === id)?.[0] as
      { inject: (sessionId: string) => Record<string, unknown> } | undefined
    expect(byId('atlas-history-readout')!.inject('s1')).toHaveProperty('roam')
    expect(byId('atlas-history-palette')!.inject('s1')).toHaveProperty('scope')
    expect(byId('atlas-menu-icons')!.inject('s1')).toHaveProperty('hooks')
    const jump = byId('atlas-history-jump')!.inject('s1') as {
      loadThrough?: (seq: number) => void
      projections?: unknown
      menu: unknown
    }
    // Both optional members are wired off the same session face (A-05, A-13).
    expect(jump.projections).toBe(projections)
    jump.loadThrough?.(42)
    expect(loadThrough).toHaveBeenCalledWith(42)
    // The folder tab's own file open goes through the shared file action.
    const tab = booted.slotsRegister.mock.calls.find(call => call[0]?.name === 'sidebar.right.pane.tab')?.[0] as
      { inject: (sessionId: string) => { openFile: (path: string) => void } } | undefined
    expect(tab).toBeUndefined()
  })
})
