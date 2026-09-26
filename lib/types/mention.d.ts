import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { PreStepDecision } from '@deepseek-ai/dsh-agent';
import { type LineRange } from './tokens.ts';
import { type ExternalAccess } from './external.ts';
/** One recognized mention: its workspace-relative token and resolved kind. */
export interface Mention {
    /** Workspace-relative path (no leading @, no trailing slash, no line range). */
    readonly relative: string;
    readonly kind: 'file' | 'dir';
    /** Inclusive 1-based line range, present only for `path:start-end` tokens. */
    readonly lines?: LineRange;
    /** True when `relative` is an absolute path outside the session workspace. */
    readonly outside?: true;
}
/** The source tag the injected reference carries (transcript consumers use it). */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'at-file-mention': {
            kind: 'at-file-mention';
            relative: string;
            lines?: string;
        };
    }
}
/**
 * Scan one text block for `@path` tokens, deduplicated in first-seen order.
 * A trailing slash (the directory chip form) is stripped from the path.
 * @param text - the message text block.
 * @returns unique workspace-relative tokens.
 */
export declare function scanMentions(text: string, ignorePastedMentions?: boolean): readonly string[];
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
export declare function expandMentions(messages: readonly UserMessage[], cwd: string | undefined, signal: AbortSignal, ignorePastedMentions?: boolean, access?: ExternalAccess, onExternal?: (mention: Mention) => void): Promise<UserMessage[]>;
/** The minimal agent face the pre-step handler reads. */
export interface MentionAgent {
    session: {
        header: {
            cwd?: string;
        };
    };
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
export declare function mentionPreStep(agent: MentionAgent, isEnabled: () => boolean, messages: readonly UserMessage[], signal: AbortSignal, next: () => Promise<PreStepDecision>, ignorePastedMentions?: () => boolean, references?: ReferenceExpansion, access?: ExternalAccess, onExternal?: (mention: Mention) => void): Promise<PreStepDecision>;
/** Live category expansions wired by the host entry; each is settings-gated. */
export interface ReferenceExpansion {
    /** Aggregate past-chat snapshot context, or undefined when none/disabled. */
    expandChats(messages: readonly UserMessage[], signal: AbortSignal): Promise<UserMessage | undefined>;
    /** `<skill-reference>` markers for recognized `@skill:` tokens. */
    expandSkills(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]>;
    /** `<plugin-reference>` markers for recognized `@plugin:` tokens. */
    expandPlugins(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]>;
    /**
     * `<atlas-reference>` blocks for recognized `@atlas:<provider>/<item>` tokens,
     * carrying the body the provider's own `resolve` returned.
     */
    expandAtlas?(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]>;
}
