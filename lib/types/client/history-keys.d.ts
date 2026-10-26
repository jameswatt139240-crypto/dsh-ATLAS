/**
 * The session's Chat selector hook, structurally typed.
 *
 * `@deepseek-ai/dsh-client-ui-chat` is NOT one of this plugin's dependencies:
 * the hook is a standard prop the renderer injects into every session-scoped
 * slot, and adding a package dependency just to name its type would be
 * backwards. Only the two selections the history feature performs are declared —
 * which is also the honest contract, since everything else in the snapshot
 * belongs to the ui-chat package.
 */
export interface HistoryChatSelection {
    /** The conversation's node keys, in render order. */
    readonly order: readonly string[];
    /** Node lookup; the shape read from each node is `history-frames.ts`'s concern. */
    readonly nodes: {
        get(key: string): unknown;
    };
    /**
     * The streaming assistant step, or null when no step is currently streaming.
     *
     * NOT the "is a turn running" signal. A step that was aborted mid-flight keeps
     * `status: 'running'` in this projection, so `partial` stays non-null on a
     * settled session and the composer shows no Stop — measured on a fixture whose
     * turn ends with `turn/end`, reason `aborted`. The shell's own answer is
     * `useSession(s => s.running)`, which is what the gate below reads.
     */
    readonly partial: unknown | null;
}
/** The session's standard Chat selector hook. */
export interface HistoryChatHook {
    <Selection>(selector: (snapshot: HistoryChatSelection) => Selection): Selection;
}
/** The subset of the session snapshot this feature reads. */
export interface HistorySessionSelection {
    /** Whether a turn is currently in flight. */
    readonly running?: boolean;
}
/** The session's standard selector hook. */
export interface HistorySessionHook {
    <Selection>(selector: (snapshot: HistorySessionSelection) => Selection): Selection;
}
/**
 * The standard props the history feature consumes beyond the input face.
 *
 * Declared as an interface rather than inline so the overlay props can intersect
 * it, and so the inability to name the ui-chat package stays visible in one
 * place instead of leaking into every signature.
 */
export interface HistoryStandardProps {
    /** The session's Chat snapshot hook, injected by the shell. */
    readonly useChat: HistoryChatHook;
    /**
     * The session snapshot hook, whose `running` flag is the shell's own
     * "a turn is in flight" answer (the same one that decides whether the
     * composer offers Stop).
     */
    readonly useSession: HistorySessionHook;
}
/**
 * Declare `useChat` on the session standard kit.
 *
 * `SessionStandardProps` is declared EMPTY on purpose — its own doc says each
 * owning UI adapter merges the hooks it contributes — so ui-chat's chat hook is
 * already merged into the props at runtime, while this program cannot see it
 * without depending on that package. Augmenting the interface here is that
 * documented mechanism used from the consumer side, and it is what makes the
 * overlay's real props type-check instead of needing a cast.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SessionStandardProps {
        /** The session's Chat snapshot selector hook (contributed by ui-chat). */
        readonly useChat: HistoryChatHook;
        /**
         * The session snapshot selector hook, whose `running` flag is the shell's
         * own "a turn is in flight" answer (contributed by ui-session).
         *
         * Declared here for the same reason as `useChat`: the overlay's declared
         * standard kit carries the hook at runtime, while this program cannot see
         * the package that merges it, and the history walk needs the flag to tell
         * a settled frame from one whose turn is still streaming.
         */
        readonly useSession: HistorySessionHook;
    }
}
/** The cursor's phase: the composer at rest, roaming, or the palette open. */
export type HistoryPhase = 'idle' | 'roaming' | 'palette';
/** One resolved intent for a key event. */
export type HistoryIntent = 
/** Enter the roaming selection state. */
{
    readonly kind: 'enter';
}
/**
 * Step the cursor one frame earlier/later.
 *
 * `quick` is the difference between the two features the user keeps separate:
 * a bare arrow (`quick: false`) MOVES the roaming cursor so the user can look
 * at a message, while the Ctrl/Cmd chord (`quick: true`) also carries the
 * frame's text back into the composer so the user can reuse it. Both work in
 * both phases, and this flag — not the phase — is what decides which of the
 * two frame sets the step runs over (see A-19).
 */
 | {
    readonly kind: 'step';
    readonly direction: -1 | 1;
    readonly page: boolean;
    readonly quick: boolean;
}
/** Jump to the oldest frame or back to the draft. */
 | {
    readonly kind: 'edge';
    readonly to: 'oldest' | 'draft';
}
/** Reuse the highlighted frame (or, on the draft slot, do nothing). */
 | {
    readonly kind: 'reuse';
}
/** Leave the roaming state, returning focus to the composer. */
 | {
    readonly kind: 'leave';
    readonly consume: boolean;
}
/** Toggle the palette. */
 | {
    readonly kind: 'palette';
};
/** The facts about one key event this module needs. */
export interface KeyFacts {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    /** Whether the event is currently composing (IME). */
    readonly isComposing: boolean;
}
/** The environment facts that decide whether a gesture may run at all. */
export interface HistoryEnvironment {
    /** The feature's enable switch. */
    readonly enabled: boolean;
    /** Whether the `@` menu is open (it owns the arrow keys then). */
    readonly menuOpen: boolean;
    /** Whether a modal dialog is open (it owns Escape then). */
    readonly modalOpen: boolean;
    /** Whether the current turn is still generating. */
    readonly generating?: boolean;
    /** Whether the event target is inside a text field this plugin does not own. */
    readonly foreignEditor: boolean;
}
/**
 * Whether a modifier state carries the palette chord: the command key, with or
 * without Shift.
 *
 * Two documents in this repo disagree about the spelling — `docs/history-jump.md`
 * §2 picks `Ctrl/Cmd+Shift+H` for being free of the browser and platform
 * collisions that bare `Ctrl+H` (Chrome/Edge History) and `Cmd+H` (macOS "hide
 * app") have, while the code shipped answering only the unshifted form. Both
 * spellings now open the same panel, so neither document lies and the safer
 * chord the design argued for actually works. `Alt` stays excluded: on Windows
 * `AltGr` *is* `Ctrl+Alt`, so accepting it would fire while a user types a
 * character.
 * @param facts - the key event facts.
 * @returns whether this event is the palette chord's modifier state.
 */
