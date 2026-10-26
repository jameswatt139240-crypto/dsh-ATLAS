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
}
/**
 * A SESSION reference: selecting it switches the current session, which is a
 * main-area navigation rather than a resource the Sidebar could show.
 */
 | {
    readonly kind: 'session';
    readonly sessionId: string;
};
/**
 * Is this mention body spelled with a handle that names a label rather than a
 * resource? Callers that read a raw token (the chip decoder, the draft's own
 * path resolver) must skip these: the scope inside a scoped plugin mention is
 * part of the module name, and reading it as a path invents a file that no
 * workspace holds (m05904).
 * @param raw - the mention body, without its leading `@`.
 * @returns true when the body is one of our inert handles.
 */
export declare function isInertHandle(raw: string): boolean;
/**
 * Decode one reference chip's raw label (its `title`) into the action it offers.
 *
 * The chip's own `title` is the label the framework decorated, verbatim:
 * `@path/to/file.ts`, `@"path with spaces.md"`, `@skill:name`, `@plugin:name`,
 * `@atlas:provider/item`, `@[label](dsh-session:…)`, or an out-of-workspace
 * absolute path (`@E:\…` / `@E:/…`, whose drive letter is a path, not a handle).
 * Only a workspace file, a quoted path, an absolute path, a skill (whose source
 * the skill source opens), a provider item (whose meaning belongs to that
 * provider) and a wire session mention (whose payload names its session) name
 * something to act on. A trailing separator is a folder mention (its chip kind
 * is `folder`), and a colon in the first segment is our own handle spelling
 * unless it is a drive letter.
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
 *
 * A bare `@label` is deliberately left to the caller's
 * `resolveSessions`: opening one as a session needs the live session list, and
 * a token that names no session must still fall through to being a file path
 * (`@docs` is a directory long before it is a session title). The wire session
 * form needs no list, so it is decoded right here.
 * @param token - the activated token, trigger included (e.g. `@src/a.ts`).
 * @returns the mention, or undefined when nothing can be opened.
 */
export declare function decodeDraftReference(token: string): ReferenceLink | undefined;
/**
 * The session one DRAFT token names, when the token itself says so.
 *
 * Only the wire form answers here: a bare label needs {@link SessionLabelResolver}
 * and the live list, which is the caller's business (see `draftActivation`).
 * @param token - one draft token, `@` included.
 * @returns the session id to switch to, or undefined when the token carries none.
 */
export declare function draftSessionId(token: string): string | undefined;
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
 * What a folder tab is told to select when it opens.
 *
 * A folder tab is opened by ADDRESS, and an address is the tab's identity — a
 * second open of the same folder must not open a second tab — so the thing to
 * select cannot ride the address itself (it is not part of the folder's name,
 * and the tab's own title reads the address). It rides the open options instead:
 * `openResource(address, { params })` lands them on `tab.navigation.params`, a
 * value the tab re-reads on every navigation. This plugin owns the `folder`
 * resource type, so it also owns the shape of that value: {@link selectionOf} is
 * the single reader of the key below.
 */
export interface FolderSelectionParams {
    /** The name (one path segment) of the child to select in the opened folder. */
    readonly select?: string;
}
/**
 * The folder a path LIVES IN, plus the name to select in it.
 *
 * "Click a reference twice and you get its owning folder, with the reference
 * selected" — so this answers the pair, for a file and for a folder alike (a
 * folder's own owning folder is its parent). Purely lexical on purpose: it must
 * answer for a path whose neighbours are unknown, and the caller is the one that
 * knows how to turn a relative answer into an absolute path.
 * @param path - the reference path, either separator spelling.
 * @returns the parent directory in canonical (forward-slash) spelling (`''` = the
 * top of a relative path, `/` for the POSIX root, `E:/` for a drive root) and the
 * segment to select there. The spelling is normalized for the same reason
 * {@link folderAddress} normalizes it: the answer is compared against index keys
 * and turned into an address, and both of those speak one spelling.
 */
export declare function owningFolderOf(path: string): {
    readonly dir: string;
    readonly select: string;
};
/**
 * The child one folder tab was told to select, or undefined when it was told
 * nothing.
 *
 * Reads `unknown` rather than {@link FolderSelectionParams} because the value
 * arrives from the product's navigation state, which this plugin does not own:
 * a stale or foreign navigation must read as "nothing to select", never as a
 * crash or as a wrong row.
 * @param params - `tab.navigation.params`, as delivered.
 * @returns the segment to select, or undefined.
 */
export declare function selectionOf(params: unknown): string | undefined;
/**
 * The folder one address names, or undefined when it is not ours.
 * @param address - a resource address.
 * @returns the absolute path in canonical (forward-slash) spelling.
 */
export declare function folderPathOf(address: string | undefined): string | undefined;
