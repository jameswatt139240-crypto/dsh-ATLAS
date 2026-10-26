/** Model-facing mention tools: past-chat listing/reading and plugin info. */
import { describe, expect, it, vi } from 'vitest'
import {
  formatChatCandidate,
  projectSurface,
  registerMentionTools,
  type ChatCandidateRow,
  type PluginInventoryFace,
  type SessionQueryFace,
  type SessionResolverFace,
} from '../src/tools.ts'
import type { AtFileSettings } from '../src/contract.ts'

const ENABLED: AtFileSettings = {
  enabled: true,
  ignoreFiles: [],
  workspaceIgnoreFiles: [],
  ignorePastedMentions: true,
  enableSkills: true,
  enableChats: true,
  enablePlugins: true,
  candidateLimit: 50,
}

const agent = { session: { header: { cwd: '/work' } } } as never

/** A tools-registry stub that captures the registered tool definitions. */
function captureTools() {
  const registered: Record<string, { execute: (...args: unknown[]) => unknown }> = {}
  const register = (tool: { name: string; execute: (...args: unknown[]) => unknown }) => {
    registered[tool.name] = tool
    return () => { delete registered[tool.name] }
  }
  return { register, registered }
}

/** Build a stub ctx whose `get` answers the given services. */
function ctxWith(services: Record<string, unknown>): { get(key: string): unknown } {
  return { get: key => services[key] }
}

describe('the card each tool shows in the transcript', () => {
  it('describes the call that produced it', () => {
    const { register, registered } = captureTools()
    registerMentionTools(ctxWith({ tools: { register } }) as never, () => ENABLED)
    const tools = registered as unknown as Record<string, {
      presentCall: (args: Record<string, unknown>) => unknown
      output: { render: (args: unknown, value: string) => unknown }
    }>
    expect(tools.past_chats!.presentCall({ query: 'rates' })).toEqual({
      card: 'generic', title: 'Past chats', kind: 'search', rawInput: 'rates',
    })
    expect(tools.read_past_chat!.presentCall({ sessionId: 'sess-a' })).toEqual({
      card: 'generic', title: 'Read past chat', kind: 'search', rawInput: 'sess-a',
    })
    expect(tools.plugin_info!.presentCall({ query: 'atlas' })).toEqual({
      card: 'generic', title: 'Plugins', kind: 'search', rawInput: 'atlas',
    })
    // No query is an empty raw input, never the string "undefined".
    expect(tools.past_chats!.presentCall({})).toMatchObject({ rawInput: '' })
    expect(tools.plugin_info!.presentCall({})).toMatchObject({ rawInput: '' })
    // The text output schema renders the value verbatim.
    expect(tools.plugin_info!.output.render(undefined, 'two lines')).toEqual([{ type: 'text', text: 'two lines' }])
  })

  it('refuses every category when the switch is off, and names what is missing', async () => {
    const off = { ...ENABLED, enableChats: false, enablePlugins: false }
    const { register, registered } = captureTools()
    registerMentionTools(ctxWith({ tools: { register } }) as never, () => off)
    const tools = registered as unknown as Record<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }>
    const exec = { agent, signal: new AbortController().signal }
    expect(await tools.past_chats!.execute({}, exec)).toBe('Past-chat mentions are disabled in Settings.')
    expect(await tools.read_past_chat!.execute({ sessionId: 'sess-a' }, exec)).toBe('Past-chat mentions are disabled in Settings.')
    expect(await tools.plugin_info!.execute({}, exec)).toBe('Plugin mentions are disabled in Settings.')

    // Switched on but the endpoint is missing: each tool says so instead of throwing.
    const on = captureTools()
    registerMentionTools(ctxWith({ tools: { register: on.register } }) as never, () => ENABLED)
    const onTools = on.registered as unknown as Record<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }>
    expect(await onTools.past_chats!.execute({}, exec)).toBe('No session history service is available.')
    expect(await onTools.read_past_chat!.execute({ sessionId: 'sess-a' }, exec)).toBe('Session history reading is unavailable.')
    expect(await onTools.plugin_info!.execute({}, exec)).toBe('No matching plugins found.')
    expect(await onTools.past_chats!.execute({ query: 'nothing' }, exec)).toBe('No session history service is available.')

    // A resolver that finds nothing says so in words the model can relay.
    const empty = captureTools()
    const emptyResolver: SessionResolverFace = { listCandidates: async () => [] }
    registerMentionTools(ctxWith({ tools: { register: empty.register }, sessionReferenceResolver: emptyResolver }) as never, () => ENABLED)
    const emptyTools = empty.registered as unknown as Record<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }>
    expect(await emptyTools.past_chats!.execute({ query: 'nothing' }, exec)).toBe('No past chats found.')

    // Every tool declares itself safe to run beside another call. The wrapper
    // validates the arguments first, so each is asked with a valid call.
    const verdicts = on.registered as unknown as Record<string, { isConcurrencySafe: (args: Record<string, unknown>) => boolean }>
    expect(verdicts.past_chats!.isConcurrencySafe({})).toBe(true)
    expect(verdicts.read_past_chat!.isConcurrencySafe({ sessionId: 'sess-a' })).toBe(true)
    expect(verdicts.plugin_info!.isConcurrencySafe({})).toBe(true)
    // An invalid call is never concurrency-safe: the schema is checked first.
    expect(verdicts.read_past_chat!.isConcurrencySafe({})).toBe(false)
  })
})