export declare function isPaletteChord(facts: KeyFacts): boolean;
/**
 * The platform command key label, for copy.
 * @param platform - `navigator.platform`-ish string.
 * @returns the label a user reads.
 */
export declare function commandLabel(platform: string): string;
/**
 * Resolve one key event into a history intent, or `undefined` to let it pass.
 *
 * The environment gates run FIRST and they gate everything: while the `@` menu
 * or a modal owns the keyboard, this plugin does not merely decline the arrow
 * keys — it declines `Escape` too, because a modal's own Escape handling is a
 * bubbling listener that does not preventDefault, so a capture listener that
 * acted first would close both.
 * @param facts - the key event facts.
 * @param phase - the current phase.
 * @param env - the environment facts.
 * @returns the intent, or undefined to let the event through untouched.
 */
export declare function resolveIntent(facts: KeyFacts, phase: HistoryPhase, env: HistoryEnvironment): HistoryIntent | undefined;
/**
 * Whether an intent must preventDefault.
 *
 * Leaving on an ordinary keystroke must not consume it: the user is typing, and
 * the character has to reach the composer. Every other gesture is ours.
 * @param intent - the resolved intent.
 * @returns whether to consume the event.
 */
export declare function consumes(intent: HistoryIntent): boolean;
/**
 * Whether an intent leaves the roaming state on an ordinary keystroke.
 *
 * Such a keystroke must reach the composer with its normal meaning, so it is not
 * consumed; Escape (also a `leave`) is ours and is consumed.
 * @param intent - the resolved intent.
 * @returns whether the event must be consumed.
 */
export declare function isLeave(intent: HistoryIntent): intent is {
    readonly kind: 'leave';
    readonly consume: boolean;
};
/**
 * Step a cursor move, WRAPPING at both ends of the walk.
 *
 * The slot space is `[draft, ...frames in reverse chronological order]`: index 0
 * is the composer's own draft slot and index N is the OLDEST frame, so asking for
 * something OLDER (`direction: -1`) moves to a HIGHER slot index. That ordering is
 * what makes "keep pressing Ctrl+Up" walk backwards through history and "then
 * press Ctrl+Down" walk forwards, ending on the draft the user started from.
 *
 * Wrapping used to be unconditional (A-17), and it still is for ESC roaming. A-21
 * split the two features on this point: the user asked for Ctrl+↑/↓ to "去掉首尾
 * 循环", because a chord that silently jumped from the oldest message back to the
 * draft made the position hard to reason about — and since A-21 also resets the
 * chord's position whenever the walk's starting point changes, a wrap would be the
 * only way to reach a position the user did not travel to. So wrapping is now
 * opt-in through `allowWrap`: roaming passes `true`, the chord `false`.
 *
 * The slot space still has `frameCount + 1` positions — the draft is a real
 * position, not a boundary — and when wrapping is allowed stepping past either end
 * lands on the other, so `stepSlot(0, -1, n, true)` is the newest frame and
 * `stepSlot(n + 1, 1, n, true)` is `0` again.
 *
 * Callers must NOT treat "the wrapped result" as "the edge was reached": the
 * walk's own paging contract (§5.4 / A-12) still owns the older edge, and only
 * once paging can bring nothing more may a press wrap. `FrameCursor` enforces
 * that ordering by attempting the page first and wrapping on the following press.
 * @param current - the current slot index.
 * @param direction - -1 for older, 1 for newer.
 * @param frameCount - how many frames exist.
 * @param allowWrap - true to wrap past either end (ESC roaming), false to stop at
 * it (the Ctrl+↑/↓ chord, A-21).
 * @returns the next slot index, inside `[0, frameCount]`.
 */
export declare function stepSlot(current: number, direction: -1 | 1, frameCount: number, allowWrap: boolean): number;
/**
 * Clamp a slot index into the walk, without wrapping.
 *
 * The companion to `stepSlot`, and the reason A-17 does not break A-12: a PAGED
 * move must stop at the end of the walk (so "did the cursor move?" still answers
 * the paging question), while a single step wraps. Also used to translate a
 * would-be wrap into the edge it crossed.
 * @param slot - the slot index to clamp.
 * @param frameCount - how many frames exist.
 * @returns the slot index inside `[0, frameCount]`.
 */
export declare function clampSlot(slot: number, frameCount: number): number;
/**
 * Convert a slot index into a frame index, or undefined for the draft slot.
 * @param slot - the slot index.
 * @param frameCount - how many frames exist.
 * @returns the frame's index in the oldest-first frame array, or undefined.
 */
export declare function frameAtSlot(slot: number, frameCount: number): number | undefined;
/**
 * Convert a frame index into its slot index.
 * @param frameIndex - index in the oldest-first frame array.
 * @param frameCount - how many frames exist.
 * @returns the slot index.
 */
export declare function slotOfFrame(frameIndex: number, frameCount: number): number;
