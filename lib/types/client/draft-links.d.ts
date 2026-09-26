import { type ReferenceLink } from './reference-links.ts';
import type { ReferenceOutcome } from './ReferenceLinks.tsx';
/** The attribute Lexical puts on the composer's contenteditable root. */
export declare const EDITOR_SELECTOR = "[data-lexical-editor=\"true\"]";
/** The attribute the framework puts on a text node it decorated as a reference. */
export declare const TEXT_REF_SELECTOR = "[data-composer-text-ref]";
/** The highlight name every draft link is painted under. */
export declare const DRAFT_HIGHLIGHT = "dsh-atlas-draft-ref";
/** The highlight name a reference whose target is gone is painted under. */
export declare const MISSING_HIGHLIGHT = "dsh-atlas-draft-missing";
/** The action one click on a draft reference performs. */
export type DraftAction = () => ReferenceOutcome | Promise<ReferenceOutcome>;
/** One token the plugin can act on, decoded. */
export interface DraftActivation {
    readonly link: ReferenceLink;
    readonly run: DraftAction;
}
/**
 * The block child of the editor root that holds `node`.
 *
 * Lexical draws one block element per line, so this is the line a caret belongs
 * to; offsets are then counted inside that one line, never across the whole
 * draft (which is what keeps the mapping exact without knowing how the editor
 * spells its line breaks).
 * @param root - one editor root.
 * @param node - a node inside it.
 * @returns the block, or undefined when the node is not inside this root.
 */
export declare function blockOf(root: Element, node: Node): Element | undefined;
/** One line's text plus the offset each of its text nodes starts at. */
export interface LineIndex {
    readonly text: string;
    readonly nodes: readonly {
        readonly node: Text;
        readonly start: number;
    }[];
}
/** Index one line so a character offset and a text node convert into each other. */
export declare function indexLine(block: Element): LineIndex;
/**
 * The DOM point of one character offset inside an indexed line.
 * @param index - the indexed line.
 * @param offset - a character offset in its text.
 * @returns the text node and offset to build a Range from, or undefined past the end.
 */
export declare function pointAt(index: LineIndex, offset: number): {
    readonly node: Text;
    readonly offset: number;
} | undefined;
/** One `@` token's span inside a line's text. */
export interface TokenRun {
    readonly token: string;
    readonly start: number;
    readonly end: number;
}
/**
 * The `@` token run that covers one character offset of a line.
 *
 * The run is bounded by whitespace and by a second `@` (the grammar is `@` plus
 * a run of non-whitespace, non-`@` characters), so a click anywhere inside a
 * token — including its undecorated tail — resolves to the same whole token.
 * @param text - one line's text.
 * @param offset - the character offset the caret sits at.
 * @returns the token and its span, or undefined when no `@` governs that offset.
 */
export declare function tokenRunAt(text: string, offset: number): TokenRun | undefined;
/** One reference token under a caret position. */
export interface InlineToken extends TokenRun {
    readonly line: Element;
    readonly index: LineIndex;
    /** Where the caret sits inside the line's text. */
    readonly local: number;
    /** Whether the user has finished typing the token (see {@link DraftToken}). */
    readonly settled: boolean;
    /**
     * The offset at which the framework's own colouring stops, when it drew the
     * token's head at all. Only used by a browser that cannot paint a range: there
     * the framework's colour is the only "this is a link" the user can see.
     */
    readonly decoratedEnd?: number;
}
/**
 * The reference token a caret position in the composer resolves to.
 *
 * The token is read from the line's text, not from the framework's decoration:
 * a hand-typed token the editor never recognised is the same reference as one it
 * did, and the caller decides what may be offered (see {@link draftActivation}).
 * @param root - one editor root.
 * @param node - the caret's container node.
 * @param offset - the caret's offset inside that node.
 * @returns the token, or undefined when no `@` token covers the point.
 */
export declare function tokenAtPoint(root: Element, node: Node, offset: number): InlineToken | undefined;
/** One `@` token of the composer, with the line it lives in. */
export interface DraftToken extends TokenRun {
    readonly line: Element;
    readonly index: LineIndex;
    /**
     * Whether the user has finished typing this token: a whitespace character
     * follows it, or its line is followed by another line (Enter). A token that
     * ends the draft is still being written, and every prefix of a real path is a
     * path the Host has never heard of — judging one would strike it through
     * halfway through typing it.
     */
    readonly settled: boolean;
}
/**
 * Every `@` token the composer currently shows, in document order.
 *
 * The tokens are read per line, so the mapping from a token to a DOM range needs
 * no knowledge of how the editor spells its line breaks.
 * @returns the tokens, with the offsets they occupy in their line.
 */
