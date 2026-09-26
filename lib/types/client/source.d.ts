/**
 * The '@' input-trigger source: turns the ui-input-trigger pipeline into the
 * category-based mention picker. An empty query shows the category rows
 * (files, folders, skills, past chats, plugins); typing without choosing
 * shows a mixed result list that prioritizes files/folders/skills while the
 * category rows stay pinned; `file:`, `folder:`, `skill:`, `chat:`,
 * `plugin:` prefixes enter one category. Picks land plain-text tokens that
 * the Host's pre-step boundary validates and expands into sourced references.
 * Pure factory over injected deps: the browser bundle wires the real Remotes
 * and clock, tests wire stubs.
 */
import type { InputTriggerCandidate, InputTriggerSource, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ChatCandidate, FileEntry, PluginCandidate, SkillCandidate } from './remote.ts';
import type { DirectoryListing, ExternalAccessScope, UsageEntry } from '../contract.ts';
import type { AtlasRegistration } from '../atlas.ts';
import type { SkillTier } from '../contract.ts';
import { type ReferenceLink } from './reference-links.ts';
declare module '@deepseek-ai/dsh-client-ui-input-trigger/client' {
    interface InputTriggerCandidate {
        /** Source-owned stable value when the visible name is only a display label. */
        readonly value?: string;
        /** Indexed path kind used by source-owned keyboard navigation. */
        readonly atFileKind?: FileEntry['kind'];
        /** Routing kind for the category state machine and the dock. */
        readonly mentionKind?: MentionKind;
        /** Host-built `dsh-session:` URI for one chat candidate row. */
        readonly chatUri?: string;
        /** Stable collapse key for group header rows (chat:/skill:). */
        readonly groupKey?: string;
        /** Recent-file rows may be pickable before the workspace index settles. */
        readonly recent?: boolean;
    }
}
/** One mention row kind the picker and the dock both understand. */
export type MentionKind = 'category' | 'back' | 'file' | 'dir' | 'skill' | 'chat' | 'plugin' | 'provider' | 'chat-group' | 'skill-group' | 'plugin-group' | 'section-header' | 'dir-group' | 'folder-choose' | 'browse-up' | 'browse-dir' | 'browse-file' | 'browse-drive' | 'browse-note';
/** Owner source name (the lexicon and decoration routing key). */
export declare const SOURCE_NAME = "atlas";
/** Design cap on visible picker rows (the menu height is maximized by CSS). */
export declare const MAX_CANDIDATES = 20;
/** How many provider rows one mixed search may contribute in total. */
export declare const PROVIDER_MIX_LIMIT = 6;
/** How long one session's index stays hot before the next menu open refetches. */
export declare const INDEX_TTL_MS = 30000;
/** How long the per-session skill list and the global plugin list stay hot. */
export declare const CATEGORY_TTL_MS = 30000;
/** One preloaded page of past-chat candidates (menu height is 12; 20 gives headroom). */
export declare const CHAT_PAGE = 20;
/** One category key (folder rows are routed as dir mentions). */
export type CategoryKey = 'file' | 'folder' | 'skill' | 'chat' | 'plugin' | 'provider';
/** One selectable category row. */
export interface CategoryDef {
    readonly key: CategoryKey;
    /** The draft prefix that enters this category (`@skill:` etc.). */
    readonly prefix: string;
    /** Built-in Chinese label, used when no locale binder is wired. */
    readonly name: string;
    /** Locale key of the displayed label (see client/locales.ts). */
    readonly nameKey: string;
    /** Single-letter shortcut shown in the menu and accepted after `@`. */
    readonly shortcut: string;
    /** English name prefix matched for completion (e.g. `pl` → plugin). */
    readonly english: string;
    /**
     * Set on rows built from a registered `@` seam provider: it is the provider
     * handle whose `list` fills the category and whose `resolve` the pick routes to.
     */
    readonly providerId?: string;
}
/** Locale binder shape shared by the row builders (dictionary key → copy). */
export type Translate = (key: string, params?: Record<string, string>) => string;
/** The five categories, shown in menu order. */
export declare const CATEGORIES: readonly CategoryDef[];
/**
 * Build the menu categories for the currently registered `@` seam providers.
 *
 * These are dynamic rows: a provider that registers while the app runs shows up
 * on the next menu open, and one that disposes disappears with it. A provider
 * claims a shortcut letter when it can — the first letter of its id, upper-cased,
 * and only while no built-in category (or an earlier provider) already answers to
 * it. A letter that means two things is worse than no letter, and the explicit
 * `@<id>:` prefix always works either way.
 * @param providers - the live registrations from the seam registry.
 * @returns one category definition per provider, in registration order.
 */
