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
/** Every `@` mention token in a text, captured without the `@`. */
export declare const MENTION_PATTERN: RegExp;
/** The `@plugin:<module>` tokens in a text, captured without the `@plugin:` prefix. */
export declare const PLUGIN_MENTION_PATTERN: RegExp;
/** One inclusive 1-based line range on a referenced file. */
export interface LineRange {
    readonly start: number;
    readonly end: number;
}
/** One token split into its path portion and an optional line range. */
export interface TokenTarget {
    readonly path: string;
    readonly lines?: LineRange;
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
export declare function splitLineRange(token: string): TokenTarget;
/**
 * Render one line range as the `start-end` wire label.
 * @param lines - the parsed inclusive range.
 * @returns the `start-end` text used in the draft token and the injected attribute.
 */
export declare function lineRangeLabel(lines: LineRange): string;
