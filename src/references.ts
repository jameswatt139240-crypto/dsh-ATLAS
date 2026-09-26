/**
 * Host-side expansion for the non-path @ mention categories: past chats
 * (official `dsh-session:` snapshot references), skills (`@skill:name`),
 * and plugins (`@plugin:name`). Each expansion validates the token against a
 * live capability (session reference resolver, skill registry, plugin
 * inventory) and injects a sourced user message — never raw content bytes
 * from the Host side unless the skill body injection config is enabled.
 * Chat mentions are stripped to readable `@label` text in the user's own
 * message, and the official `prepare()` snapshot is appended as a separate,
 * replayable context message.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AtlasCallContext, AtlasRegistration } from './atlas.ts'
import { isCancellation } from './abort.ts'
import {
  parseSessionReferenceText,
  type SessionReferenceInput,
} from '@deepseek-ai/dsh-session-reference'

/** The user-message source kind the boundary scans (external text cannot forge it). */
const USER_SOURCE_KIND = 'user'

/** The `@skill:name` mention token: `@skill:` then a whitespace/@-free name. */
export const SKILL_MENTION_PATTERN = /@skill:([^\s@]+)/g

/** The `@plugin:name` mention token: `@plugin:` then a whitespace/@-free module name. */
export const PLUGIN_MENTION_PATTERN = /@plugin:([^\s@]+)/g

/** The source tag skill reference messages carry (transcript consumers use it). */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'atlas-skill': { kind: 'atlas-skill'; name: string }
    'atlas-plugin': { kind: 'atlas-plugin'; moduleName: string }
    'atlas-provider': { kind: 'atlas-provider'; provider: string; item: string }
  }
}

/** Escape one value for an XML-like reference attribute without altering it. */
export function escapeReferenceAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** The session-reference resolver face this boundary needs (unit-test stub). */
export interface ChatResolver {
  prepare(
    agent: Agent,
    content: readonly ContentBlock[],
    references: readonly SessionReferenceInput[],
    signal: AbortSignal,
  ): Promise<{ readonly additionalContext?: UserMessage }>
}

/** Collect unique `@category:token` values across the claimed user messages. */
function collectTokens(messages: readonly UserMessage[], pattern: RegExp): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const message of messages) {
    if (message.source.kind !== USER_SOURCE_KIND) continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(pattern)) {
        const token = match[1] as string
        if (token === '' || seen.has(token)) continue
        seen.add(token)
        out.push(token)
      }
    }
  }
  return out
}

/**
 * Scan the claimed user messages for `@skill:name` tokens in first-seen
 * order. Known skills get a `<skill-reference>` marker; when `loadBody` is
 * provided (config `injectSkillBody`) the skill body is appended in a
 * `<skill-body>` block so the model can act on the full instructions.
 * Unknown names stay plain prose.
 * @param messages - the claimed user messages.
 * @param isKnown - live lookup: is this skill currently discoverable?
 * @param signal - caller lifetime.
 * @param loadBody - optional full-body loader (skill registry `get`).
 * @returns the injected user messages.
 */
export async function expandSkillMentions(
  messages: readonly UserMessage[],
  isKnown: (name: string) => boolean | Promise<boolean>,
  signal: AbortSignal,
  loadBody?: (name: string) => Promise<string | undefined>,
): Promise<UserMessage[]> {
  const tokens = collectTokens(messages, SKILL_MENTION_PATTERN)
  const injections: UserMessage[] = []
  for (const token of tokens) {
    signal.throwIfAborted()
    if (!(await isKnown(token))) continue
    const body = loadBody === undefined ? undefined : await loadBody(token)
    const text = body === undefined
      ? `<skill-reference name="${escapeReferenceAttribute(token)}" />`
      : `<skill-reference name="${escapeReferenceAttribute(token)}" />\n\n<skill-body>\n${body}\n</skill-body>`
    injections.push(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'atlas-skill', name: token },
    }))
  }
  return injections
}