export declare function providerCategories(providers: readonly {
    readonly id: string;
    readonly display: string;
}[]): readonly CategoryDef[];
/** Everything the source needs that the browser bundle supplies (tests stub). */
export interface MentionSourceDeps {
    /** Search the addressed session's workspace index (Remote wrapper). */
    search(sessionId: SessionId, signal: AbortSignal): Promise<readonly FileEntry[]>;
    /** List discoverable skills for the addressed session (Remote wrapper). */
    listSkills?(sessionId: SessionId, signal: AbortSignal): Promise<readonly SkillCandidate[]>;
    /** List past-session candidates for the addressed session (Remote wrapper). */
    listChats?(sessionId: SessionId, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]>;
    /** List installed plugins (Remote wrapper). */
    listPlugins?(signal: AbortSignal): Promise<readonly PluginCandidate[]>;
    /** Monotonic clock for index freshness (default Date.now). */
    now?: () => number;
    /** Locale binder for time/tier labels (defaults to zh copy). */
    t?: (key: string, params?: Record<string, string>) => string;
    /** Record one referenced path into the session workspace's recent list. */
    onRecent?(sessionId: SessionId, relative: string): void;
    /** Record one pick in the cross-category usage counters. */
    onUsage?(sessionId: SessionId, kind: string, value: string): void;
    /** The live cross-category pick counters (highest count first). */
    usage?(): readonly UsageEntry[];
    /**
     * The live `@` seam providers. Called on every menu request; a provider that
     * is not registered here is never listed, so registration stays the gate.
     */
    atlasProviders?(): readonly AtlasRegistration[];
    /** The session workspace's recent-file list for one workspace, most recent first. */
    recentFiles?(sessionId: SessionId, workspace: string): readonly string[];
    /**
     * The Host's out-of-workspace scope for one session: whether it may discover
     * external paths, and the external folders `@folder:` may offer. The Host owns
     * this verdict (settings plus the resolved sandbox policy); the source only
     * renders what it returns.
     */
    external?(sessionId: SessionId, signal: AbortSignal): Promise<ExternalAccessScope>;
    /**
     * One bounded, one-level directory listing (the folder browser's data). The Host
     * gates an out-of-workspace path exactly as it gates a reference, and answers a
     * refusal as a reason, so a missing member simply means "no browser here".
     */
    list?(sessionId: SessionId, path: string, signal: AbortSignal): Promise<DirectoryListing>;
    /**
     * The folder the composer's DRAFT is scoped by (R-05): the nearest folder
     * reference typed before the active category token. `@e:/work/docs/ @file:` therefore
     * lists that folder's files — the scope is positional, so no connective word is
     * needed. Undefined when the draft names none, which is this view's behaviour
     * before the scope existed.
     */
    scopeFolder?(sessionId: SessionId, signal: AbortSignal): Promise<string | undefined>;
    /**
     * Open the product's own folder chooser for one draft token span, answering
     * whether this build has one. The chooser is asynchronous (a native or in-app
     * dialog), so it takes over the insertion itself; a `false` answer lets the
     * source fall back to its own in-menu walk.
     */
    chooseFolder?(sessionId: SessionId, span: TokenSpan): boolean;
    /**
     * The click action for one mention of the draft, or undefined when this build
     * has none. Used by {@link InputTriggerSource.openReference}: a client that
     * activates a reference token in the composer asks its owning source to open
     * it, and the plugin answers with the same action the sent-message bridge uses.
     */
    actionFor?(sessionId: SessionId, link: ReferenceLink): (() => void) | undefined;
}
/** The registered source plus the cache teardown the wiring layer owns. */
export interface MentionSource {
    readonly source: InputTriggerSource;
    /** Drop every per-session cache and path map (connection reset). */
    invalidateAll(): void;
    /** Drop one session's out-of-workspace scope (a sent reference may have grown the ledger). */
    invalidateExternal(sessionId: SessionId): void;
    /** Toggle one group header's collapse state for a session (menu re-tracks). */
    toggleGroup(sessionId: SessionId, key: string): void;
    /** Whether a group header is currently collapsed for a session. */
    isCollapsed(sessionId: SessionId, key: string): boolean;
    /**
     * Rebuild the candidate rows for one category query synchronously from the
     * settled caches (instant collapse without a refetch). Returns undefined
     * when the needed cache is not settled yet — callers fall back to a refresh.
     */
    rebuildRows(sessionId: SessionId, query: string): readonly MentionCandidate[] | undefined;
}
/** One picker row with a stable value and routing kind. */
interface MentionCandidate extends InputTriggerCandidate {
    readonly value: string;
    readonly mentionKind: MentionKind;
    /** Set on provider rows: whose `resolve` the committed reference routes to. */
    readonly providerId?: string;
    /** Set on the Tab-completion hint, which is the row the highlight belongs on. */
    readonly completionHint?: true;
}
/** Resolve the active category from a `file:`-style query prefix. */
export declare function categoryOfQuery(query: string, providers?: readonly CategoryDef[]): CategoryDef | undefined;
/**
 * The always-pinned category rows for the empty/mixed view.
 * @param t - locale binder.
 * @param providers - the live `@` seam providers, appended after the built-ins.
 * @returns the category rows in menu order.
 */