export declare function draftTokens(): readonly DraftToken[];
/**
 * The action one draft token offers, or undefined when it offers none.
 *
 * This is the plugin's own definition of a draft link, and it deliberately does
 * NOT consult the framework's decoration: a hand-typed `@AGENTS.md` names the
 * same reference whether or not the editor happened to recognise the name.
 *
 * A file or folder token is offered only while the Host CONFIRMS its target: the
 * dock above the composer already inspects exactly those tokens and marks a
 * vanished one `已失效`, so an unknown verdict means "not yet" rather than "yes" —
 * a link drawn before the answer arrives would have to be taken back a moment
 * later, and a link that opens nothing must never be handed to the pointer. A
 * provider or skill token has no such verdict: whether it is openable is its
 * owner's answer, asked through `actionFor`.
 * @param token - one draft token, `@` included.
 * @param actionFor - the session's action lookup.
 * @param verdict - the dock's last inspection verdict for one referenced path.
 * @returns the action, or undefined when there is nothing to open.
 */
export declare function draftActivation(token: string, actionFor: (link: ReferenceLink) => DraftAction | undefined, verdict: DraftVerdictLookup): DraftActivation | undefined;
/** The Host's inspection verdict for one referenced path. */
export interface DraftVerdict {
    /** Whether the target exists right now. */
    readonly exists: boolean;
    /** The target's kind, when the Host reported one. */
    readonly kind?: 'file' | 'dir';
}
/** Look one referenced path up among the dock's verdicts. */
export type DraftVerdictLookup = (path: string) => DraftVerdict | undefined;
/**
 * Whether one draft token is a reference whose target the Host reports as gone.
 *
 * This is the dock's own `已失效` state, said in the composer: the token names a
 * file or a folder, the inspection answered, and the answer was no. It is NOT
 * the same as an unanswered inspection (nothing is claimed then) and not the
 * same as a token that decodes into no reference at all (`@plugin:x` is a label,
 * not a path) — neither of those is a claim the plugin can make about a file.
 * @param token - one draft token, `@` included.
 * @param verdict - the dock's last inspection verdict for one referenced path.
 * @returns true when the token names a target that is gone.
 */
export declare function draftMissing(token: string, verdict: DraftVerdictLookup): boolean;
/**
 * Decode one draft token into the reference it names.
 *
 * {@link decodeDraftReference} owns the vocabulary. A file token may still carry
 * the line-range spelling (`@src/view.ts:12-40`), which that decoder accepts as
 * a path because its colon is not in the first segment; the range is a reading
 * instruction rather than part of the path, so it is dropped here exactly as the
 * dock's rows drop it. A handle spelling (`@file:12-40`) is refused by the
 * decoder itself, and stays refused.
 * @param token - one draft token, `@` included.
 * @returns the reference, or undefined when the token names nothing openable.
 */
export declare function draftLink(token: string): ReferenceLink | undefined;
/** Whether this browser can colour text ranges without touching the editor's DOM. */
export declare function canPaintTails(): boolean;
/** How one draft token should be drawn: an openable link, or a stale reference. */
export type DraftPaint = 'link' | 'missing';
/** How many tokens of each kind the last {@link paintDraftLinks} pass drew. */
export interface DraftPaintCount {
    readonly link: number;
    readonly missing: number;
}
/**
 * Paint every draft token `decide` classifies.
 *
 * The whole token is painted, not just the part the framework happened to
 * colour: a link that opens on a click must look like a link along its entire
 * length, and the framework's own colour (when it drew one) is the same design
 * token, so nothing shifts for a token it did recognise. A token whose target is
 * gone is painted the other way — stale, the dock's own language — so a
 * reference that cannot open is visibly a reference rather than ordinary prose.
 * The API paints ranges over the existing text, so the editor's node structure
 * is untouched.
 * @param decide - classifies one token; it receives the token with its line and
 *   its `settled` flag, because a token still being typed must not be judged.
 * @returns how many tokens of each kind were painted.
 */
export declare function paintDraftLinks(decide: (token: DraftToken) => DraftPaint | undefined): DraftPaintCount;
/**
 * Show or clear the link pointer on one composer.
 *
 * The cursor cannot be part of a highlight — it is a property of the element
 * under the pointer, and the undecorated tail shares its element with whatever
 * prose follows — so the bridge hit-tests the pointer and publishes the answer
 * on the editor root.
 * @param root - one editor root.
 * @param hot - whether the pointer is over an openable reference token.
 */
export declare function setEditorCursor(root: Element, hot: boolean): void;