/**
 * Scan the claimed user messages for `@plugin:name` tokens in first-seen
 * order. Enabled plugin modules get a `<plugin-reference>` marker; unknown
 * or disabled modules stay plain prose.
 * @param messages - the claimed user messages.
 * @param isEnabled - live lookup: is this module an enabled plugin?
 * @param signal - caller lifetime.
 * @returns the injected user messages.
 */
export async function expandPluginMentions(
  messages: readonly UserMessage[],
  isEnabled: (moduleName: string) => boolean | Promise<boolean>,
  signal: AbortSignal,
): Promise<UserMessage[]> {
  const tokens = collectTokens(messages, PLUGIN_MENTION_PATTERN)
  const injections: UserMessage[] = []
  for (const token of tokens) {
    signal.throwIfAborted()
    if (!(await isEnabled(token))) continue
    injections.push(createUserMessage({
      content: [{ type: 'text', text: `<plugin-reference name="${escapeReferenceAttribute(token)}" />` }],
      source: { kind: 'atlas-plugin', moduleName: token },
    }))
  }
  return injections
}

/** The `@atlas:<provider>/<item>` token: a provider handle, then its own item id. */
export const ATLAS_MENTION_PATTERN = /@atlas:([a-z0-9-]+)\/([^\s@]+)/g

/** How much one provider body may add to a single step. */
export const ATLAS_BODY_LIMIT = 16_384

/** How much every provider body may add to a single step in total. */
export const ATLAS_TOTAL_LIMIT = 49_152

/** One `@atlas:` mention, split into the handle and the provider's own item id. */
export interface AtlasMentionTarget {
  readonly providerId: string
  readonly item: string
}

/**
 * Collect unique `@atlas:<provider>/<item>` pairs in first-seen order.
 * @param messages - the claimed user messages.
 * @returns the targets, deduplicated by `provider/item`.
 */
function collectAtlasTokens(messages: readonly UserMessage[]): readonly AtlasMentionTarget[] {
  const seen = new Set<string>()
  const out: AtlasMentionTarget[] = []
  for (const message of messages) {
    if (message.source.kind !== USER_SOURCE_KIND) continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(ATLAS_MENTION_PATTERN)) {
        const providerId = match[1] as string
        const item = match[2] as string
        const key = `${providerId}/${item}`
        if (providerId === '' || item === '' || seen.has(key)) continue
        seen.add(key)
        out.push({ providerId, item })
      }
    }
  }
  return out
}

/**
 * One `<atlas-reference>` block: the handle, the governance facts, and the body.
 * @param registration - the provider that answered.
 * @param target - the mentioned item.
 * @param body - the provider's resolved text.
 * @param truncated - whether the body was cut to fit the step budget.
 * @returns the marker text.
 */
function atlasReferenceForm(
  registration: AtlasRegistration,
  target: AtlasMentionTarget,
  body: string,
  truncated: boolean,
): string {
  const attributes = [
    `provider="${escapeReferenceAttribute(registration.id)}"`,
    `item="${escapeReferenceAttribute(target.item)}"`,
    `scopes="${escapeReferenceAttribute(registration.scopes.join(' '))}"`,
    `verified="${registration.verified}"`,
    ...(truncated ? ['truncated="true"'] : []),
  ]
  // A body must not be able to close the envelope it rides in.
  const safe = body.replaceAll('</atlas-reference>', '<\\/atlas-reference>')
  return `<atlas-reference ${attributes.join(' ')}>\n${safe}\n</atlas-reference>`
}

/**
 * Scan the claimed user messages for `@atlas:<provider>/<item>` tokens and inject
 * one reference per token, carrying the body the provider's own `resolve` returns.
 *
 * ATLAS never reads a provider's data: the body arrives through the provider's
 * callback, is bounded here, and is never persisted — the usage counter records
 * only the `provider/item` handle. A provider that is not registered, or whose
 * `resolve` fails, contributes nothing rather than blocking the send.
 * @param messages - the claimed user messages.
 * @param context - the answered session, its workspace, and caller lifetime,
 *   handed to the provider verbatim.
 * @param lookup - the live injection-side registrations.
 * @returns the injected user messages, in first-seen order.
 */
