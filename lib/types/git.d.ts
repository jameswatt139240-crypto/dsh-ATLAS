import type { AtlasProvider } from './atlas.ts';
import { type GitChange } from './contract.ts';
/**
 * Parse porcelain v1 output into changes, dropping ignored directories.
 * @param output - the raw `git status --porcelain=v1` text.
 * @returns one entry per changed path, in git's order.
 */
export declare function parseGitStatus(output: string): readonly GitChange[];
/**
 * Parse `git diff --numstat` output into per-path line counts.
 * @param output - the raw numstat text.
 * @returns a path-keyed count map; binary files have no counts and are absent.
 */
export declare function parseGitNumstat(output: string): ReadonlyMap<string, {
    added: number;
    removed: number;
}>;
/**
 * The workspace's changed paths, with line counts where Git can count them.
 * @param cwd - the workspace directory.
 * @param signal - caller lifetime.
 * @returns the changes, or an empty list outside a Git workspace.
 */
export declare function readGitChanges(cwd: string, signal: AbortSignal): Promise<readonly GitChange[]>;
/**
 * The diff for one changed path. A path Git sees as unchanged against HEAD is
 * retried against the empty file, so an untracked path's content arrives as
 * Git's own "new file" hunk rather than as a file read.
 * @param cwd - the workspace directory.
 * @param path - the repository-relative path being committed.
 * @param signal - caller lifetime.
 * @returns the diff text, or undefined when Git produced none.
 */
export declare function readGitDiff(cwd: string, path: string, signal: AbortSignal): Promise<string | undefined>;
/**
 * The built-in `@git` provider's injection half.
 *
 * This is the seam's worked example, and it is deliberately not privileged: it
 * declares `scopes`/`testedOn` and goes through the same registry and the same
 * version gate as a third-party provider. Its menu half is registered in the
 * browser (see `client/git-provider.ts`) because the candidates must be filtered
 * per keystroke while the repository lives on the Host.
 */
export declare const GIT_RESOLVE_PROVIDER: AtlasProvider;
