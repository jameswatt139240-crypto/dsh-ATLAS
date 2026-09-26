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
