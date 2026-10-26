/**
 * The history frame index: the current session's user messages, in order, as the
 * reusable "frames" the F1 palette lists and the F2 cursor walks.
 *
 * Everything here is derived from the Host's own authoritative Chat snapshot
 * (`useChat`), which a session-scoped slot receives as a standard prop — so this
 * feature adds NO wire endpoint and never reads file content. The DOM is used
 * only to SCROLL to a frame's row, never to decide what the frames are: the row
 * attributes the scroll looks for are absent from some shipped builds, and a
 * missing attribute must degrade to "highlight without scrolling" rather than
 * to a broken feature.
 *
 * A frame is one message the user can WALK to. In the default `'message'` mode
 * that is every readable message of the session: the two kinds a user writes
 * (`user`, and `steering` for an interjection claimed mid-turn) plus the
 * assistant's own prose (`reply`). The question that produced the reply kind was
 * "why does Up/Down stop on my input but never on the answer, the answer is a
 * message too" — and it is: a reader scrolling back through a session wants to
 * land on the answer as much as on the question.
 *
 * What still never becomes a frame: tool calls, injected context, and any node
 * whose text is empty (a reply cancelled before its first token, a step that is
 * pure tool plumbing). Those have no row worth stopping on.
 *
 * `'turn'` mode keeps its original meaning — one frame per turn, its opening
 * prompt — because that is the coarse granularity a user asks for when a whole
 * exchange should be one stop.
 */
/** Which frame granularity the user chose. */
export type HistoryFrameMode = 'message' | 'turn';
/**
 * One message the walk can stop on, projected from one Chat node.
 *
 * `reply` frames are the assistant's own prose: they are walkable but not
 * reusable-by-chord, because the chord's answer to "reuse" is to put the text in
 * the composer and an answer is not something the user wrote (see
 * {@link isUserAuthored}).
 */
export interface HistoryFrame {
    /** The Chat node key; also the value of its row's `data-chat-anchor-key`. */
    readonly key: string;
    /** Durable seq, used for paging the window back to this frame. */
    readonly seq: number;
    /** The owning turn, or undefined when the node has no resolved turn. */
    readonly turn: number | undefined;
    /** Epoch ms of the source event. */
    readonly time: number;
    /** A normal user message, a mid-turn interjection, or the assistant's reply. */
    readonly kind: 'user' | 'steering' | 'reply';
    /**
     * The message's original text: every text block of `content`, joined.
     *
     * This is the durable content, NOT the rendered DOM text, which is why a
     * reused `@label` comes back as the reference token the user typed instead of
     * as decoration the composer would no longer recognise.
     */
    readonly text: string;
    /** A one-line preview for the palette row. */
    readonly preview: string;
    /** The turn's assistant answer, for the palette's second line (empty when none). */
    readonly answer: string;
    /** Whether the message carried non-text blocks (images/files) that will NOT be reused. */
    readonly hasAttachment: boolean;
    /**
     * True when this frame came from the session-wide outline rather than from a
     * loaded node, i.e. the message's row is NOT in the client window yet and
     * {@link HistoryFrame.text} holds the outline's bounded preview instead of the
     * original text.
     *
     * This exists because the readout's total must agree with the page's own turn
     * ruler (`turnOutline` folds the WHOLE log; the loaded window is paged), and a
     * walk that stopped at the window made the two disagree — the reported bug was
     * "ruler has many ticks while the readout says 0 / 0". A consumer that needs
     * the original text (a reuse) pages the window to {@link HistoryFrame.seq}
     * first and lets the loaded frame replace this placeholder.
     */
    readonly unloaded: boolean;
    /**
     * The node's own `source.kind === 'user'` verdict, when the node carries a
     * readable source. `undefined` means "no source to read", which is NOT the same
     * as "not user-authored" — a node shape without a source is left to the other
     * evidence rather than being silently excluded from the chord's frame set.
     */
    readonly authoredByUser?: boolean;
    /**
     * True when the TURN was started by the system/plugin rather than by the user,
     * i.e. the roam bar must label it (A-20).
     *
     * This is deliberately SEPARATE from {@link HistoryFrame.authoredByUser}, even
     * though the two agree on loaded frames. `authoredByUser` is a per-NODE verdict
     * and can be `undefined` ("no source to read"); this flag is a per-TURN verdict
     * that is always decided, because the roam bar has to say something either way.
     * The evidence differs by where the frame came from:
     *   * a LOADED frame reads its node's `source.kind`;
     *   * an UNLOADED frame has no node, so its evidence is the outline itself: the
     *     projection records a turn's prompt ONLY for a human `user/message`
     *     (`session-turn-outline/projection.ts:110` returns early otherwise), so an
     *     empty prompt on an unloaded turn means the system started it. That is also
     *     why such a frame's text is empty and the bar used to render blank.
     */
    readonly systemInitiated: boolean;
}
/** The node shape read off the Chat snapshot; every field is optional because
 * the snapshot is a cross-package value whose discriminant this plugin narrows
 * itself rather than trusting. */
interface ChatNodeLike {
    readonly kind?: unknown;
    readonly data?: unknown;
    readonly location?: unknown;
}
/** How many characters of a message the palette row shows. */
export declare const FRAME_PREVIEW_LENGTH = 120;
/** How many characters of an answer the palette row shows. */
export declare const FRAME_ANSWER_LENGTH = 90;
/**
 * Collapse whitespace so a multi-line message becomes one readable row.
 * @param text - the raw text.
 * @returns the collapsed text.
 */
