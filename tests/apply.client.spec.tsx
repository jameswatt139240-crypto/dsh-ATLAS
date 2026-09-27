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
import type { AtFileSettings, AtFileSettingsUpdate, ReferenceInfo, WorkspaceIgnoreFiles } from '../src/contract.ts'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } }

interface BootOptions {
  atFileSearch?: (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<readonly { path: string; relative: string; kind: 'file' | 'dir' }[]>>
  atFileInspect?: (sessionId: SessionId, targets: readonly string[]) => Promise<RemoteResult<readonly ReferenceInfo[]>>
  atFileGetSettings?: () => Promise<RemoteResult<AtFileSettings>>
  atFileUpdateSettings?: (update: AtFileSettingsUpdate) => Promise<RemoteResult<AtFileSettings>>
  openPath?: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>
  enabled?: boolean
  ignorePastedMentions?: boolean
  ignoreFiles?: readonly string[]
  workspaceIgnoreFiles?: readonly WorkspaceIgnoreFiles[]
  withoutNamespace?: boolean
  withoutSessionRemote?: boolean
  remoteMount?: () => Promise<() => void>
  /** The session list the draft's bare-label resolver reads (ids + display titles). */
  sessionList?: { ids: readonly string[]; byId: Record<string, { displayTitle: string }> }
  /** How `ctx.sessions.open` answers; the default records the call. */
  openSession?: (sessionId: string) => void
  /**
   * One service name whose read must THROW, the way cordis answers a service this
   * plugin never declared in `inject`. That is how a profile with no right Sidebar
   * behaves, and it is the branch every optional read exists for.
   */
  mountThrowingService?: string
}

/** Boot the plugin body over a stub-service context and return the recorded surfaces. */
async function boot(options: BootOptions = {}) {
  const ctx = new Context()
  const sourceDispose = vi.fn()
  const registerSource = vi.fn(() => sourceDispose)
  const openReference = vi.fn(() => true)
  const controller = { menu: { getSnapshot: vi.fn(), subscribe: vi.fn() }, track: vi.fn(), openReference }
  const sessionOf = vi.fn(() => controller)
  const sessionScope = {}
  const scopeSession = vi.fn(() => sessionScope)
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
      getSettings,
      updateSettings,
    })
  }
  ctx.provide('slots', { inject: slotsInject, register: slotsRegister })
  ctx.provide('locale', { register: localeRegister, bind })
  // The draft's session face: a bare `@label` may only become a session link on
  // this list's answer, and opening one goes through the service the sidebar's
  // own rows use.
  const openSessionSpy = vi.fn(options.openSession ?? (() => {}))
  const sessionList = options.sessionList ?? { ids: [], byId: {} }
  ctx.provide('sessions', {
    scope: scopeSession,
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
    openSessionSpy,
    setRemoteSettings: (next: AtFileSettings) => { settings = next },
  }
}

/** One registered trigger source, narrowed to the members the assertions read. */
interface RegisteredSource {
  trigger: string
  name: string
  candidates: (session: { sessionId: SessionId }, req: { query: string; position: 'leading' | 'inline'; signal: AbortSignal }) => Promise<readonly { name: string }[]>
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

  it('opens a directory row in the sidebar AND locally by default', async () => {
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
    // The default is BOTH: the sidebar is where a folder is useful, and the local
    // open that came first still runs alongside it. A WORKSPACE folder opens the
    // product's own files tab — the tree the user already reads folders in. That tab
    // is a PAGE (it claims no address), so it is opened by kind and starts at the
    // workspace root: no params and no reveal API exist to select a folder in it.
    expect(openTab).toHaveBeenCalledWith('files')
    expect(openResource).not.toHaveBeenCalled()
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/src' })
  })

  it('falls back to this plugin folder tab when the build has no files tab', async () => {
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src', relative: 'src', kind: 'dir' }] }),
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    const openResource = vi.fn()
    // A sidebar face without `openTab`: this plugin's own folder tab is the fallback.
    booted.ctx.provide('sidebarRight', { openResource })
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })
    await settle()
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder/src')
  })

  it('still opens a folder in a profile that mounts NO Sidebar at all', async () => {
    // The documented requirement: `@` must work where the Sidebar does not exist.
    // Reading an undeclared cordis service THROWS, so without the optional-read
    // helper this click would throw instead of falling back to the OS opener.
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src', relative: 'src', kind: 'dir' }] }),
      mountThrowingService: 'sidebarRight',
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    // No `sidebarRight` is provided anywhere: the read must degrade, not throw, and
    // the local opener that ran first stays the effective action.
    expect(() => dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })).not.toThrow()
    await settle()
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/src' })
  })

  it('opens a folder with the local opener when only the TAB registry is missing', async () => {
    // The second optional service on this path: `sidebarRightTabs` carries the
    // folder-tab registration. A profile with the Sidebar but no tab registry must
    // still finish the click, with the plugin's own tab simply not registered.
    const booted = await boot({ mountThrowingService: 'sidebarRightTabs' })
    expect(booted.ctx.get('sidebarRightTabs')).toBeUndefined()
  })

  it('honours the folder-open setting: sidebar only, or local only', async () => {
    const booted = await boot({
      atFileSearch: async () => ({ ok: true as const, value: [{ path: '/ws/src', relative: 'src', kind: 'dir' }] }),
    })
    await registered(booted).candidates(s1, { query: '', position: 'leading', signal: signal() })
    await settle()
    const openResource = vi.fn()
    const openTab = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource, openTab })

    await settingsSection(booted).inject().setFolderOpen('sidebar')
    await settle()
    booted.openPath.mockClear()
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })
    await settle()
    expect(openTab).toHaveBeenCalledTimes(1)
    expect(booted.openPath).not.toHaveBeenCalled()

    await settingsSection(booted).inject().setFolderOpen('native')
    await settle()
    openResource.mockClear()
    openTab.mockClear()
    booted.openPath.mockClear()
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'src' })
    await settle()
    // Local only: the sidebar is not even asked, and the Host opener gets the
    // absolute path the index knows for this relative row.
    expect(openResource).not.toHaveBeenCalled()
    expect(booted.openPath).toHaveBeenCalledWith({ path: '/ws/src' })
  })

  it('asks the sidebar for an out-of-workspace folder by absolute address', async () => {
    // No `inspect` stub: without one the plugin treats the target as unverified
    // and opens anyway, which is exactly the path an external folder takes.
    const booted = await boot()
    const openResource = vi.fn()
    booted.ctx.provide('sidebarRight', { openResource })
    dockOf(booted).inject('s1').onOpen({ kind: 'folder', path: 'E:/outside/deepseek-harness' })
    await settle()
    // A folder rides the plugin's own `folder` type for both scopes: the Host
    // resolves a workspace-relative path against the session workspace, and an
    // out-of-workspace one is already absolute. The OS opener gets the path itself.
    expect(openResource).toHaveBeenCalledWith('dsh-resource://folder/E:/outside/deepseek-harness')
    expect(booted.openPath).toHaveBeenCalledWith({ path: 'E:/outside/deepseek-harness' })
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