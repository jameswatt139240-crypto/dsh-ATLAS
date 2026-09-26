/**
 * The Host-side @file reference marker: recognizes `@path` tokens in the
 * outgoing user message, validates that each selected workspace path exists,
 * and injects only its path and kind. File bytes and directory descendants are
 * never read here; the agent chooses if and how to inspect a reference with its
 * available tools. Only `source.kind === 'user'` text is scanned, so external
 * text cannot forge the gesture.
 */
import { isAbsolute, relative as pathRelative, resolve, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { isProtectedMentionToken, PASTED_MENTION_MARKER, stripPastedMentionMarkers } from './paste.ts'
import { cleanChatMentions } from './references.ts'
import { lineRangeLabel, splitLineRange, type LineRange } from './tokens.ts'
import { allowsExternal, externalPath, type ExternalAccess } from './external.ts'
import { isCancellation } from './abort.ts'

/**
 * Report one expansion failure, unless the message was simply cancelled.
 * @param topic - the reference kind being expanded (named in the message).
 * @param error - the caught value.
 * @param signal - the pre-step's lifetime.
 */
function reportExpansionFailure(topic: string, error: unknown, signal: AbortSignal): void {
  // Stopping a turn aborts these expansions: that is normal operation, and
  // reporting it as a failure would bury the failures that matter.
  if (isCancellation(error, signal)) return
  console.error(`[dsh-atlas] ${topic} expansion failed:`, error)
}

/** One recognized mention: its workspace-relative token and resolved kind. */
export interface Mention {
  /** Workspace-relative path (no leading @, no trailing slash, no line range). */
  readonly relative: string
  readonly kind: 'file' | 'dir'
  /** Inclusive 1-based line range, present only for `path:start-end` tokens. */
  readonly lines?: LineRange
  /** True when `relative` is an absolute path outside the session workspace. */
  readonly outside?: true
}

/** The source tag the injected reference carries (transcript consumers use it). */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'at-file-mention': { kind: 'at-file-mention'; relative: string; lines?: string }
  }
}

/** The user-message source kind this boundary scans (external text cannot forge it). */
const USER_SOURCE_KIND = 'user'

/** The literal mention token: `@` then a path with no whitespace or `@`. */
const MENTION_PATTERN = /@([^\s@]+)/g

/**
 * Scan one text block for `@path` tokens, deduplicated in first-seen order.
 * A trailing slash (the directory chip form) is stripped from the path.
 * @param text - the message text block.
 * @returns unique workspace-relative tokens.
 */
export function scanMentions(text: string, ignorePastedMentions = true): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const raw = match[1] as string
    if (ignorePastedMentions && isProtectedMentionToken(raw)) continue
    const unmarked = ignorePastedMentions ? raw : stripPastedMentionMarkers(raw)
    const relative = unmarked.endsWith('/') ? unmarked.slice(0, -1) : unmarked
    if (relative === '' || seen.has(relative)) continue
    seen.add(relative)
    out.push(relative)
  }
  return out
}

/**
 * Resolve one token to an absolute path, its kind, and an optional line range.
 *
 * Workspace-relative tokens stay confined to the cwd. An ABSOLUTE token is a
 * deliberate out-of-workspace reference and is accepted only when the session's
 * access allows it (`src/external.ts`): under 完全权限 anything that exists, under
 * a narrower mode only what the ledger already knows. A line range is only
 * meaningful on a file, so a range on a directory (or on a path that does not
 * exist) is refused.
 * @param token - workspace-relative token, or an absolute external path, optionally `path:start-end`.
 * @param cwd - the session's workspace directory.
 * @param signal - caller lifetime.
 * @param access - the session's out-of-workspace access, or undefined to refuse every external path.
 * @returns the resolved mention, or undefined when it is not a usable reference.
 */
