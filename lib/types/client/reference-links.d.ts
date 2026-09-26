/**
 * The two pure pieces of the sent-message click-through: decoding one rendered
 * reference chip back into the action it can offer, and spelling the file
 * address the right Sidebar resolves.
 *
 * Both are pure string work so the browser bridge (`ReferenceLinks.tsx`) stays a
 * thin event adapter, and so the address grammar can be pinned against the
 * Harness's own implementation in the tests instead of being trusted by eye.
 */
/** One mention of an already sent message that a click can act on. */
export type ReferenceLink = {
    readonly kind: 'file';
    readonly path: string;
}
/** A directory: no in-product viewer, so the Host opener (file manager) gets it. */
 | {
    readonly kind: 'folder';
    readonly path: string;
} | {
    readonly kind: 'skill';
    readonly name: string;
}
/** A seam provider's item; only that provider's own `open` knows what it means. */
 | {
    readonly kind: 'atlas';
    readonly provider: string;
    readonly item: string;
};
/**
 * Decode one reference chip's raw label (its `title`) into the action it offers.
 *
 * The chip's own `title` is the label the framework decorated, verbatim:
 * `@path/to/file.ts`, `@"path with spaces.md"`, `@skill:name`, `@plugin:name`,
 * `@atlas:provider/item`, `@[label](dsh-session:…)`, or an out-of-workspace
 * absolute path (`@E:\…` / `@E:/…`, whose drive letter is a path, not a handle).
 * Only a workspace file, a quoted path, an absolute path, a skill (whose source
 * the skill source opens) and a provider item (whose meaning belongs to that
 * provider) name something to act on. A trailing separator is a folder mention
 * (its chip kind is `folder`), and a colon in the first segment is our own handle
 * spelling unless it is a drive letter.
 * @param title - the chip's `title` attribute (the undecorated label).
 * @returns the mention, or undefined when there is nothing to open.
 */
export declare function decodeReferenceLink(title: string | null | undefined): ReferenceLink | undefined;
/**
 * Decode one DRAFT reference token the client activated in the composer.
 *
 * Same vocabulary as {@link decodeReferenceLink}, plus the one form the editor
 * decorates by syntax rather than by name: a trailing separator marks a folder
 * mention (`@src/`), whose chip kind is its own and whose click opens the
 * directory through the Host opener.
 * @param token - the activated token, trigger included (e.g. `@src/a.ts`).
 * @returns the mention, or undefined when nothing can be opened.
 */
export declare function decodeDraftReference(token: string): ReferenceLink | undefined;
/**
 * The address of a workspace-relative file in one session: the Harness's
 * `dsh-resource://file/session/<sessionId>/<path>` form, spelled here so the
 * browser bundle needs no new runtime dependency. Backslashes are normalized
 * and a leading `./` is dropped, exactly as the Harness normalizes them; every
 * segment is component-encoded so spaces, `#` and `?` survive the round trip.
 * `tests/reference-links.spec.tsx` pins this against the Harness function.
 * @param sessionId - the session whose Host workspace resolves the path.
 * @param path - workspace-relative path in either separator spelling.
 * @returns the file address the right Sidebar claims.
 */
export declare function sessionFileAddress(sessionId: string, path: string): string;
/**
 * The address of a file or directory OUTSIDE the session workspace: the
 * Harness's second file-address scope, `dsh-resource://file/absolute/<path>`
 * (leading separator dropped, a drive letter kept literal, UNC keeping its empty
 * first segment). Out-of-workspace references carry absolute paths, so this is
 * the address the sidebar is asked for. A sidebar that refuses to read outside
 * the workspace (`ui-sidebar-files` says so in its own words) fails harmlessly
 * and the caller keeps the Host opener as the effective action.
 * @param path - absolute path in either separator spelling.
 * @returns the file address the right Sidebar claims, or falls back from.
 */
export declare function absoluteFileAddress(path: string): string;
/**
 * The address of one folder, in this plugin's OWN resource type.
 *
 * A directory cannot ride the `file` type: `dsh-resource://file/…` is claimed by
 * the file viewers, which answer a directory with `"…" is a directory`, and the
 * `files` tab is a PAGE — a tree rooted at the session workspace — that claims no
 * address at all. So the plugin registers a `folder` type of its own and opens
 * folders through it, which is also the only way an out-of-workspace folder can
 * reach the sidebar. The path is absolute (the opener resolves a workspace folder
 * first); every segment is component-encoded so spaces, `#`, `?` and a drive
 * colon survive the round trip.
 * @param path - absolute folder path in either separator spelling.
 * @returns the folder address this plugin's tab claims.
 */
export declare function folderAddress(path: string): string;
/**
 * The folder one address names, or undefined when it is not ours.
 * @param address - a resource address.
 * @returns the absolute path in canonical (forward-slash) spelling.
 */
export declare function folderPathOf(address: string | undefined): string | undefined;