export declare function categoryRows(t?: Translate, providers?: readonly CategoryDef[]): readonly MentionCandidate[];
/**
 * Resolve the single category the user's typed query points at, or undefined
 * when it is ambiguous.
 *
 * A query matching exactly one shortcut letter (F/D/S/C/P, plus whatever letter
 * a registered provider claimed — `G` for `@git`) or exactly one English name
 * prefix (fi/fo/sk/ch/pl…, and a provider's own id, so `gi` reaches git) wins;
 * otherwise the completion stays unavailable so plain mixed search keeps working.
 * @param query - the text after the trigger.
 * @param providers - the live provider categories, which compete on equal terms.
 * @returns the category the query names, or undefined.
 */
export declare function completionTarget(query: string, providers?: readonly CategoryDef[]): CategoryDef | undefined;
/**
 * The hint row a completion query puts at the END of the list.
 *
 * It is a category row like the one it repeats (same `value`, so a pick enters
 * the same `@<category>:` prefix) plus `completionHint`, which is the flag the
 * navigator uses to land the default highlight here: the menu opens above the
 * composer, so the last row is the one closest to the caret and the eye stays in
 * the bottom band instead of jumping to the top of the list.
 */
export declare function hintRow(category: CategoryDef, t?: Translate): MentionCandidate;
/** The row tag for one mention kind, localized when a binder is supplied. */
export declare function categoryTag(kind: 'file' | 'folder' | 'skill' | 'chat' | 'plugin', t?: Translate): string;
/** The back row shown inside one category. */
export declare function backRow(t?: Translate): MentionCandidate;
/** A non-pickable section divider row (e.g. 最近引用 / 全部匹配). */
export declare function sectionHeaderRow(label: string): MentionCandidate;
/** Relative-time buckets, mirroring the sidebar workspace rows. */
export interface RelativeTime {
    readonly unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
    readonly n: number;
}
/** Compact relative time ("刚刚"/"5分钟"…), same buckets as the sidebar. */
export declare function relativeTime(updatedAt: number, now: number): RelativeTime;
/** Render one relative time as the sidebar does ("刚刚"/"5分钟"/"2天"). */
export declare function relativeTimeLabel(updatedAt: number, now: number, t?: (key: string, params?: Record<string, string>) => string): string;
/** Skill tier labels (mirror the sidebar Skill Manager grouping). */
export declare const TIER_ORDER: readonly SkillTier[];
/**
 * Clean a session title for display and the mention token: trim, drop leading
 * markdown heading markers (#), collapse internal whitespace, cap at 40 chars.
 */
export declare function cleanChatLabel(label: string): string;
/** The workspace title for one chat group (basename; 未分组 for none). */
export declare function workspaceTitle(cwd: string | undefined, t?: Translate): string;
/**
 * Damerau–Levenshtein distance between two short strings (optimal string
 * alignment). Used for typo-tolerant mention search.
 */