async function resolveMention(
  token: string,
  cwd: string,
  signal: AbortSignal,
  access?: ExternalAccess,
): Promise<Mention | undefined> {
  const target = splitLineRange(token)
  const external = isAbsolute(target.path)
  if (external) {
    if (access === undefined || !allowsExternal(access, target.path)) return undefined
  }
  const absolute = external ? target.path : resolve(cwd, target.path)
  const confined = pathRelative(cwd, absolute)
  if (!external && (confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined))) {
    return undefined
  }
  signal.throwIfAborted()
  const info = await stat(absolute).catch(() => undefined)
  signal.throwIfAborted()
  if (info === undefined) return undefined
  const kind = info.isDirectory() ? 'dir' : 'file'
  if (target.lines !== undefined && kind === 'dir') return undefined
  const relative = external ? externalPath(absolute) : (confined.split(sep).join('/') || '.')
  return { relative, kind, ...(external ? { outside: true as const } : {}), ...(target.lines === undefined ? {} : { lines: target.lines }) }
}

/** Escape one XML-like attribute without modifying the referenced path. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** One validated existence-only reference for the model. */
function referenceForm(mention: Mention): string {
  const kind = mention.kind === 'dir' ? 'directory' : 'file'
  const lines = mention.lines === undefined ? '' : ` lines="${lineRangeLabel(mention.lines)}"`
  // An out-of-workspace reference says so in the marker itself: the model must
  // know the path is not relative to the session workspace, and the workspace
  // sandbox still governs what may be WRITTEN there.
  if (mention.outside === true) {
    return `<external-reference path="${escapeAttribute(mention.relative)}" kind="${kind}"${lines} />`
  }
  return `<workspace-reference path="${escapeAttribute(mention.relative)}" kind="${kind}"${lines} />`
}

/**
 * Expand every `@path` mention into a validated existence-only reference, in
 * first-seen order. Unknown paths stay plain prose.
 * @param messages - the assembled step messages.
 * @param cwd - the session's workspace directory.
 * @param signal - caller lifetime.
 * @param ignorePastedMentions - live pasted-@ policy.
 * @param access - the session's out-of-workspace access, or undefined to refuse external paths.
 * @param onExternal - called with each accepted external reference, for the ledger.
 * @returns the injected user messages (empty when nothing matched or disabled).
 */
export async function expandMentions(
  messages: readonly UserMessage[],
  cwd: string | undefined,
  signal: AbortSignal,
  ignorePastedMentions = true,
  access?: ExternalAccess,
  onExternal?: (mention: Mention) => void,
): Promise<UserMessage[]> {
  if (cwd === undefined || !isAbsolute(cwd)) return []
  const tokens: string[] = []
  for (const message of messages) {
    if (message.source.kind !== USER_SOURCE_KIND) continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const text = ignorePastedMentions ? block.text : stripPastedMentionMarkers(block.text)
      tokens.push(...scanMentions(text, ignorePastedMentions))
    }
  }
  const injections: UserMessage[] = []
  for (const token of tokens) {
    signal.throwIfAborted()
    const mention = await resolveMention(token, cwd, signal, access)
    if (mention === undefined) continue
    if (mention.outside === true) onExternal?.(mention)
    injections.push(createUserMessage({
      content: [{ type: 'text', text: referenceForm(mention) }],
      source: {
        kind: 'at-file-mention',
        relative: mention.relative,
        ...(mention.lines === undefined ? {} : { lines: lineRangeLabel(mention.lines) }),
      },
    }))
  }
  return injections
}

/** The minimal agent face the pre-step handler reads. */
export interface MentionAgent {
  session: { header: { cwd?: string } }
}

/** The `agent/pre-step` listener body: expand mentions in the claimed user
 * messages and append the injections to the downstream decision. Extracted so
 * the boundary logic is unit-testable without an assembled agent scope.
 * @param agent - the addressed agent (its session header owns the cwd).
 * @param isEnabled - live settings read.
 * @param messages - the claimed messages (the user's own words).
 * @param signal - caller lifetime.
 * @param next - the downstream waterfall.
 * @param ignorePastedMentions - live pasted-@ policy.
 * @param references - optional category expansions (chats, skills, plugins).
 * @param access - the session's out-of-workspace access, or undefined to refuse external paths.
 * @param onExternal - called with each accepted external reference, for the ledger.
 * @returns the decision with injections appended, or the downstream decision.
 */
