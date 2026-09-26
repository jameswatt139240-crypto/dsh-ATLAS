/**
 * Pure display projections for the @file picker: the split of a relative path
 * into basename + directory for the picker rows. The Host validates selected
 * paths and adds existence-only reference markers at send time.
 */
/** The directory prefix of a forward-slash relative path ('' for root-level files). */
export declare function dirnameOf(relative: string): string;
/** The basename of a forward-slash relative path. */
export declare function basenameOf(relative: string): string;
/**
 * Derive the canonical workspace path from an absolute file path and its
 * workspace-relative path (the index walk emits forward-slash relatives).
 */
export declare function workspaceFromAbsolute(absolute: string, relative: string): string;
/**
 * The canonical key one referenced path is looked up under.
 *
 * A verdict and the token it answers for do not always spell a path the same
 * way: the Host answers an out-of-workspace path in its own canonical spelling
 * (forward slashes) while the user typed the platform's (`@E:\…`), and a folder
 * mention may carry a trailing separator the path itself has not. Every verdict
 * map is keyed — and every lookup made — through this, so the answer is found
 * whichever spelling the draft used.
 * @param value - a referenced path in either separator spelling.
 * @returns the key both sides agree on.
 */
export declare function referenceKey(value: string): string;
/**
 * One child path under one directory, safe at a drive root.
 *
 * A listing's `path` carries a trailing separator only when it IS a drive root
 * (`E:/`), so a plain `${path}/${name}` would produce `E://name` there. Both the
 * folder tab and the menu browser join paths through this.
 * @param path - the listing's own canonical path.
 * @param name - one entry name.
 * @returns the child's canonical path.
 */
export declare function childOf(path: string, name: string): string;
