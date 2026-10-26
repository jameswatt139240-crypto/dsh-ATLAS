/**
 * The `@` token grammar shared by the Host reference marker and the browser
 * dock. A token is `@` followed by a run of non-whitespace, non-`@` characters;
 * a file reference may carry a `:start[-end]` line range. The Host bundle and
 * the client bundle are built separately, so this module is the single
 * implementation of the recognition rule they must agree on.
 *
 * ONE form breaks that run. A plugin is named by its npm MODULE name, and a
 * scoped module name carries an `@` of its own: `@plugin:@sidequest-007/dsh-atlas`.
 * That inner `@` belongs to the name, not to a second mention. Reading it as a
 * token start splits the mention in two — the plugin is then never recognized,
 * and the scope (`sidequest-007/dsh-atlas`) is scanned as a workspace PATH that
 * does not exist (m05904). So the plugin form is tried FIRST everywhere a token
 * is scanned, and it swallows the scope whole.
 */

/** One npm module name: an optional `@scope/`, then the name itself. */
const MODULE_NAME_TOKEN = String.raw`(?:@[^\s@/]+\/)?[^\s@]+`

/** The `@plugin:<module name>` body, scope included. */
const PLUGIN_TOKEN = String.raw`plugin:${MODULE_NAME_TOKEN}`

/**
 * The body of any `@` mention token. The plugin form comes first, so a scoped
 * module name matches as ONE token; every other form is the bare run — which is
 * also what a lone category prefix (`@plugin:`, `@skill:`) still matches.
 * Every fragment here is `String.raw`: a plain template would turn `\s` into `s`
 * and quietly scan the wrong token.
 */
const MENTION_TOKEN = String.raw`(?:${PLUGIN_TOKEN}|[^\s@]+)`

/** Every `@` mention token in a text, captured without the `@`. */
export const MENTION_PATTERN = new RegExp(`@(${MENTION_TOKEN})`, 'gu')

/** The `@plugin:<module>` tokens in a text, captured without the `@plugin:` prefix. */
export const PLUGIN_MENTION_PATTERN = new RegExp(`@plugin:(${MODULE_NAME_TOKEN})`, 'gu')

/** One inclusive 1-based line range on a referenced file. */
export interface LineRange {
  readonly start: number
  readonly end: number
}

/** One token split into its path portion and an optional line range. */
export interface TokenTarget {
  readonly path: string
  readonly lines?: LineRange
}

/**
 * Split one token into its path and an optional `:start[-end]` line range.
 *
 * A colon introduces a range only when digits (optionally `-digits`) follow it,
 * so Windows drive letters (`C:\src\a.ts`), `file:`-style category prefixes, and
 * any other colon-bearing path keep working as plain paths. A reversed range
 * (`40-12`) is normalized to `12-40`; line numbers start at 1, and a `0` keeps
 * the whole token as a path.
 * @param token - one scanned token without its leading `@`.
 * @returns the path portion plus the parsed range when one was recognized.
 */
export function splitLineRange(token: string): TokenTarget {
  const match = /^(.*):(\d+)(?:-(\d+))?$/u.exec(token)
  if (match === null) return { path: token }
  const path = match[1] as string
  const start = Number(match[2])
  const end = match[3] === undefined ? start : Number(match[3])
  if (path === '' || start < 1 || end < 1) return { path: token }
  return { path, lines: { start: Math.min(start, end), end: Math.max(start, end) } }
}

/**
 * Render one line range as the `start-end` wire label.
 * @param lines - the parsed inclusive range.
 * @returns the `start-end` text used in the draft token and the injected attribute.
 */
export function lineRangeLabel(lines: LineRange): string {
  return `${lines.start}-${lines.end}`
}
