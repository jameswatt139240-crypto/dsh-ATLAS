/**
 * The built-in `@git` provider's menu half — and the seam's worked example of a
 * browser-side provider that reads Host data.
 *
 * A provider's `list` runs in the browser, where there is no repository to read,
 * so this half asks the Host through the `atlas/gitChanges` endpoint. That is
 * the intended shape for any provider whose data is not already in the page: the
 * wire call belongs to the provider, not to the menu.
 *
 * Nothing here is cached: the menu may re-ask on every keystroke, and a provider
 * that wants a cache owns it.
 */
import type { AtlasCallContext, AtlasItem, AtlasOpenOutcome, AtlasProvider } from '../atlas.ts';
import { type GitChange } from '../contract.ts';
/** Beyond this the change list stops being a menu and starts being a file dump. */
export declare const GIT_ITEM_LIMIT = 50;
/**
 * One changed path as a menu row.
 * @param change - the change from the Host.
 * @returns the item the seam will hand back to `resolve` verbatim.
 */
export declare function gitChangeItem(change: GitChange): AtlasItem;
/** How this half reaches the Host's repository state and the user's viewer. */
export interface GitMenuDeps {
    /**
     * Ask the Host for the workspace's changed paths.
     * @param sessionId - the answered session (the Host resolves its workspace).
     * @param signal - caller lifetime; superseded per keystroke.
     */
    changes(sessionId: AtlasCallContext['sessionId'], signal: AbortSignal): Promise<readonly GitChange[]>;
    /**
     * Open one changed path for the user — the click action of a committed
     * `@atlas:git/<path>` mention in an already sent message.
     * @param sessionId - the session the mention was clicked in.
     * @param path - the workspace-relative path, as git reported it.
     * @returns `'gone'` when the path is no longer there, so the chip reads stale.
     */
    open(sessionId: AtlasCallContext['sessionId'], path: string): AtlasOpenOutcome | void | Promise<AtlasOpenOutcome | void>;
}
/**
 * Build the built-in `@git` menu provider.
 * @param deps - the Host bridge for the candidate list and the viewer bridge.
 * @returns the declaration the browser half registers.
 */
export declare function createGitMenuProvider(deps: GitMenuDeps): AtlasProvider;