describe('formatChatCandidate', () => {
  it('renders a readable line with label, id, workspace, and date', () => {
    const candidate: ChatCandidateRow = { sessionId: 'sess-a', label: 'Payment rates', cwd: '/work', createdAt: 1700000000000 }
    expect(formatChatCandidate(candidate)).toContain('Payment rates (sess-a) @ /work')
    expect(formatChatCandidate({ ...candidate, cwd: undefined })).not.toContain('@ /work')
  })
})

describe('projectSurface', () => {
  it('keeps user and assistant text and drops other event kinds', () => {
    const events = [
      { type: 'user/message', content: [{ type: 'text', text: 'hello' }] },
      { type: 'assistant/message', content: [{ type: 'text', text: 'hi there' }] },
      { type: 'tool/result', content: [{ type: 'text', text: 'secret tool output' }] },
      { type: 'user/message', content: [] },
    ]
    const text = projectSurface(events)
    expect(text).toContain('[user/message] hello')
    expect(text).toContain('[assistant/message] hi there')
    expect(text).not.toContain('secret tool output')
  })

  it('skips empty messages', () => {
    expect(projectSurface([{ type: 'user/message', content: [{ type: 'text', text: '   ' }] }])).toBe('')
  })
})

describe('registerMentionTools', () => {
  it('registers past_chats, read_past_chat, and plugin_info', () => {
    const tools = captureTools()
    const disposers = registerMentionTools(ctxWith({ tools }) as never, () => ENABLED)
    expect(disposers).toHaveLength(3)
    expect(Object.keys(tools.registered).sort()).toEqual(['past_chats', 'plugin_info', 'read_past_chat'])
    for (const dispose of disposers ?? []) dispose()
    expect(Object.keys(tools.registered)).toEqual([])
  })

  it('returns undefined when the tools registry is not mounted', () => {
    expect(registerMentionTools(ctxWith({}) as never, () => ENABLED)).toBeUndefined()
  })

  it('lists past chats through the session reference resolver', async () => {
    const tools = captureTools()
    const resolver: SessionResolverFace = {
      listCandidates: vi.fn(async (_agent, query) => [
        { sessionId: 'sess-a', label: 'Payment rates', cwd: '/work', createdAt: 1700000000000 },
      ]),
    }
    registerMentionTools(ctxWith({ tools, sessionReferenceResolver: resolver }) as never, () => ENABLED)
    const result = await tools.registered.past_chats!.execute({ query: 'pay' }, { agent })
    expect(String(result)).toContain('Payment rates (sess-a)')
  })

  it('honors the enableChats gate and missing resolver', async () => {
    const tools = captureTools()
    const disabled = { ...ENABLED, enableChats: false }
    registerMentionTools(ctxWith({ tools }) as never, () => disabled)
    expect(String(await tools.registered.past_chats!.execute({}, { agent }))).toContain('disabled')
    const noService = captureTools()
    registerMentionTools(ctxWith({ tools: noService }) as never, () => ENABLED)
    expect(String(await noService.registered.past_chats!.execute({}, { agent }))).toContain('No session history service')
  })

  it('reads a past chat surface and denies cross-workspace access', async () => {
    const tools = captureTools()
    const sessionQuery: SessionQueryFace = {
      readSurface: vi.fn(async () => ({
        session: { header: { cwd: '/work' } },
        events: [{ type: 'user/message', content: [{ type: 'text', text: 'rates are in docs' }] }],
      })),
    }
    registerMentionTools(ctxWith({ tools, sessionQuery }) as never, () => ENABLED)
    const result = await tools.registered.read_past_chat!.execute({ sessionId: 'sess-a' }, { agent })
    expect(String(result)).toContain('rates are in docs')

    const foreign: SessionQueryFace = {
      readSurface: vi.fn(async () => ({
        session: { header: { cwd: '/other' } },
        events: [],
      })),
    }
    const tools2 = captureTools()
    registerMentionTools(ctxWith({ tools: tools2, sessionQuery: foreign }) as never, () => ENABLED)
    expect(String(await tools2.registered.read_past_chat!.execute({ sessionId: 'sess-b' }, { agent }))).toContain('Access denied')
  })

  it('reports empty surfaces and missing reader service', async () => {
    const tools = captureTools()
    const empty: SessionQueryFace = {
      readSurface: vi.fn(async () => ({ session: { header: { cwd: '/work' } }, events: [] })),
    }
    registerMentionTools(ctxWith({ tools, sessionQuery: empty }) as never, () => ENABLED)
    expect(String(await tools.registered.read_past_chat!.execute({ sessionId: 'sess-a' }, { agent }))).toContain('no readable')

    const tools2 = captureTools()
    registerMentionTools(ctxWith({ tools: tools2 }) as never, () => ENABLED)
    expect(String(await tools2.registered.read_past_chat!.execute({ sessionId: 'sess-a' }, { agent }))).toContain('unavailable')
  })

  it('lists plugins with a filter and honors the enablePlugins gate', async () => {
    const tools = captureTools()
    const inventory: PluginInventoryFace = {
      list: () => ({
        entries: [
          { moduleName: 'dsh-atlas', enabled: true },
          { moduleName: 'dsh-off', enabled: false },
        ],
      }),
    }
    registerMentionTools(ctxWith({ tools, pluginInventory: inventory }) as never, () => ENABLED)
    const result = await tools.registered.plugin_info!.execute({ query: 'dsh' }, { agent })
    expect(String(result)).toContain('- dsh-atlas [enabled]')
    expect(String(result)).toContain('- dsh-off [disabled]')
    expect(String(await tools.registered.plugin_info!.execute({ query: 'nope' }, { agent }))).toContain('No matching plugins')

    const tools2 = captureTools()
    registerMentionTools(ctxWith({ tools: tools2 }) as never, () => ({ ...ENABLED, enablePlugins: false }))
    expect(String(await tools2.registered.plugin_info!.execute({}, { agent }))).toContain('disabled')
  })

  it('awaits an async plugin inventory snapshot', async () => {
    const tools = captureTools()
    const inventory: PluginInventoryFace = {
      list: async () => ({ entries: [{ moduleName: 'dsh-async', enabled: true }] }),
    }
    registerMentionTools(ctxWith({ tools, pluginInventory: inventory }) as never, () => ENABLED)
    expect(String(await tools.registered.plugin_info!.execute({}, { agent }))).toContain('- dsh-async [enabled]')
  })
})
