import type { Dir } from 'node:fs';
import type { FileEntry, FileIgnoreRuleInput } from './contract.ts';
/** Options for one bounded index pass. */
export interface IndexOptions {
    /** Hard cap on collected files. */
    readonly maxFiles: number;
    /** Directory basenames the walk skips (children never enqueue). */
    readonly ignoreDirs: readonly string[];
    /** Exact and Regex basename filters applied before files enter the index. */
    readonly ignoreFiles: readonly FileIgnoreRuleInput[];
}
/** One index pass result: the sorted file list plus the honest truncation flag. */
export interface WorkspaceIndex {
    readonly files: readonly FileEntry[];
    /** True when the walk hit `maxFiles` before the tree was exhausted. */
    readonly truncated: boolean;
}
/** Directory opener seam used by the real filesystem and deterministic tests. */
export type OpenWorkspaceDirectory = (path: string) => Promise<Dir>;
/**
 * Collect every regular file under `root` (bounded, name-sorted).
 * @param root - workspace root to walk.
 * @param options - cap and ignore list.
 * @param signal - caller lifetime; every filesystem await races it.
 * @param openDirectory - directory opener; defaults to node:fs.
 * @returns the sorted file list and the truncation flag.
 */
export declare function indexWorkspace(root: string, options: IndexOptions, signal?: AbortSignal, openDirectory?: OpenWorkspaceDirectory): Promise<WorkspaceIndex>;
/**
 * List the DIRECT subdirectories of one directory (one level, never recursive).
 *
 * Used to offer the folders around a session workspace — the sibling checkouts
 * a plugin author routinely needs, e.g. the DSH source tree beside the workspace
 * — without walking anything: one `opendir` of one directory. Symlinks are
 * skipped exactly like the workspace walk skips them (a link cycle can never
 * strand this), ignore-listed directory names are skipped by basename, and the
 * bounded result is name-sorted.
 * @param dir - absolute directory to list.
 * @param options - cap and the ignored directory basenames.
 * @param signal - caller lifetime; the filesystem awaits race it.
 * @param openDirectory - directory opener; defaults to node:fs.
 * @returns absolute child directory paths, name-sorted and capped.
 */
export declare function listSubdirectories(dir: string, options: {
    readonly limit: number;
    readonly ignoreDirs: readonly string[];
    readonly skipHidden?: boolean;
    readonly followLinks?: boolean;
}, signal?: AbortSignal, openDirectory?: OpenWorkspaceDirectory): Promise<readonly string[]>;
/** One row of a one-level directory listing: a name and what it is. */
export interface DirectoryEntryInfo {
    readonly name: string;
    readonly kind: 'file' | 'dir';
    /** True only on the one row {@link pinEntry} put back; absent on ordinary rows. */
    readonly pinned?: true;
}
/** One directory's direct children, name-sorted with directories first. */
export interface DirectoryContents {
    readonly entries: readonly DirectoryEntryInfo[];
    /** True when the entry cap cut the listing short. */
    readonly truncated: boolean;
}
/**
 * List ONE directory's direct children, files included.
 *
 * The folder browser and the folder tab need what a file manager shows — both
 * kinds, in one level — where {@link listSubdirectories} answers "which folders
 * are next to this one". A link (junction or symlink) is reported as what it
 * POINTS AT and dropped when it points at nothing, because a row the user cannot
 * enter is worse than no row. Directories come first, then names, so the shape of
 * the tree reads before its contents do.
 * @param dir - absolute directory to list.
 * @param limit - hard cap on returned entries.
 * @param signal - caller lifetime; the filesystem awaits race it.
 * @param openDirectory - directory opener; defaults to node:fs.
 * @returns the entries and whether the cap was reached.
 */
export declare function readDirectory(dir: string, limit: number, signal?: AbortSignal, openDirectory?: OpenWorkspaceDirectory): Promise<DirectoryContents>;
/**
 * Put ONE named child back into a listing whose cap already cut it away.
 *
 * {@link readDirectory} stops at its cap BEFORE it sorts, so on a folder with
 * thousands of children the returned page can simply not contain the entry the
 * caller asked about — measured on a real share: a 2093-entry folder answered
 * 200 rows that held neither the file whose folder was opened nor 10 of its
 * siblings. The folder tab has exactly one such entry (the object the user just
 * clicked) and "open the folder with it selected" is a promise it cannot keep
 * from a page that never included it. Re-checking that ONE name by path costs a
 * single `stat`, and the row goes FIRST so it needs no scrolling to be seen.
 *
 * The name is re-validated against the filesystem rather than trusted, so a
 * reference to something that no longer exists adds no row (the listing stays
 * honest), and only a single path segment is accepted, so a caller cannot walk
 * out of the listed directory through this seam.
 * @param dir - absolute directory the listing came from.
 * @param contents - the capped listing to complete.
 * @param name - the one child name to ensure; empty or multi-segment means none.
 * @param signal - caller lifetime; the filesystem awaits race it.
 * @returns the listing, with the named child first when it exists and was cut.
 */
export declare function pinEntry(dir: string, contents: DirectoryContents, name: string, signal?: AbortSignal): Promise<DirectoryContents>;
/**
 * Answer "does this directory have at least one subdirectory?" and stop there.
 *
 * The folder chooser draws an expander only on rows that open, so it needs this
 * per candidate row — and {@link readDirectory} cannot answer it cheaply: its cap
 * cuts the listing BEFORE the sort, so `readDirectory(dir, 1)` may well return a
 * file and say nothing about the directories below. This walks the same handle
 * one entry at a time and returns on the FIRST directory, so the cost is one
 * `opendir` and as many reads as it takes to meet a folder (usually one).
 *
 * A link is judged by what it points at, exactly like {@link readDirectory}, so a
 * junction to a folder counts; `skipHidden` drops dot-names before they count.
 * @param dir - absolute directory to probe.
 * @param options - whether hidden children are ignored.
 * @param signal - caller lifetime; the filesystem awaits race it.
 * @param openDirectory - directory opener; defaults to node:fs.
 * @returns true when at least one subdirectory (or link to one) is present.
 */
export declare function hasSubdirectory(dir: string, options?: {
    readonly skipHidden?: boolean;
}, signal?: AbortSignal, openDirectory?: OpenWorkspaceDirectory): Promise<boolean>;
