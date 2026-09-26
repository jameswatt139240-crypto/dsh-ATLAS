import type { AtFileSettings, ExternalRef, FileIgnoreRule, FileIgnoreRuleInput, WorkspaceIgnoreFiles, WorkspaceRecentFiles } from './contract.ts';
/** Directory basenames omitted from the picker unless the profile supplies its own list. */
export declare const DEFAULT_IGNORE_DIRS: readonly [".git", ".hg", ".svn", ".idea", ".vs", ".vscode", ".fleet", ".history", ".metadata", ".settings", "node_modules", "bower_components", "vendor", "Pods", ".gradle", ".kotlin", ".cxx", ".externalNativeBuild", ".dart_tool", ".swiftpm", ".build", ".cache", ".parcel-cache", ".turbo", ".nx", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv", ".next", ".nuxt", ".output", ".svelte-kit", ".angular", "build", "bin", "dist", "out", "target", "obj", "coverage", "DerivedData", "xcuserdata", "CMakeFiles", "cmake-build-debug", "cmake-build-release", "cmake-build-relwithdebinfo", "cmake-build-minsizerel", "_deps", ".godot", "Library", "Temp", "Logs", "Binaries", "Intermediate", "Saved", "DerivedDataCache"];
/** File basenames omitted from the picker unless the Web setting replaces the list. */
export declare const DEFAULT_IGNORE_FILES: readonly ["desktop.ini", "Thumbs.db", ".DS_Store"];
/** Fresh settings defaults for Host and browser initialization. */
export declare function defaultAtFileSettings(): AtFileSettings;
/** Trim rules and remove empty entries or duplicates with identical matching semantics. */
export declare function normalizeIgnoreFiles(values: readonly FileIgnoreRuleInput[]): FileIgnoreRuleInput[];
/** Convert one legacy or structured setting value into its canonical rule. */
export declare function normalizeIgnoreRule(value: FileIgnoreRuleInput): FileIgnoreRule | undefined;
/** Stable identity for one rule, including matching semantics. */
export declare function ignoreRuleKey(value: FileIgnoreRuleInput): string;
/** Compile rules once for a bounded directory walk. */
export declare function compileIgnoreRules(values: readonly FileIgnoreRuleInput[]): readonly FileIgnoreRule[];
/** Stable comparison key for one canonical workspace path. */
export declare function workspacePathKey(value: string): string;
/** Merge duplicate workspace rows and normalize every file-name list. */
export declare function normalizeWorkspaceIgnoreFiles(entries: readonly WorkspaceIgnoreFiles[]): WorkspaceIgnoreFiles[];
/** Workspace-local file-name filters for one canonical cwd. */
export declare function workspaceIgnoreFilesFor(entries: readonly WorkspaceIgnoreFiles[], workspace: string): FileIgnoreRuleInput[];
/** Effective file-name filters for one workspace: global rules plus local additions. */
export declare function effectiveIgnoreFiles(settings: AtFileSettings, workspace: string): FileIgnoreRuleInput[];
/** Stable cache key covering every file-name filter setting. */
export declare function ignoreFilesSettingsKey(settings: AtFileSettings): string;
/** Maximum recently referenced files kept per workspace. */
export declare const MAX_RECENT_FILES = 20;
/**
 * Normalize the durable recent-file rows: deduplicate workspaces, drop empty
 * lists, trim whitespace, and keep files most-recent-first.
 */
export declare function normalizeWorkspaceRecentFiles(values: readonly WorkspaceRecentFiles[]): WorkspaceRecentFiles[];
/** The recent-file list for one workspace (most recent first). */
export declare function recentFilesFor(settings: AtFileSettings, workspace: string): readonly string[];
/**
 * Record one referenced relative path in the workspace's recent list (moves
 * it to the front). Returns the next durable `recentFiles` value.
 */
export declare function recordRecentFile(settings: AtFileSettings, workspace: string, relative: string): WorkspaceRecentFiles[];
/** Cross-category usage rows as stored in settings. */
type UsageRows = NonNullable<AtFileSettings['usage']>;
/** One cross-category usage row. */
type UsageRow = UsageRows[number];
/** Maximum out-of-workspace references kept in the durable ledger. */
export declare const MAX_EXTERNAL_REFS = 100;
/** How many workspaces one ledger row remembers (most recent first). */
export declare const MAX_EXTERNAL_WORKSPACES = 8;
/**
 * Normalize the durable out-of-workspace ledger: drop empty paths, deduplicate
 * by canonical path key (keeping the highest count and the newest use), and sort
 * most-recently-used first.
 * @param values - raw ledger rows from settings.
 * @returns the normalized ledger, bounded by the plugin maximum.
 */
export declare function normalizeExternalRefs(values: readonly ExternalRef[] | undefined): ExternalRef[];
/**
 * Record one out-of-workspace reference into the ledger (moves it to the front
 * and counts the use). Callers pass the already-normalized ledger.
 * @param settings - live settings.
 * @param path - canonical absolute path with forward slashes.
 * @param kind - what the path is.
 * @param workspace - the workspace it was referenced from.
 * @param now - epoch milliseconds of this use.
 * @returns the next durable `externalRefs` value.
 */
export declare function recordExternalRef(settings: AtFileSettings, path: string, kind: 'file' | 'dir', workspace: string, now: number): ExternalRef[];
/**
 * The ledger directories a session may reference into while it may not discover
 * new external paths: directories referenced from this workspace first, then the
 * rest of the ledger (so a path used in another workspace still works).
 * @param settings - live settings.
 * @param workspace - the session workspace root.
 * @returns candidate root directories, most relevant first.
 */
export declare function externalRootsFor(settings: AtFileSettings, workspace: string): readonly string[];
/**
 * Every ledger path a narrow session may reference EXACTLY (files included),
 * this workspace's entries first.
 * @param settings - live settings.
 * @param workspace - the session workspace root.
 * @returns ledger paths, most relevant first.
 */
export declare function externalKnownFor(settings: AtFileSettings, workspace: string): readonly string[];
/**
 * Split the ledger into the two things the access gate needs: directories that
 * may be referenced INTO, and every path that may be referenced EXACTLY.
 * Entries referenced from this workspace come first in both lists.
 * @param settings - live settings.
 * @param workspace - the session workspace root.
 * @returns the roots and the known paths for this workspace.
 */
export declare function externalLedgerFor(settings: AtFileSettings, workspace: string): {
    roots: readonly string[];
    known: readonly string[];
};
/** Maximum cross-category usage counters kept (the most-picked win). */
export declare const MAX_USAGE_ENTRIES = 200;
/**
 * Normalize the durable usage rows: drop blanks, collapse duplicate keys to the
 * highest count, and order by count then recency.
 * @param values - the stored rows.
 * @returns the bounded rows, most-picked first.
 */
export declare function normalizeUsage(values: UsageRows): UsageRow[];
/**
 * Record one pick in the cross-category usage counters: the key is
 * `${mentionKind}:${value}`, so every category the picker understands counts
 * through the same path.
 * @param settings - the live settings value.
 * @param key - the `${kind}:${value}` pick key.
 * @param now - the pick time (epoch ms); injectable for deterministic tests.
 * @returns the next durable `usage` value, most-picked first.
 */
export declare function recordUsage(settings: AtFileSettings, key: string, now?: number): UsageRow[];
export {};