export declare function collapse(text: string): string;
/**
 * Truncate to a display length, appending an ellipsis when cut.
 * @param text - already-collapsed text.
 * @param limit - maximum characters.
 * @returns the preview.
 */
export declare function truncate(text: string, limit: number): string;
/**
 * Read one node's text and whether it carries something a rewrite cannot restore.
 *
 * Only `text` blocks are reused. An `image` or `file` block is deliberately
 * dropped — the composer's draft is a string, so there is nowhere to put it —
 * and its presence is reported instead, so the palette can warn the user that
 * the reuse is text-only rather than silently losing an attachment.
 * @param data - the node's `data` payload.
 * @returns the joined text and the attachment flag.
 */
export declare function readContent(data: unknown): {
    text: string;
    hasAttachment: boolean;
};
/**
 * Read the turn a node belongs to, when it has a resolved one.
 *
 * A node whose location is `unresolved` (typically injected context) has no
 * turn and is not part of the conversation's own history.
 * @param location - the node's `location`.
 * @returns the turn number, or undefined.
 */
export declare function readTurn(location: unknown): number | undefined;
/**
 * One entry of the session-wide `turnOutline` projection, structurally narrowed.
 *
 * The value crosses the wire as projection data, so it is treated as untrusted:
 * `turn` and `seq` are load-bearing (a frame cannot be counted or paged without
 * them) and a damaged entry is dropped, while the previews are decorative and
 * degrade to `''`.
 */
export interface OutlineTurn {
    /** The turn number. */
    readonly turn: number;
    /** The `turn/start` seq — the load-through target that pages this turn in. */
    readonly seq: number;
    /** The turn's first human prompt, as the outline's bounded preview. */
    readonly prompt: string;
    /** The turn's final assistant response, as the outline's bounded preview. */
    readonly response: string;
}
/**
 * Structurally narrow the `turnOutline` projection value into outline turns.
 *
 * This is the SAME projection the page's turn ruler renders
 * (`ui-chat/src/client/chat/turn-rail-items.ts`), which is what makes the walk's
 * total agree with the ruler's ticks. It folds the WHOLE log, including turns
 * outside the client's paged event window — the whole reason the readout could
 * say `0 / 0` while the ruler drew many marks is that this plugin only walked
 * the loaded window.
 * @param value - the projection value, treated as wire data.
 * @returns the turns, ascending; a stable empty array when absent or malformed.
 */
export declare function readOutlineTurns(value: unknown): readonly OutlineTurn[];
/**
 * Build the reusable frames of one session, oldest first.
 *
 * `user`, `steering` and `assistant-step` nodes become frames. In `'turn'` mode
 * only the first frame of each turn survives and the turn's later interjections
 * and replies are folded away — that is the coarser granularity a user asks for
 * when one stop per exchange is what they want; in the default `'message'` mode
 * every interjection and every reply keeps its own frame, because each one is an
 * independent thing the walk should be able to land on.
 *
 * `outline` extends the list past the loaded window with a frame per turn the
 * window does not hold. Those frames are marked `unloaded` and carry the
 * outline's bounded preview as their text, because the projection deliberately
 * does not ship message bodies. Including them is what keeps the walk's total
 * equal to the page's own turn ruler: without it a session whose window holds no
 * user nodes reads `0 / 0` while the ruler shows a dozen marks, and the walk has
 * nothing to step through.
 * @param order - the Chat snapshot's render order (node keys).
 * @param getNode - reads one node by key.
 * @param mode - the configured frame granularity.
 * @param outline - the `turnOutline` projection value.
 * @returns the frames, oldest first.
 */
export declare function buildFrames(order: readonly string[], getNode: (key: string) => ChatNodeLike | undefined, mode?: HistoryFrameMode, outline?: unknown): readonly HistoryFrame[];
/**
 * Whether the log itself records that a human typed this frame's prompt.
 *
 * A-19 splits the two features by what they are FOR. The chord exists so a user
 * can reuse something they WROTE, so a turn nobody typed — one the system started
 * on its own — must not be reachable by it. Roaming exists so a user can READ
 * around a message, so it keeps every frame.
 *
 * The signal is the outer `turnOutline` projection's own rule, not a guess: that
 * unit folds a turn's prompt only when `source.kind === 'user'`
 * (`session-turn-outline/src/projection.ts`), so a system-initiated turn keeps
 * `prompt: ''`. A loaded frame is judged the same way from its node's `source`.
 * @param frame - the frame.
 * @returns whether a human wrote it.
 */
export declare function isUserAuthored(frame: HistoryFrame): boolean;
/**
 * The frames the quick chord may reuse: the user-authored ones, oldest first.
 *
 * Filtering happens BEFORE the walk wraps, so the chord's own first/last frame is
 * the first/last thing it can actually reach — a system-initiated turn in the
 * middle must not leave a position the chord can land on but not use.
 * @param frames - every frame of the session, oldest first.
 * @returns the user-authored subset, oldest first.
 */
export declare function userAuthoredFrames(frames: readonly HistoryFrame[]): readonly HistoryFrame[];
/**
 * Build a usage counter key that identifies one frame's message.
 * @param frame - the frame.
 * @returns the key.
 */
export declare function frameKeyOf(frame: HistoryFrame): string;
export {};
