/**
 * Model-facing tools for the @ mention categories, so a chat that used a
 * reference can query it on demand later:
 *
 * - `past_chats` lists history sessions by title/workspace (no FTS needed —
 *   it reads the session-reference candidate index).
 * - `read_past_chat` reads one referenced session's current user/assistant
 *   surface (exact read through `ctx.sessionQuery`, workspace-authorized).
 * - `plugin_info` lists installed plugins by module name.
 *
 * Skills need no tool here: every session already has the `skill` loader,
 * and the session skill catalog carries the summaries.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AtFileSettings } from './contract.ts'

/** Face of `ctx.sessionReferenceResolver` used by the listing tool. */
export interface SessionResolverFace {
  listCandidates(agent: Agent, query: string, limit: number, signal?: AbortSignal): Promise<readonly {
    sessionId: string
    label: string
    cwd?: string
    createdAt: number
  }[]>
}

/** Face of `ctx.sessionQuery` used by the reader tool (structural). */
export interface SessionQueryFace {
  readSurface(sessionId: string): Promise<{
    session: { header: { cwd?: string } }
    events: readonly {
      type: string
      content?: readonly { type: string; text?: string }[]
      text?: string
    }[]
  }>
}

/**
 * Face of `ctx.pluginInventory` used by the plugin tool. The Harness gateway
 * declares `@Remote('list') async list()`, so the returned snapshot MUST be
 * awaited; the sync arm stays accepted for structural stubs.
 */
export interface PluginInventoryFace {
  list(): { entries: readonly { moduleName: string; enabled: boolean }[] } | Promise<{ entries: readonly { moduleName: string; enabled: boolean }[] }>
}

/** One candidate row from the session reference resolver. */
export interface ChatCandidateRow {
  readonly sessionId: string
  readonly label: string
  readonly cwd?: string
  readonly createdAt: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Format one past-chat candidate as a readable line. */
export function formatChatCandidate(candidate: ChatCandidateRow): string {
  const created = new Date(candidate.createdAt).toISOString().slice(0, 10)
  return `- ${candidate.label} (${candidate.sessionId})${candidate.cwd === undefined ? '' : ` @ ${candidate.cwd}`} created ${created}`
}

/**
 * Project a session's current surface into readable user/assistant text,
 * excluding tool results, reasoning, and injected context (same spirit as the
 * official session-reference projection).
 */
export function projectSurface(events: readonly {
  type: string
  content?: readonly { type: string; text?: string }[]
  text?: string
}[]): string {
  const lines: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const blocks = event.content ?? []
    const text = blocks.length === 0
      ? (event.text ?? '')
      : blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (text.trim() === '') continue
    lines.push(`[${event.type}] ${text}`)
  }
  return lines.join('\n\n')
}

/** The tool-execution face used by the registered tools. */
export interface MentionToolExec {
  readonly agent?: Agent
  readonly signal?: AbortSignal
}

/**
 * Register the three mention tools on `ctx.tools`. Returns the disposers, or
 * undefined when the tools registry is not mounted yet (profiles without it
 * simply skip the tools; the picker and reference injection stay intact).
 */
export function registerMentionTools(
  ctx: Context,
  readSettings: () => AtFileSettings,
): (() => void)[] | undefined {
  const tools = ctx.get('tools') as { register(tool: ReturnType<typeof defineTool>): () => void } | undefined
  if (tools === undefined) return undefined
  const disposers: (() => void)[] = []

  disposers.push(tools.register(defineTool({
    name: 'past_chats',
    description: 'List past chat sessions in the caller workspace, filtered by title or workspace text. Use when the user references a past chat or asks about earlier conversations.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive filter over session title or workspace path.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args: { query?: string }, exec: MentionToolExec) => {
      if (!readSettings().enableChats) return 'Past-chat mentions are disabled in Settings.'
      const resolver = ctx.get('sessionReferenceResolver') as SessionResolverFace | undefined
      if (resolver === undefined || exec.agent === undefined) return 'No session history service is available.'
      const candidates = await resolver.listCandidates(exec.agent, args.query ?? '', 20, exec.signal)
      if (candidates.length === 0) return 'No past chats found.'
      return candidates.map(formatChatCandidate).join('\n')
    },
    presentCall: (args: { query?: string }) => ({
      card: 'generic' as const,
      title: 'Past chats',
      kind: 'search' as const,
      rawInput: args.query ?? '',
    }),
  })))

  disposers.push(tools.register(defineTool({
    name: 'read_past_chat',
    description: 'Read one past chat session\'s current user/assistant messages by session id (from a @past-chat reference or past_chats). Workspace-authorized.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The session id, e.g. the id in a dsh-session: reference.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args: { sessionId: string }, exec: MentionToolExec) => {
      if (!readSettings().enableChats) return 'Past-chat mentions are disabled in Settings.'
      const sessionQuery = ctx.get('sessionQuery') as SessionQueryFace | undefined
      if (sessionQuery === undefined) return 'Session history reading is unavailable.'
      const target = await sessionQuery.readSurface(args.sessionId)
      const callerCwd = exec.agent?.session.header.cwd
      if (callerCwd !== undefined && target.session.header.cwd !== undefined && callerCwd !== target.session.header.cwd) {
        return 'Access denied: the session belongs to a different workspace.'
      }
      const text = projectSurface(target.events)
      return text === '' ? 'The session has no readable user/assistant messages.' : text
    },
    presentCall: (args: { sessionId: string }) => ({
      card: 'generic' as const,
      title: 'Read past chat',
      kind: 'search' as const,
      rawInput: args.sessionId,
    }),
  })))

  disposers.push(tools.register(defineTool({
    name: 'plugin_info',
    description: 'List installed plugins and their enablement, filtered by module name. Use when the user references @plugin:... or asks whether a plugin is installed.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive substring filter over the plugin module name.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args: { query?: string }, exec: MentionToolExec) => {
      if (!readSettings().enablePlugins) return 'Plugin mentions are disabled in Settings.'
      const inventory = ctx.get('pluginInventory') as PluginInventoryFace | undefined
      const entries = (inventory === undefined ? undefined : await inventory.list())?.entries ?? []
      const query = (args.query ?? '').toLowerCase()
      const filtered = entries.filter(entry => query === '' || entry.moduleName.toLowerCase().includes(query))
      if (filtered.length === 0) return 'No matching plugins found.'
      return filtered.map(entry => `- ${entry.moduleName} [${entry.enabled ? 'enabled' : 'disabled'}]`).join('\n')
    },
    presentCall: (args: { query?: string }) => ({
      card: 'generic' as const,
      title: 'Plugins',
      kind: 'search' as const,
      rawInput: args.query ?? '',
    }),
  })))

  return disposers
}