export declare function editDistance(a: string, b: string): number;
/**
 * Typo-tolerant match: substring OR any word token of the field within edit
 * distance (1 for short queries, 2 for queries of 8+ chars). Enables e.g.
 * `qulity` → `animation-quality-gate` via its `quality` token.
 */
export declare function matchesFuzzy(query: string, ...fields: readonly string[]): boolean;
/**
 * Rank files for one query, falling back to typo tolerance only when the exact
 * ranking returns nothing — so a near miss can never displace an exact match.
 * @param files - the workspace index.
 * @param query - the user's query.
 * @param limit - maximum rows.
 * @returns the ranked entries.
 */
export declare function rankFilesWithFuzzy(files: readonly FileEntry[], query: string, limit: number): readonly FileEntry[];
/**
 * The directory a draft query asks to walk, or undefined when it is a search.
 *
 * Both spellings reach the browser: the bare mention the browser's own picks write
 * (`@E:/…/`) and the category form a user may type (`@folder:E:/…`). A drive letter
 * alone is its root, so `@folder:E:` is enough to leave the drive you are on. A
 * FILE path is not a special case: it browses the directory it lives in, where the
 * file itself is a row — which is what makes typing a path feel like a path.
 * @param query - the live query (text after `@`).
 * @returns the absolute directory to list, or undefined for an ordinary search.
 */
export declare function browseTarget(query: string): string | undefined;
/** The collapse key of the out-of-workspace folder group. */
export declare const OUTSIDE_GROUP_KEY = "folder:outside";
/** The collapse key of the workspace folder group. */
export declare const WORKSPACE_GROUP_KEY = "folder:workspace";
/**
 * How many rows the folder category shows at most (headers included).
 *
 * The user's口径: the visible area must always be the folders whose NAME matched —
 * workspace first, then outside — and the folder view must not FOLD rows away to
 * stay short. Beyond what fits on screen the menu SCROLLS (with PageUp/PageDown,
 * and the focus row is kept visible), so this is only the hard ceiling that keeps
 * one category from flooding the menu; the name matches still claim the top rows
 * and the path-only group fills whatever is left.
 */
export declare const FOLDER_ROW_BUDGET = 20;
/** The collapse key of the path-only matches (folded, so they never bury the name hits). */
export declare const PATH_GROUP_KEY = "folder:path";
/**
 * How many rows the `@file:` view shows at most, headers included.
 *
 * The same口径 as the folder view (R-03/R-05): the user asked for the two views to
 * behave alike, so this is deliberately the same ceiling — and the same answer to
 * "more than fits": scroll, don't truncate the priority rows away.
 */
export declare const FILE_ROW_BUDGET = 20;
/** The collapse key of the file view's path-only matches. */
export declare const FILE_PATH_GROUP_KEY = "file:path";
/**
 * The row that starts walking the filesystem from the session workspace root.
 *
 * It is the folder category's default highlight, because the case this feature
 * exists for is "a folder that is NOT in my workspace" — and a user who wants one
 * of the workspace rows does not need to travel through it.
 * @param t - locale binder.
 * @returns the row (its pick drafts the workspace root and keeps the menu open).
 */
export declare function folderChooseRow(t?: Translate): MentionCandidate;
/** The stable collapse key for one skill tier. */
export declare function skillGroupKey(tier: SkillTier): string;
/** The stable collapse key for one skill domain inside a tier. */
export declare function skillDomainKey(tier: SkillTier, domain: string): string;
/** The domain of a skill: the prefix before the first '-' (e.g. blender-modeling → blender). */
export declare function domainOf(skillName: string): string;
/** The scope group of one plugin module: the npm scope (e.g. @deepseek-ai) or 其他. */
export declare function pluginScope(moduleName: string): string;
/** The stable collapse key for one plugin scope group. */
export declare function pluginGroupKey(scope: string): string;
/** The stable collapse key for one chat workspace group. */
export declare function chatGroupKey(cwd: string | undefined): string;
/**
 * Build the '@' trigger source over the injected deps. One source per plugin
 * fiber; per-session caches live in the returned closure and die with it.
 * @param deps - Remote, locale, and clock faces.
 * @returns the source to register with `inputTriggers.registerSource`, plus
 *   the cache invalidator.
 */
export declare function createMentionSource(deps: MentionSourceDeps): MentionSource;
export {};