export async function expandAtlasMentions(
  messages: readonly UserMessage[],
  context: AtlasCallContext,
  lookup: (providerId: string) => AtlasRegistration | undefined,
): Promise<readonly UserMessage[]> {
  const { signal } = context
  const injections: UserMessage[] = []
  let budget = ATLAS_TOTAL_LIMIT
  for (const target of collectAtlasTokens(messages)) {
    signal.throwIfAborted()
    const registration = lookup(target.providerId)
    const resolve = registration?.provider.resolve
    if (registration === undefined || resolve === undefined) continue
    let body: string
    try {
      body = await resolve({ id: target.item, title: target.item }, context)
    } catch (error) {
      // The send being cancelled is not a provider failure: the turn was stopped.
      if (!isCancellation(error, signal)) {
        console.error(`[dsh-atlas] atlas provider "${target.providerId}" resolve failed:`, error)
      }
      continue
    }
    signal.throwIfAborted()
    // An empty body is a provider saying "nothing to add" — most often a
    // workspace that is not a repository. Injecting an empty envelope would
    // cost tokens and tell the model nothing.
    if (body.trim() === '') continue
    const limit = Math.min(ATLAS_BODY_LIMIT, budget)
    if (limit <= 0) break
    const truncated = body.length > limit
    const kept = truncated ? body.slice(0, limit) : body
    budget -= kept.length
    injections.push(createUserMessage({
      content: [{ type: 'text', text: atlasReferenceForm(registration, target, kept, truncated) }],
      source: { kind: 'atlas-provider', provider: registration.id, item: target.item },
    }))
  }
  return injections
}

/**
 * Extract `dsh-session:` references from the claimed user messages in
 * first-mention order and return the messages with the markdown mentions
 * normalized to readable `@label` text.
 * @param messages - the claimed user messages.
 * @returns structured references plus the cleaned message copy.
 */
export function collectChatReferences(messages: readonly UserMessage[]): {
  readonly references: readonly SessionReferenceInput[]
  readonly cleaned: readonly UserMessage[]
} {
  const references: SessionReferenceInput[] = []
  const cleaned = messages.map(message => {
    if (message.source.kind !== USER_SOURCE_KIND) return message
    let changed = false
    const content = message.content.map(block => {
      if (block.type !== 'text') return block
      const parsed = parseSessionReferenceText(block.text)
      if (parsed.references.length === 0) return block
      changed = true
      for (const reference of parsed.references) {
        if (!references.some(existing => existing.sessionId === reference.sessionId)) {
          references.push(reference)
        }
      }
      return { ...block, text: parsed.text }
    })
    return changed ? { ...message, content } : message
  })
  return { references, cleaned }
}

/**
 * Normalize `dsh-session:` markdown mentions in the user messages to
 * readable `@label` text without preparing any context. Applied by the
 * pre-step wrapper whenever chat references are enabled so the raw URI never
 * reaches the model; unknown labels stay as parsed.
 * @param messages - the assembled step messages.
 * @returns the cleaned message copy.
 */
export function cleanChatMentions(messages: readonly UserMessage[]): readonly UserMessage[] {
  return collectChatReferences(messages).cleaned
}

/**
 * Prepare one aggregated past-chat snapshot for the claimed user messages.
 * Returns the official `additionalContext` user message, or undefined when
 * the claim has no `dsh-session:` references or the resolver produced none.
 * Errors are surfaced to the caller (the pre-step wrapper logs and continues).
 * @param agent - the live agent whose session is the reference target.
 * @param resolver - `ctx.sessionReferenceResolver` (official service).
 * @param messages - the claimed user messages.
 * @param signal - caller lifetime.
 * @returns the context message to place before the user's own words.
 */
export async function expandChatMentions(
  agent: Agent,
  resolver: ChatResolver,
  messages: readonly UserMessage[],
  signal: AbortSignal,
): Promise<UserMessage | undefined> {
  const { references, cleaned } = collectChatReferences(messages)
  if (references.length === 0) return undefined
  const content = cleaned.flatMap(message => message.content)
  const prepared = await resolver.prepare(agent, content, references, signal)
  return prepared.additionalContext
}
