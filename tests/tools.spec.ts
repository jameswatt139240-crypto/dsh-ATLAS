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
