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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import type { AtlasCallContext, AtlasRegistration } from './atlas.ts';
import { type SessionReferenceInput } from '@deepseek-ai/dsh-session-reference';
/** The `@skill:name` mention token: `@skill:` then a whitespace/@-free name. */
export declare const SKILL_MENTION_PATTERN: RegExp;
/** The `@plugin:name` mention token: `@plugin:` then a whitespace/@-free module name. */
export declare const PLUGIN_MENTION_PATTERN: RegExp;
/** The source tag skill reference messages carry (transcript consumers use it). */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'atlas-skill': {
            kind: 'atlas-skill';
            name: string;
        };
        'atlas-plugin': {
            kind: 'atlas-plugin';
            moduleName: string;
        };
        'atlas-provider': {
            kind: 'atlas-provider';
            provider: string;
            item: string;
        };
    }
}
/** Escape one value for an XML-like reference attribute without altering it. */
export declare function escapeReferenceAttribute(value: string): string;
/** The session-reference resolver face this boundary needs (unit-test stub). */
export interface ChatResolver {
    prepare(agent: Agent, content: readonly ContentBlock[], references: readonly SessionReferenceInput[], signal: AbortSignal): Promise<{
        readonly additionalContext?: UserMessage;
    }>;
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
export declare function expandSkillMentions(messages: readonly UserMessage[], isKnown: (name: string) => boolean | Promise<boolean>, signal: AbortSignal, loadBody?: (name: string) => Promise<string | undefined>): Promise<UserMessage[]>;
/**
 * Scan the claimed user messages for `@plugin:name` tokens in first-seen
 * order. Enabled plugin modules get a `<plugin-reference>` marker; unknown
 * or disabled modules stay plain prose.
 * @param messages - the claimed user messages.
 * @param isEnabled - live lookup: is this module an enabled plugin?
 * @param signal - caller lifetime.
 * @returns the injected user messages.
 */
export declare function expandPluginMentions(messages: readonly UserMessage[], isEnabled: (moduleName: string) => boolean | Promise<boolean>, signal: AbortSignal): Promise<UserMessage[]>;
/** The `@atlas:<provider>/<item>` token: a provider handle, then its own item id. */
export declare const ATLAS_MENTION_PATTERN: RegExp;
/** How much one provider body may add to a single step. */
export declare const ATLAS_BODY_LIMIT = 16384;
/** How much every provider body may add to a single step in total. */
export declare const ATLAS_TOTAL_LIMIT = 49152;
/** One `@atlas:` mention, split into the handle and the provider's own item id. */
export interface AtlasMentionTarget {
    readonly providerId: string;
    readonly item: string;
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
export declare function expandAtlasMentions(messages: readonly UserMessage[], context: AtlasCallContext, lookup: (providerId: string) => AtlasRegistration | undefined): Promise<readonly UserMessage[]>;
/**
 * Extract `dsh-session:` references from the claimed user messages in
 * first-mention order and return the messages with the markdown mentions
 * normalized to readable `@label` text.
 * @param messages - the claimed user messages.
 * @returns structured references plus the cleaned message copy.
 */
export declare function collectChatReferences(messages: readonly UserMessage[]): {
    readonly references: readonly SessionReferenceInput[];
    readonly cleaned: readonly UserMessage[];
};
/**
 * Normalize `dsh-session:` markdown mentions in the user messages to
 * readable `@label` text without preparing any context. Applied by the
 * pre-step wrapper whenever chat references are enabled so the raw URI never
 * reaches the model; unknown labels stay as parsed.
 * @param messages - the assembled step messages.
 * @returns the cleaned message copy.
 */
export declare function cleanChatMentions(messages: readonly UserMessage[]): readonly UserMessage[];
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
export declare function expandChatMentions(agent: Agent, resolver: ChatResolver, messages: readonly UserMessage[], signal: AbortSignal): Promise<UserMessage | undefined>;