export async function mentionPreStep(
  agent: MentionAgent,
  isEnabled: () => boolean,
  messages: readonly UserMessage[],
  signal: AbortSignal,
  next: () => Promise<PreStepDecision>,
  ignorePastedMentions: () => boolean = () => true,
  references?: ReferenceExpansion,
  access?: ExternalAccess,
  onExternal?: (mention: Mention) => void,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  const pastedSetting = ignorePastedMentions()
  const cleanMessages = pastedSetting
    ? decision.messages.map(message => {
      if (message.source.kind !== USER_SOURCE_KIND) return message
      let changed = false
      const content = message.content.map(block => {
        if (block.type !== 'text' || !block.text.includes(PASTED_MENTION_MARKER)) return block
        changed = true
        return { ...block, text: stripPastedMentionMarkers(block.text) }
      })
      return changed ? { ...message, content } : message
    })
    : decision.messages
  if (!isEnabled()) {
    return cleanMessages === decision.messages ? decision : { kind: 'enter', messages: cleanMessages }
  }
  const baseMessages: UserMessage[] = references === undefined ? cleanMessages : [...cleanChatMentions(cleanMessages)]
  const [chatContext, skillInjections, pluginInjections, atlasInjections, pathInjections] = await Promise.all([
    references === undefined
      ? Promise.resolve(undefined)
      : references.expandChats(messages, signal).catch((error: unknown) => {
        reportExpansionFailure('past-chat', error, signal)
        return undefined
      }),
    references === undefined
      ? Promise.resolve([] as readonly UserMessage[])
      : references.expandSkills(messages, signal).catch((error: unknown) => {
        reportExpansionFailure('skill', error, signal)
        return [] as readonly UserMessage[]
      }),
    references === undefined
      ? Promise.resolve([] as readonly UserMessage[])
      : references.expandPlugins(messages, signal).catch((error: unknown) => {
        reportExpansionFailure('plugin', error, signal)
        return [] as readonly UserMessage[]
      }),
    references?.expandAtlas === undefined
      ? Promise.resolve([] as readonly UserMessage[])
      : references.expandAtlas(messages, signal).catch((error: unknown) => {
        reportExpansionFailure('atlas provider', error, signal)
        return [] as readonly UserMessage[]
      }),
    expandMentions(messages, agent.session.header.cwd, signal, pastedSetting, access, onExternal),
  ])
  const injections: readonly UserMessage[] = [
    ...(chatContext === undefined ? [] : [chatContext]),
    ...pathInjections,
    ...skillInjections,
    ...pluginInjections,
    ...atlasInjections,
  ]
  if (injections.length === 0 && chatContext === undefined) {
    return baseMessages === decision.messages ? decision : { kind: 'enter', messages: baseMessages }
  }
  const base = chatContext === undefined ? baseMessages : [chatContext, ...baseMessages]
  return { kind: 'enter', messages: [...base, ...pathInjections, ...skillInjections, ...pluginInjections, ...atlasInjections] }
}

/** Live category expansions wired by the host entry; each is settings-gated. */
export interface ReferenceExpansion {
  /** Aggregate past-chat snapshot context, or undefined when none/disabled. */
  expandChats(messages: readonly UserMessage[], signal: AbortSignal): Promise<UserMessage | undefined>
  /** `<skill-reference>` markers for recognized `@skill:` tokens. */
  expandSkills(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]>
  /** `<plugin-reference>` markers for recognized `@plugin:` tokens. */
  expandPlugins(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]>
  /**
   * `<atlas-reference>` blocks for recognized `@atlas:<provider>/<item>` tokens,
   * carrying the body the provider's own `resolve` returned.
   */
  expandAtlas?(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]>
}
