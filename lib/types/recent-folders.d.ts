/** Why one candidate folder is being offered (the client groups by this). */
export type RecentFolderReason = 'sibling' | 'parent' | 'child' | 'recent' | 'family';
/** One offered folder: its absolute path, a display name, and why it is offered. */
export interface RecentFolder {
    /** Absolute path, forward slashes (the wire spelling used everywhere else). */
    readonly path: string;
    /** Last path segment, for the row label. */
    readonly name: string;
    /** The strongest reason this folder is in the list. */
    readonly reason: RecentFolderReason;
}
/** How many candidates are offered at most (a bounded menu, like every other list here). */
export declare const RECENT_FOLDER_LIMIT = 8;
/**
 * Where the workspace ledger lives.
 *
 * `DSH_HOME` wins when set, because that is the same override the Harness itself
 * honours; otherwise the ledger sits under the account's own `.dsh`. A test needs
 * to point this somewhere it can control without touching the real home, which is
 * why it is a function rather than a constant.
 * @returns the absolute path of `workspace.json`.
 */
export declare function ledgerPath(): string;
/**
 * Every workspace path the ledger records, with its recency and session count.
 *
 * A missing, unreadable, or malformed ledger answers `[]` rather than throwing:
 * the folder chooser must stay usable on a machine that has never recorded a
 * workspace, and "no candidates" is a legitimate state the UI already renders.
 * @param signal - caller lifetime.
 * @returns the recorded workspaces, or `[]` when there is no usable ledger.
 */
export declare function readWorkspaces(signal: AbortSignal): Promise<readonly RecentFolder[]>;
/**
 * Parse the ledger document's workspace table.
 *
 * Split from the read so the shape handling is testable without a file: the
 * ledger is a versioned store the Harness owns, so each field is treated as
 * untrusted and a row missing its path is dropped instead of producing a row
 * that browses nowhere.
 * @param text - the raw ledger document.
 * @returns the usable workspace rows.
 */
export declare function parseWorkspaces(text: string): readonly RecentFolder[];
/**
 * Order the ledger's workspaces for one current workspace.
 *
 * @param all - every recorded workspace (see {@link readWorkspaces}).
 * @param cwd - the session's current workspace, or '' when it has none.
 * @returns the offered candidates, nearest-relevant first, at most {@link RECENT_FOLDER_LIMIT}.
 */
export declare function rankRecentFolders(all: readonly RecentFolder[], cwd: string): readonly RecentFolder[];
