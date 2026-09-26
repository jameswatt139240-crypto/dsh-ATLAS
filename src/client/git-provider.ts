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
import type { AtlasCallContext, AtlasItem, AtlasOpenOutcome, AtlasProvider } from '../atlas.ts'
import { isCancellation } from '../abort.ts'
import {
  BUILTIN_TESTED_ON,
  GIT_PROVIDER_ID,
  GIT_SCOPES,
  type GitChange,
} from '../contract.ts'

/** Beyond this the change list stops being a menu and starts being a file dump. */
export const GIT_ITEM_LIMIT = 50

/**
 * An item id travels inside `@atlas:git/<id>`, and the token grammar has no
 * whitespace, so a path that contains any is not addressable this way.
 */
const TOKEN_SAFE = /^[^\s@]+$/u

/**
 * One changed path as a menu row.
 * @param change - the change from the Host.
 * @returns the item the seam will hand back to `resolve` verbatim.
 */
export function gitChangeItem(change: GitChange): AtlasItem {
  const counts = change.added === undefined
    ? undefined
    : `+${change.added} \u2212${change.removed ?? 0}`
  return {
    id: change.path,
    title: change.path,
    preview: counts,
    badge: change.status === '??' ? '\u2022' : change.status,
  }
}

/** How this half reaches the Host's repository state and the user's viewer. */
export interface GitMenuDeps {
  /**
   * Ask the Host for the workspace's changed paths.
   * @param sessionId - the answered session (the Host resolves its workspace).
   * @param signal - caller lifetime; superseded per keystroke.
   */
  changes(sessionId: AtlasCallContext['sessionId'], signal: AbortSignal): Promise<readonly GitChange[]>
  /**
   * Open one changed path for the user — the click action of a committed
   * `@atlas:git/<path>` mention in an already sent message.
   * @param sessionId - the session the mention was clicked in.
   * @param path - the workspace-relative path, as git reported it.
   * @returns `'gone'` when the path is no longer there, so the chip reads stale.
   */
  open(
    sessionId: AtlasCallContext['sessionId'],
    path: string,
  ): AtlasOpenOutcome | void | Promise<AtlasOpenOutcome | void>
}

/**
 * Build the built-in `@git` menu provider.
 * @param deps - the Host bridge for the candidate list and the viewer bridge.
 * @returns the declaration the browser half registers.
 */
export function createGitMenuProvider(deps: GitMenuDeps): AtlasProvider {
  return {
    id: GIT_PROVIDER_ID,
    display: 'Git',
    scopes: GIT_SCOPES,
    testedOn: BUILTIN_TESTED_ON,
    // A git item IS a workspace path, and only this provider is entitled to say
    // so: the menu never interprets a provider item on its own. Its outcome is
    // passed through, so a path that vanished marks its mention stale.
    open(item, context) {
      return deps.open(context.sessionId, item)
    },
    async list(query, context) {
      let changes: readonly GitChange[]
      try {
        changes = await deps.changes(context.sessionId, context.signal)
      } catch (error) {
        // A superseded lookup is normal operation — the menu re-asks on every
        // keystroke and the caller aborts the previous call — so only a real
        // failure earns a line. An unavailable repository is a normal state too
        // (not every workspace is one), and the menu must still open either way.
        if (!isCancellation(error, context.signal)) {
          console.error('[dsh-atlas] git candidates unavailable:', error)
        }
        return []
      }
      const needle = query.trim().toLowerCase()
      const items: AtlasItem[] = []
      for (const change of changes) {
        if (!TOKEN_SAFE.test(change.path)) continue
        if (needle !== '' && !change.path.toLowerCase().includes(needle)) continue
        items.push(gitChangeItem(change))
        if (items.length >= GIT_ITEM_LIMIT) break
      }
      return items
    },
  }
}
