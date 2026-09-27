/**
 * Session-reference CLICK-THROUGH: decode the two shapes a session mention
 * leaves behind, and decide the one session (if any) each names.
 *
 * Why this module exists at all: a session mention is folded to a bare label
 * before the message is durable (`parseSessionReferenceText` replaces
 * `@[label](dsh-session:…)` with `@label`), and the editor keeps the wire form
 * as plain TEXT rather than an atomic chip — measured live, so neither the
 * bubble's chip `title` nor the composer's DOM carries a session id. Two shapes
 * therefore survive, and each needs its own rule:
 *
 * - the WIRE form `@[label](dsh-session:<base64url(JSON string)>)`, which names
 *   its session exactly, and
 * - a bare `@label`, which names nothing by itself and is opened ONLY when the
 *   session list contains exactly ONE matching session (id or title). A guess
 *   would hijack a real file: `@AGENTS.md` is a file long before it is a
 *   session, and the plugin must never turn a workspace path into a jump.
 *
 * Pure string + list work, so the browser bridge stays a thin event adapter and
 * the rules are pinned by their own spec.
 */
/** One session reference a click can act on. */
export interface SessionLink {
    readonly sessionId: string;
    /** The session a bare label resolves to, for the "no id in the label" shape. */
    readonly resolvedFrom?: string;
}
/** The wire mention, captured as label + payload. Matches the framework's own grammar. */
export declare const WIRE_MENTION_RE: RegExp;
/**
 * The wire mention that STARTS at one character offset of a line, if any.
 *
 * The composer's token reader is whitespace-bounded, which is exactly why this
 * exists: a session label routinely contains spaces (`@[继续 LoongCrush 项目的任务](…)`)
 * and the whitespace rule would cut the mention at its first space, leaving a
 * fragment that decodes as a FILE path. `$` is replaced by a lookahead so the
 * regex can be anchored at a position inside a longer line.
 * @param text - one line's text.
 * @param offset - the offset the mention would start at (the `@`).
 * @returns the mention and its end offset, or undefined when none starts there.
 */
export declare function wireMentionAt(text: string, offset: number): {
    readonly end: number;
} | undefined;
/**
 * The `dsh-session:` URI inside one wire mention, or undefined for any other
 * spelling. Shared so the sent-message decoder and the draft activation can ask
 * the same question instead of each keeping its own copy of the grammar.
 * @param text - a chip `title` or a draft token.
 * @returns the URI, ready for {@link decodeSessionUri}.
 */
export declare function wireSessionUri(text: string): string;
/**
 * Decode one `dsh-session:` URI into the session id it names.
 *
 * The payload is base64url of `JSON.stringify(id)` (the host's canonical
 * encoding), so a payload that decodes to anything but one JSON string is not a
 * session address — and the round trip is verified, exactly as the host's own
 * decoder does, so a non-canonical spelling can never name a different session.
 * @param uri - a complete `dsh-session:` URI.
 * @returns the session id, or undefined when the URI is malformed.
 */
export declare function decodeSessionUri(uri: string): string | undefined;
/** Look one label up against the live session list. */
export interface SessionLinkDeps {
    /**
     * The session one mention label names, or undefined when it names none or
     * more than one. Implemented over `ctx.sessions.list`, so the plugin never
     * guesses: ambiguity answers undefined and the reference stays inert.
     */
    matchLabel(label: string): string | undefined;
}
/**
 * The lookup a DRAFT asks before it may promote a bare `@label` into a session
 * link, or undefined for a bridge that may not promote one at all. Injection
 * passes the plugin's `ctx.sessions.list` reader; everything else (a test, the
 * sent-message bridge) leaves it out and bare labels stay dead letters.
 */
export type SessionLabelResolver = (label: string) => string | undefined;
/**
 * Resolve one reference label (a chip `title`, or a draft token without its
 * `@`… see the callers) into a session to open.
 *
 * The wire form is exact and needs no list. A bare label is accepted ONLY in
 * the draft, where the user's own typing is the intent: in a SENT bubble the
 * same bare label also decorates plain prose (`@AGENTS.md` is routinely a
 * file), so promoting it there would overrule a file reference the user made.
 * @param text - the label with its leading `@`, or the full wire mention.
 * @param deps - the live session lookup.
 * @param allowBareLabel - whether a bare `@label` may be promoted (draft only).
 * @returns the session to open, or undefined when nothing may be opened.
 */
export declare function resolveSessionLink(text: string, deps: SessionLinkDeps, allowBareLabel: boolean): SessionLink | undefined;
