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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AtFileSettings } from './contract.ts';
/** Face of `ctx.sessionReferenceResolver` used by the listing tool. */
export interface SessionResolverFace {
    listCandidates(agent: Agent, query: string, limit: number, signal?: AbortSignal): Promise<readonly {
        sessionId: string;
        label: string;
        cwd?: string;
        createdAt: number;
    }[]>;
}
/** Face of `ctx.sessionQuery` used by the reader tool (structural). */
export interface SessionQueryFace {
    readSurface(sessionId: string): Promise<{
        session: {
            header: {
                cwd?: string;
            };
        };
        events: readonly {
            type: string;
            content?: readonly {
                type: string;
                text?: string;
            }[];
            text?: string;
        }[];
    }>;
}
/**
 * Face of `ctx.pluginInventory` used by the plugin tool. The Harness gateway
 * declares `@Remote('list') async list()`, so the returned snapshot MUST be
 * awaited; the sync arm stays accepted for structural stubs.
 */
export interface PluginInventoryFace {
    list(): {
        entries: readonly {
            moduleName: string;
            enabled: boolean;
        }[];
    } | Promise<{
        entries: readonly {
            moduleName: string;
            enabled: boolean;
        }[];
    }>;
}
/** One candidate row from the session reference resolver. */
export interface ChatCandidateRow {
    readonly sessionId: string;
    readonly label: string;
    readonly cwd?: string;
    readonly createdAt: number;
}
/** Format one past-chat candidate as a readable line. */
export declare function formatChatCandidate(candidate: ChatCandidateRow): string;
/**
 * Project a session's current surface into readable user/assistant text,
 * excluding tool results, reasoning, and injected context (same spirit as the
 * official session-reference projection).
 */
export declare function projectSurface(events: readonly {
    type: string;
    content?: readonly {
        type: string;
        text?: string;
    }[];
    text?: string;
}[]): string;
/** The tool-execution face used by the registered tools. */
export interface MentionToolExec {
    readonly agent?: Agent;
    readonly signal?: AbortSignal;
}
/**
 * Register the three mention tools on `ctx.tools`. Returns the disposers, or
 * undefined when the tools registry is not mounted yet (profiles without it
 * simply skip the tools; the picker and reference injection stay intact).
 */
export declare function registerMentionTools(ctx: Context, readSettings: () => AtFileSettings): (() => void)[] | undefined;
