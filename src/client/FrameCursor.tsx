/**
 * F2 — frame roaming. The composer's history gesture: `Escape` hands the
 * keyboard to the conversation, `↑`/`↓` walk one frame at a time from the
 * composer's draft backwards through every user message, and `Enter` puts the
 * highlighted message back into the composer.
 *
 * Two shortcuts reach the same walk and share this component's state:
 *
 * - `Escape` then `↑`/`↓` — the roaming gesture. It SHOWS what it is doing: the
 *   conversation area takes a highlight, the current frame's row takes a
 *   stronger one, and the row is scrolled into view.
 * - `Ctrl/Cmd+↑` and `Ctrl/Cmd+↓` — the quick chord, usable straight from the
 *   composer. It reuses the same cursor and the same write-back, but never paints
 *   and never claims a bare arrow key, so a user who never learns `Escape` still
 *   gets the behaviour they expect.
 *
 * The frames themselves come from the Host's Chat snapshot (see
 * `history-frames.ts`); the DOM is consulted only to scroll a frame's row into
 * view, and a build that lacks the row attribute degrades to "highlight without
 * scrolling" rather than to a dead feature.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { buildFrames, userAuthoredFrames, type HistoryFrame, type HistoryFrameMode } from './history-frames.ts'
import type { RoamStore, RoamView } from './roam-store.ts'
import {
  clampSlot,
  consumes,
  frameAtSlot,
  isLeave,
  resolveIntent,
  slotOfFrame,
  stepSlot,
  type HistoryChatHook,
  type HistoryPhase,
  type HistoryStandardProps,
} from './history-keys.ts'
import type { AtFileSettingsSource } from './FilesDock.tsx'
import { NS } from './locales.ts'

/**
 * The plugin's own structural view of one session projection face.
 *
 * Deliberately structural rather than imported from the api package: the overlay
 * only ever needs `faceOf`, and narrowing it here keeps a client build whose face
 * spells that differently degrading to the window-only walk rather than failing
 * to typecheck against a version this package does not pin.
 */
export interface ProjectionFace {
  /** @param key - projection key. @returns its live value, or undefined. */
  readonly faceOf: (key: string) => {
    readonly getSnapshot: () => unknown
    readonly subscribe: (listener: () => void) => () => void
  }
}

/** The composer card; clicking inside it means the user is back in the draft. */
const CARD_SELECTOR = '[data-composer-card]'

/** How many slots `PageUp`/`PageDown` move while roaming. */
export const ROAM_PAGE_ROWS = 5

/**
 * Row count above which the smart-follow measurement is worth one warning (A-24).
 *
 * A healthy run reads one layout per rendered row per animation frame, so this is not
 * a ceiling on that — it is the point at which the cost is large enough that a
 * regression back to per-EVENT reads would be indistinguishable from a freeze. Set
 * well above any realistic transcript's rendered row count so it stays silent.
 */
const SLOW_ROW_THRESHOLD = 500

/** Injected surface for the roaming overlay. */
export interface FrameCursorInjected {
  /** The plugin's settings snapshot. */
  readonly scope: AtFileSettingsSource
  /** The @ mention menu, whose open state suppresses the gesture. */
  readonly menu?: SnapshotStore<{ readonly open: boolean }>
  /**
   * Page the loaded window back until it covers a seq (A-05).
   *
   * Optional by design: an older client build has no such verb, and the walk
   * then simply stops at the oldest LOADED frame — which is a supported
   * degradation, not a broken feature.
   */
  readonly loadThrough?: (seq: number) => Promise<void>
  /**
   * The session-wide `turnOutline` projection, as a live observable (A-13).
   *
   * This is what makes the walk's total agree with the page's own turn ruler: the
   * projection folds the WHOLE log, while the Chat snapshot only holds the paged
   * window. Reading it through the session face rather than through a slot prop
   * is deliberate — `useProjection` is declared on `ChatViewInjected`, which the
   * `conversation.view` slot alone receives, whereas this overlay is handed the
   * session face directly.
   *
   * Optional by design: a client build without the projection keeps the
   * window-only walk instead of failing to register the gesture.
   */
  readonly projections?: ProjectionFace
  /**
   * Where the readout is published.
   *
   * The readout renders in the input dock (so it stacks with `/goal` and `/todo`)
   * while this component owns the key listener, and two slot components are two
   * React trees — hence a store rather than state. Optional so an injected
   * `FrameCursor` in a spec that only cares about keys stays valid.
   */
  readonly roam?: RoamStore
}

/**
 * The overlay props.
 *
 * `input`, `inputActions` and `useChat` are NOT declared as injections: they are
 * standard props the renderer spreads into every session-scoped slot, so listing
 * them here would be a lie the registration site then has to satisfy. Only the
 * plugin's own injections live in `FrameCursorInjected`.
 */
export type FrameCursorProps =
  & PropsRuntime<'conversation.input.overlay'>
  & InjectFace<FrameCursorInjected>
  & HistoryStandardProps
  & PropsLocale<typeof NS>

/**
 * Whether a modal dialog currently owns the keyboard.
 *
 * The harness's own Modal listens for Escape on the bubble phase and does NOT
 * preventDefault, so a capture listener that acted first would both leave the
 * modal open and start roaming behind it — the check is therefore explicit
 * rather than inferred from `defaultPrevented`.
 * @returns whether a modal is open.
 */
function modalOpen(): boolean {
  /* v8 ignore next -- the shell is server-rendered too, so this guard is load-bearing but a jsdom spec always has a document. */
  if (typeof document === 'undefined') return false
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

/**
 * Whether the event came from an editor this plugin does not own.
 *
 * A foreign `<input>`/`<textarea>` (a settings field, the folder picker's rename
 * box) owns its own arrow keys; only the composer's contenteditable participates.
 * @param target - the event target.
 * @returns whether to decline the gesture.
 */
function isForeignEditor(target: EventTarget | null): boolean {
  /* v8 ignore next -- a keydown always carries an element target in practice; the guard covers a synthetic/foreign dispatcher. */
  if (target === null || !(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Give the composer focus back, so the walk ends with a usable caret.
 *
 * This is the DOM half only, and that is enough PROVIDED it runs before the
 * draft is written: Lexical places the caret itself when `setDraft` runs against
 * an already-focused root, so this does not need to touch the selection.
 *
 * What it deliberately does NOT do is synthesise pointer events. Lexical adopts
 * a root through its own handling of TRUSTED input, so a dispatched `mousedown`/
 * `mouseup`/`click` is ignored — measured live: focus landed on the element, the
 * DOM selection sat inside it, and typing was still dropped until a real click
 * arrived. Faking the gesture would only look like a fix.
 */
function focusComposer(): void {
  /* v8 ignore next -- guard for the server-rendered shell; a jsdom spec always has a document. */
  if (typeof document === 'undefined') return
  const card = document.querySelector(CARD_SELECTOR)
  const editable = card?.querySelector<HTMLElement>('[contenteditable="true"], [contenteditable=""]')
  editable?.focus()
}

/**
 * Take the caret out of the composer without moving it anywhere else.
 *
 * The inverse of `focusComposer`, and the visible half of A-01: Escape is
 * specified as "the field loses focus and the chat area lights up", so the
 * caret must actually leave or the user sees a composer that still looks
 * focused while the arrows do something else. The plugin's listener is a
 * document-level capture handler, so the gesture itself does not depend on
 * where focus sits — this is purely what the user is shown.
 */
function blurComposer(): void {
  /* v8 ignore next -- guard for the server-rendered shell; a jsdom spec always has a document. */
  if (typeof document === 'undefined') return
  const card = document.querySelector(CARD_SELECTOR)
  const editable = card?.querySelector<HTMLElement>('[contenteditable="true"], [contenteditable=""]')
  editable?.blur()
}

/** Invisible overlay entry: the history roaming gesture. */
export function FrameCursor(props: FrameCursorProps) {
  const { scope, menu, loadThrough, projections, roam, useInput, inputActions, useChat, useSession, t } = props
  const settings = scope.getSnapshot().value
  const [phase, setPhase] = useState<HistoryPhase>('idle')
  // The cursor is a SLOT, not a frame index: slot 0 is the composer's own draft
  // and slot N is the oldest frame. That ordering is what makes "keep pressing
  // up" walk backwards and "then press down" walk back to the draft.
  const [slot, setSlot] = useState(0)
  // The QUICK CHORD's own cursor (A-19 item 2), over its own frame set.
  //
  // The two features must not share a position. A user who scrolls the page or
  // jumps with the right-hand ruler has moved their VIEW, not asked either feature
  // to move, so neither cursor follows by default; and a user who walked the
  // roaming cursor while looking around has not changed "the previous message I
  // want to reuse". Sharing one slot made both of those happen.
  const [quickSlot, setQuickSlot] = useState(0)
  // Set when the walk has been pushed against the OLDEST LOADED frame and there is
  // plausibly more history behind the window. The stop-at-edge behaviour alone is
  // silent, which reads as "this is the beginning of the session" when it may only
  // be the beginning of what the client has paged in (§5.4). The readout says so.
  const [edgeReached, setEdgeReached] = useState(false)
  // A roaming step landed on a frame whose row this build cannot scroll to (A-26).
  // Distinct from `edgeReached` on purpose: the frame is loaded and known, there is
  // just nothing to scroll. Cleared by any step that does manage to move the page.
  const [offscreen, setOffscreen] = useState(false)
  // Which cursor the readout is describing: `true` = the chord's walk, `false` = the
  // roaming walk. It is STATE rather than a derivation from `phase` because the two
  // genuinely come apart — Escape opens the roaming phase, but a following chord press
  // moves only the chord's own cursor (A-19), leaving the roaming slot where it was.
  // Reading the phase there reported the roaming slot while the composer held the
  // message the chord had just written (measured in the browser lane: the draft was
  // HISTORY-1 and the readout said "History 0 / 24 Current draft").
  const [quickIsCurrent, setQuickIsCurrent] = useState(false)

  const enabled = settings.historyJump !== false
  // A-33: `'turn'` is the contract default, so an absent value must mean turn
  // as well — the host may hand the client the stored layer (which carries no
  // key at all) instead of a schema-resolved object.
  const mode: HistoryFrameMode = settings.historyJumpFrames === 'message' ? 'message' : 'turn'
  const reuseMode = settings.historyJumpReuseMode === 'append' ? 'append' : 'replace'
  const frames = useHistoryFrames(useChat, mode, projections)
  // A-19 item 1: the chord's own frame set. Roaming keeps `frames` whole so a user
  // can read around a message the system started; the chord walks only what a
  // human wrote, because reusing a turn the user never sent is meaningless.
  const quickFrames = useMemo(() => userAuthoredFrames(frames), [frames])

  // The live draft, kept in a ref: the key listener is installed once, so it
  // must read the newest draft rather than the one captured at mount. `useInput`
  // is the session standard selector hook, not a store — it has no getSnapshot.
  const draft = useInput(state => state.draft)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // The user's own draft, saved when a reuse is about to overwrite it (see
  // `reuse`). `undefined` means "never overwritten", which is a different state
  // from "overwritten with an empty draft" and the two must not be conflated.
  const ownDraftRef = useRef<string | undefined>(undefined)
  // What the LAST write by this plugin put in the composer.
  //
  // The stash is only valid while the composer still holds a reused message: once
  // the user edits the draft themselves, THEIR text is what a later walk must give
  // back, and the stashed one is stale. Comparing the live draft against the last
  // write tells the two apart without listening for keystrokes — which matters
  // because the walk writes through the same draft channel a keystroke uses, so
  // the values are indistinguishable by origin alone. Measured live: without this,
  // a draft typed after an earlier walk was never stashed, and Ctrl+Down restored
  // the PREVIOUS spec's message instead.
  const lastWriteRef = useRef<string | undefined>(undefined)

  // The injected faces are held in refs because they are NEVER effect
  // dependencies: the shell re-injects on every render, so an effect keyed on a
  // face would tear itself down and restart on every render.
  const roamRef = useRef(roam)
  roamRef.current = roam

  // The menu's open state is read LIVE from its store inside the handler rather
  // than mirrored into state. A mirror needs one commit to catch up, which left
  // a window right after mount in which an already-open menu did not block
  // Escape (observed under jsdom). The store is held in a ref because the
  // listener is installed once and must see the current injection.
  const menuRef = useRef(menu)
  menuRef.current = menu

  // Whether a turn is in flight, read LIVE from the SESSION snapshot. Held in a
  // ref for the same reason as the menu: the listener is installed once and must
  // see the current value rather than the one captured at mount. A running turn
  // owns Escape, so this is what keeps B-03 true.
  //
  // It is deliberately NOT the Chat snapshot's `partial`. That field looked like
  // the natural signal (it is the streaming step) and was used here first, but a
  // step aborted mid-flight keeps `status: 'running'` in the Chat projection, so
  // `partial` stays non-null on a settled session — measured on a fixture whose
  // turn closes with `turn/end`/`aborted`, where the composer showed no Stop and
  // this gate still refused every keystroke, leaving the whole gesture dead.
  // `session.running` is the shell's own answer: it is the same flag that decides
  // whether the composer offers Stop.
  const sessionRunning = useSession(snapshot => snapshot.running) ?? false
  const generatingRef = useRef(sessionRunning)
  generatingRef.current = sessionRunning

  // Held in a ref for the same reason as the menu: the listener is installed once,
  // and an injected face is never an effect dependency (the shell re-injects on
  // every render, which would abort and restart the listener forever).
  const loadThroughRef = useRef(loadThrough)
  loadThroughRef.current = loadThrough

  // Also a ref, and for a sharper reason: `reuse` used to close over
  // `inputActions` directly, which put it in the key listener's dependency list.
  // The shell re-injects on every render, so a new `inputActions` identity
  // re-ran the effect and installed a SECOND capture listener — one ArrowUp then
  // scrolled twice (reproduced under jsdom: two `CSS.escape` calls per press).
  const inputActionsRef = useRef(inputActions)
  inputActionsRef.current = inputActions

  // Same reasoning as `inputActionsRef`: the deferred reuse (A-13) settles inside an
  // effect, and calling `reuse` directly there would put it in that effect's deps.
  const reuseRef = useRef<(frame: HistoryFrame) => void>(() => {})

  // Everything the document listener reads lives in refs: the listener is
  // installed once, so a captured render value would go stale between presses.
  const stateRef = useRef({ slot, quickSlot, phase, frames, quickFrames, reuseMode })
  stateRef.current = { slot, quickSlot, phase, frames, quickFrames, reuseMode }

  // Whether the OLDER edge has already had its paging attempt.
  //
  // A-17 makes the walk wrap, but A-12 must keep priority: pressing up at the
  // oldest loaded frame asks for more history BEFORE it wraps. Those are two
  // presses of the same key at the same slot, so something must remember that the
  // first one already asked. Without it the wrap could never be reached with a
  // loader present (every press would re-request the same page), and with a loader
  // absent the walk would wrap immediately and A-12's regression suite would fail —
  // which is precisely what happened when the wrap was first introduced.
  //
  // Cleared by any move away from the edge, and by a page that actually grows the
  // walk, so a second visit to the edge pages again.
  const pageTriedRef = useRef(false)

  // A page that has been REQUESTED but whose frames have not arrived yet.
  //
  // This exists because the promise resolving and React re-rendering with the
  // older window are two different events, and the promise wins: `loadThrough`
  // resolves as soon as the loader has taken the page, while the new frame list
  // only reaches this component on the next render. Reading the frame count
  // inside `.then()` therefore measured the PRE-page window every time, so
  // `grown <= before` was always true and pressing up at the loaded edge always
  // declared a false "oldest loaded history" edge — which is exactly the bug the
  // user hit: the walk refused to continue into a page that HAD arrived.
  //
  // It is a piece of STATE, not a ref, for a reason that is easy to miss: the
  // settlement below has to run even when the page reveals NOTHING, and in that
  // case `frames.length` is unchanged — so an effect keyed only on the length
  // never re-runs and the edge would never be announced. The request itself is
  // therefore the trigger, and the current length is read at settle time.
  const [pendingPage, setPendingPage] = useState<{ readonly before: number } | undefined>(undefined)

  // A roaming step that landed on a frame the window has NOT loaded yet.
  //
  // Roaming's whole job on a step is to bring the frame's row into view, and an
  // outline-only frame has no row: its key is the synthetic `turn:N`
  // (`history-frames.ts`), which no element in the transcript carries, so the
  // scroll resolved to `null` and the page simply did not move. The user read
  // that as the feature breaking on system-initiated turns specifically, because
  // those are the frames the outline rarely has loaded — a system turn's prompt
  // is empty in the projection (A-20), so it is both the frame most likely to be
  // outline-only AND the one with nothing to show while it is.
  //
  // So the step pages the turn in the same way A-13's reuse does, and the scroll
  // happens once the real row exists. Keyed by TURN rather than by node key, for
  // the reason `pendingReuse` gives: paging inserts frames, and the loaded frame
  // of that turn is keyed by its node id, never by `turn:N`.
  const [pendingScroll, setPendingScroll] = useState<number | undefined>(undefined)
  // Settle a roaming step that was waiting for its turn to be paged in.
  //
  // Mirrors the reuse settlement below, and for the same reason: the page's
  // arrival is the event being waited for, so the effect keys on the frame list
  // rather than only on the request. The ending is honest either way — the turn's
  // loaded frame scrolls into view, or the page did not bring it and the readout
  // says so instead of the gesture dying quietly.
  useEffect(() => {
    if (pendingScroll === undefined) return
    const loaded = frames.find(frame => frame.turn === pendingScroll && !frame.unloaded)
    if (loaded === undefined) {
      // Vanished outright (a compaction, a session switch): the request is moot.
      // Otherwise keep waiting for the next page.
      if (!frames.some(frame => frame.turn === pendingScroll)) setPendingScroll(undefined)
      return
    }
    setPendingScroll(undefined)
    // The page was requested precisely because this frame had no row, so now that
    // the loaded frame has arrived the row IS expected: failing to find it is the
    // reportable case, not the benign one (A-26). If the page brought nothing,
    // `setPendingScroll(undefined)` in the catch above says so instead.
    setOffscreen(!scrollFrameIntoView(loaded.key))
  }, [frames, pendingScroll])

  // A-13: an Enter pressed on a frame the window has not loaded yet. Such a frame
  // carries the outline's bounded preview, so the reuse has to WAIT for the page
  // that brings the real message in. Keyed by the frame's TURN (`tree`, not the node
  // key) because paging inserts frames — every index below the cursor shifts, and an
  // outline frame's key is synthetic (`turn:2`) while the loaded frame of the same
  // turn is keyed by its node id, so the two spellings never match.
  //
  // `commit` records WHICH gesture armed the wait, because the two end differently:
  // Enter is a commitment — the reused text is what the user is now working on, so the
  // stashed draft is dropped and the walk closes, exactly as `case 'reuse'` does on its
  // loaded arm — while the chord never leaves the composer and must keep both the stash
  // and the walk it is in the middle of. The settlement below applied Enter's ending to
  // a chord press until this flag existed: on that same 40-turn session the readout and
  // the roamed row vanished at the 25th press, and the user's own draft stopped being
  // restorable, because `ownDraftRef` had been cleared for a walk that was still going.
  const [pendingReuse, setPendingReuse] = useState<{ readonly turn: number; readonly commit: boolean } | undefined>(undefined)

  // A shrunken history (a new session, a compaction) must not leave the cursor
  // past the end; clamp it rather than letting it point at a slot that cannot exist.
  //
  // The same effect settles a PAGE that was requested at the loaded edge, because
  // this is the first moment the grown list is observable — which is precisely what
  // the `.then()` that used to live in the key handler could not see. A page that
  // revealed nothing is a genuine edge and says so; a page that prepended frames
  // moves the cursor onto the frame it revealed, i.e. the walk continues.
  useEffect(() => {
    if (pendingPage === undefined) {
      /* v8 ignore next -- the `current > frames.length` arm only fires on the render immediately after a shrink, and React discards that passive update before a spec can observe the stale slot; the end state is asserted instead. */
      setSlot(current => (current > frames.length ? frames.length : current))
      return
    }
    // Settle the page on the render that follows the request. The frames may or may
    // not have grown in between: a loader that prepends older frames has already
    // replaced the snapshot by now, and one that could not reveals nothing.
    if (frames.length <= pendingPage.before) {
      setEdgeReached(true)
      setPendingPage(undefined)
      return
    }
    // The page prepended older frames, so the same slot index now names a NEWER
    // frame; shifting the slot by the number that arrived keeps the user looking
    // at the message they had reached, one step further back than before.
    setEdgeReached(false)
    const grown = frames.length
    setPendingPage(undefined)
    // The walk grew, so the edge this press was pressed against has moved: a later
    // visit to the (new) edge is entitled to its own paging attempt. CLAMPED rather
    // than `stepSlot`: this is not a user press, so it must never wrap — a wrap here
    // would teleport the cursor to the newest frame right after a page arrived.
    setSlot(current => clampSlot(current + (grown - pendingPage.before) + 1, grown))
  }, [frames.length, pendingPage])

  // Settle a reuse that was waiting for its turn to be paged in.
  //
  // Runs on every frame-list change rather than only on `pendingReuse`, because the
  // arrival of the page is what it is waiting for. Two endings are possible and both
  // are honest: the turn's LOADED frame has appeared (reuse the real text), or the
  // page did not bring it (leave the composer alone — the outline's preview is not
  // the user's message, so writing it would be worse than doing nothing).
  useEffect(() => {
    if (pendingReuse === undefined) return
    const loaded = frames.find(frame => frame.turn === pendingReuse.turn && !frame.unloaded)
    if (loaded === undefined) {
      // Not here yet. If the turn vanished outright (a compaction, a session switch)
      // the request is moot; otherwise keep waiting for the next page.
      if (!frames.some(frame => frame.turn === pendingReuse.turn)) setPendingReuse(undefined)
      return
    }
    setPendingReuse(undefined)
    reuseRef.current(loaded)
    // The ending belongs to the gesture that armed the wait, not to the wait itself:
    // Enter commits (drop the stash, close the walk), the chord does neither. Closing
    // a chord's walk here would also strand the cursor — `quickSlot` survives, so the
    // user's NEXT press would keep walking from a position the readout no longer shows.
    if (pendingReuse.commit) {
      ownDraftRef.current = undefined
      lastWriteRef.current = undefined
      setPhase('idle')
    }
  }, [frames, pendingReuse])

  // A DIFFERENT SESSION under this overlay ends the walk outright.
  //
  // The shell renders the composer chain with no per-session key, so React reuses
  // this instance across a session switch and the slot/phase state would otherwise
  // carry over — where slot N is a different message entirely. The session standard
  // prop is the signal available here: `useChat` is per-session, so a new hook
  // identity means a new conversation (there is no session-id prop on this slot).
  //
  // Done during RENDER, not in a passive effect: the key listener reads `stateRef`,
  // which is assigned during render, so an effect would leave one committed frame in
  // which a keystroke still acted on the previous session's walk.
  const sessionRef = useRef(useChat)
  if (sessionRef.current !== useChat) {
    sessionRef.current = useChat
    setSlot(0)
    setQuickSlot(0)
    setPhase('idle')
    // Neither cursor is in play in a session the user has not walked yet.
    setQuickIsCurrent(false)
    setOffscreen(false)
    setPendingScroll(undefined)
    // A stash belongs to the session it was taken in.
    ownDraftRef.current = undefined
    lastWriteRef.current = undefined
    stateRef.current = { ...stateRef.current, slot: 0, quickSlot: 0, phase: 'idle' }
  }

  // --- A-19 item 3: opt-in smart follow ---
  //
  // OFF by default, and the default is the behaviour the user described: "无论用户
  // 手动移动了什么不同的页面，两个功能都是按自己内部的当前位置来处理". What the
  // user opts into is the opposite rule — their own manual move re-seats the
  // internal position on whatever they are now looking at.
  //
  // A ruler jump needs no separate case: `navigateToTurn` scrolls the transcript,
  // so the ruler arrives here as an ordinary scroll. That is why this feature needs
  // no Host change and no new wire signal — the reading position is observable from
  // the DOM the product already owns.
  const smartFollow = settings.historyJumpSmartFollow === true
  const followRef = useRef({ frames, quickFrames, smartFollow })
  followRef.current = { frames, quickFrames, smartFollow }
  /** The scrollable element smart follow last saw scroll (A-24: measurement is deferred). */
  const scrollerRef = useRef<HTMLElement | null>(null)
  // No "ignore our own scroll" marker is needed, and that is a MEASURED conclusion
  // rather than an omission. The walk scrolls a frame to the reading line and the
  // follow then picks the row nearest that line — the same frame — so re-seating is
  // idempotent and the walk cannot derail itself. A marker was written, mutation
  // tested, and removed: disabling it changed no spec's outcome, and it did not
  // cover the one case that looks like it needs covering, because a smooth scroll
  // fires many events and the mid-flight nearest row is an INTERMEDIATE frame that
  // no destination-keyed marker matches.
  useEffect(() => {
    if (!smartFollow) return
    // THE FREEZE THIS FIXES (A-24). The first version measured the layout directly
    // inside the scroll handler, and its cost grows with the conversation length:
    // `scroll` fires many times per frame, and every one of those events ran
    // `querySelectorAll('[data-chat-anchor-key]')` and then `getBoundingClientRect()`
    // once per row. Each of those reads forces a SYNCHRONOUS LAYOUT, so a single
    // scroll event cost one layout per rendered row — while the events kept arriving
    // for as long as the user was still dragging. The longer the session, the more
    // rows, the worse it got, which is exactly the reported "打开智能跟随后容易卡死".
    // Two changes make the cost bounded:
    //   1. rAF coalescing: at most ONE measurement per animation frame, however many
    //      scroll events fired. The work is tied to painting instead of to events.
    //   2. One layout read per row, in one pass, per frame rather than per event.
    // The listener stays in the CAPTURE phase so a scroll from any scrollable
    // descendant is seen, and stays on `document` because the transcript's scroller
    // is not ours to attach to.
    let pending = false
    // A-24 diagnostics. The freeze was reported as "容易卡死" with no log line to
    // confirm it, so the one thing worth recording is the COST of a measurement. The
    // rAF coalescing above makes this bounded per frame; if a future change reintroduces
    // per-event layout reads, `reads` climbs into the hundreds and the warning names it
    // instead of the user having to describe a frozen tab again. It is deliberately
    // conditional on a threshold that a healthy run never reaches — one read per row per
    // frame is normal, so the bar is set well above the largest realistic row count.
    let slowReported = false
    const measure = (): void => {
      pending = false
      const target = scrollerRef.current
      if (target === null) return
      const { frames: walk, quickFrames: quick } = followRef.current
      // The row nearest the reading line is the user's position. Anchor keys are
      // the product's own (`data-chat-anchor-key`), the same attribute
      // `scrollFrameIntoView` uses.
      const rows = target.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden])')
      if (!slowReported && rows.length > SLOW_ROW_THRESHOLD) {
        slowReported = true
        console.warn(
          `[dsh-atlas] smart follow is measuring ${rows.length} transcript rows per frame; `
          + 'a layout read per row per animation frame is the known freeze (A-24) if this grows unbounded.',
        )
      }
      let nearestKey: string | undefined
      let nearestDistance = Number.POSITIVE_INFINITY
      for (const row of rows) {
        const distance = Math.abs(row.getBoundingClientRect().top)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearestKey = row.dataset.chatAnchorKey
        }
      }
      if (nearestKey === undefined) return
      const seat = (list: readonly HistoryFrame[], set: (slot: number) => void): void => {
        const index = list.findIndex(frame => frame.key === nearestKey)
        // A row this feature cannot page (an assistant block, a frame outside the
        // loaded window) is not a position in its walk, so it is ignored rather
        // than clamped to a neighbour the user is not looking at.
        if (index >= 0) set(slotOfFrame(index, list.length))
      }
      seat(walk, setSlot)
      seat(quick, setQuickSlot)
    }
    const onScroll = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      // Remember WHICH element scrolled: the coalesced pass runs later, so it can no
      // longer read `event.target` (the handler used to measure inline).
      scrollerRef.current = target
      if (pending) return
      pending = true
      requestAnimationFrame(measure)
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      // A queued frame must not run after teardown and seat a cursor on a scroller
      // that is gone.
      scrollerRef.current = null
    }
  }, [smartFollow])

  // --- A-21 item 2: the chord's position resets when the walk's start changes ---
  //
  // "刷新页面或用户发起新消息后都将内部位置重置，以确保用户复用文本的起点始终是当下的
  // 初始位置（草稿位置）". The point is that Ctrl+Up must always mean "the newest message"
  // on a fresh start, so the user never has to remember where a previous walk left off.
  //
  // A page refresh needs NO code: the slot is component state seeded to 0, so a reload
  // already starts at the draft. What DOES survive a reuse is a walk that ended mid-way
  // with the composer still holding a reused message, which is why the reset is keyed to
  // the user's next real message rather than to a timer.
  //
  // This is done DURING RENDER rather than in an effect, and that is load-bearing: an
  // effect that called `setQuickSlot(0)` would schedule the reset as a second render,
  // which a keydown arriving in the same tick can beat — the press would then walk from
  // the OLD position and the user would get the oldest message instead of the newest.
  // Adjusting the state here makes the corrected slot part of the very render that sees
  // the new frame, so no handler can ever observe the stale one.
  //
  // Only the CHORD resets. ESC roaming keeps its own position across the same event,
  // because it is a deliberate "put me back where I was" gesture and A-19 item 3 already
  // governs when its position may move.
  //
  // The signal is the IDENTITY OF THE NEWEST user-authored frame, not the walk's
  // LENGTH. Length was this rule's first reading and it is wrong in a way only a real
  // multi-page history shows: paging replaces an outline frame with its loaded twin,
  // so `quickFrames` shrinks while the user's newest message is untouched — measured
  // live on a 40-turn session, where the chord's 25th press paged turn 16 in and the
  // list went 41 -> 40. A length signal read that as "a new message arrived" and yanked
  // a live chord walk back to the draft slot, so the next press handed back the NEWEST
  // message instead of continuing to turn 15. A new message can only appear at the
  // newest end, and paging only moves the OLD end, so the newest frame's turn is the
  // signal that means what this reset means.
  const newestQuickTurn = quickFrames.at(-1)?.turn ?? -1
  const chordResetRef = useRef({ quickSlot, turnRunning: sessionRunning, newestQuickTurn })
  if (chordResetRef.current.newestQuickTurn !== newestQuickTurn) {
    const previous = chordResetRef.current
    chordResetRef.current = { quickSlot, turnRunning: sessionRunning, newestQuickTurn }
    // A new frame while the chord sat off the draft: the user's own next message.
    if (previous.quickSlot !== 0 && !(previous.turnRunning && sessionRunning)) {
      setQuickSlot(0)
    }
  } else if (chordResetRef.current.quickSlot !== quickSlot || chordResetRef.current.turnRunning !== sessionRunning) {
    chordResetRef.current = { quickSlot, turnRunning: sessionRunning, newestQuickTurn }
  }

  /** Put one frame's original text back into the composer. */
  const reuse = useCallback((frame: HistoryFrame): void => {
    const current = draftRef.current
    // A stash is only good while the composer still holds what this plugin last
    // wrote. If the draft has moved on, the USER typed that text (or a previous
    // walk left it there) and it is the one a later walk must give back — so the
    // stale stash is dropped and replaced by what is really in the composer now.
    //
    // The `undefined` half is the important one and is easy to miss: after a walk
    // ends, `lastWriteRef` is cleared, so the NEXT walk's first reuse sees a
    // defined `current` with no recorded writer. Treating that as "already
    // stashed" is what made Ctrl+Down hand back a reused MESSAGE instead of the
    // user's draft (measured live: the walk restored `Create the relative path…`
    // — text this spec had never typed — in place of `ATLAS-OWN-DRAFT`).
    if (current !== lastWriteRef.current) ownDraftRef.current = undefined
    // Stash the user's OWN draft the first time a reuse overwrites it, so walking
    // back to slot 0 can give it back. Without this, "return to the draft" only
    // returned the CURSOR to slot 0 while the text there was the last reused
    // message — the user's own words were gone (measured live: a `RESET-ME` draft
    // was unrecoverable after two Ctrl+Up presses). Only the first overwrite is
    // stashed: later frames must not replace the real draft with a reused message.
    if (ownDraftRef.current === undefined) ownDraftRef.current = current
    const append = stateRef.current.reuseMode === 'append'
    const next = append && current.trim() !== '' && frame.text !== ''
      ? `${current}${current.endsWith('\n') ? '' : '\n'}${frame.text}`
      : frame.text
    // Focus FIRST, then write — and this ORDER is the whole fix for "reuse leaves
    // a draft I cannot type into". `setDraft` places the caret at the end of what
    // it writes, but Lexical only honours that while its root already has focus.
    // Writing into an unfocused editor left the text on screen with no usable
    // selection, and the next keystroke was silently dropped (measured live: the
    // draft was visible, `document.activeElement` WAS the composer, the DOM
    // selection WAS inside it, and typing still changed nothing). The quick chord
    // never blurs, which is why it never had this bug — the fix makes the Escape
    // path behave the same way.
    focusComposer()
    inputActionsRef.current.setDraft(next)
    lastWriteRef.current = next
  }, [])
  reuseRef.current = reuse

  /** Put the user's own draft back, as it was before the first reuse. */
  const restoreOwnDraft = useCallback((): void => {
    const own = ownDraftRef.current
    // No stash means the walk never overwrote anything, so the composer already
    // holds the user's own text and a write here would only fight the caret.
    if (own === undefined) {
      focusComposer()
      return
    }
    ownDraftRef.current = undefined
    focusComposer()
    inputActionsRef.current.setDraft(own)
    lastWriteRef.current = own
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = stateRef.current
      const intent = resolveIntent(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          isComposing: event.isComposing,
        },
        state.phase,
        {
          enabled,
          // Asked of the store directly: this is what makes an already-open menu
          // block Escape from the very first keystroke, not one commit later.
          menuOpen: menuRef.current?.getSnapshot().open ?? false,
          modalOpen: modalOpen(),
          generating: generatingRef.current,
          foreignEditor: isForeignEditor(event.target),
        },
      )
      if (intent === undefined) return
      const count = state.frames.length
      switch (intent.kind) {
        case 'enter':
          setSlot(0)
          setPhase('roaming')
          setEdgeReached(false)
          // A fresh walk has not tried to show anything yet.
          setOffscreen(false)
          // Opening the walk hands the readout to ROAMING: that is the thing the user
          // just asked to look at, even if the chord was the last thing to move.
          setQuickIsCurrent(false)
          // A fresh walk begins at the draft slot, which is not pressed against the
          // older edge, so the first arrival there pages before it wraps.
          pageTriedRef.current = false
          // A fresh walk starts from whatever the composer holds NOW, so any stash
          // from a previous walk is stale and must not be offered back.
          ownDraftRef.current = undefined
          lastWriteRef.current = undefined
          blurComposer()
          break
        case 'step': {
          const roaming = state.phase === 'roaming'
          // A-19 item 1: which frames this press may reach, and which cursor it
          // moves. The chord reuses what a human WROTE, so it walks the
          // user-authored subset; roaming reads the conversation, so it keeps
          // every frame. The filter runs before the wrap below, which is what
          // makes the chord's own first/last frame the edge it wraps at.
          const walkFrames = intent.quick ? state.quickFrames : state.frames
          const walkCount = walkFrames.length
          const cursor = intent.quick ? state.quickSlot : state.slot
          const moveCursor = intent.quick ? setQuickSlot : setSlot
          // The readout follows whoever acted last (see `chordIsCursor` below). Set
          // here, at the one place that decides WHICH cursor a step moves, so the two
          // can never disagree.
          setQuickIsCurrent(intent.quick)
          const amount = intent.page ? ROAM_PAGE_ROWS : 1
          // WRAPPING (A-17) must not pre-empt PAGING (A-12), so a step is resolved
          // in two stages.
          //
          // The walk's OLDER end is two different things in sequence: first "the
          // loaded window ran out, go get more", and only then "there is genuinely
          // nothing older, so wrap". `stepSlot` cannot tell them apart on its own —
          // it just wraps — so the edge is detected HERE, before wrapping, by
          // comparing the CLAMPED destination with the current slot.
          //
          // Without this split the very first press at the oldest frame would jump
          // to the newest one and the user could never page further back, i.e. A-12
          // would regress — which is exactly the failure the spec suite reported
          // when the wrap was introduced.
          let next = cursor
          // A-21: the CHORD does not wrap. ESC roaming still does (A-17 stands for it),
          // so the two features pass different answers here. Once the chord clamps,
          // the press-at-the-edge branch below can never fire for it, which is the
          // intended reading: the chord has no paging contract of its own beyond the
          // one the walk already performs for both features.
          const allowWrap = !intent.quick
          for (let index = 0; index < amount; index += 1) {
            // Each sub-step of a PAGED move is clamped, so a 5-row PageUp stops at
            // the end of the walk instead of wrapping around inside one gesture;
            // the wrap is a single-step gesture only.
            const stepped = stepSlot(next, intent.direction, walkCount, allowWrap)
            next = intent.page ? clampSlot(stepped, walkCount) : stepped
          }
          // A page that would wrap is a page that ran out: clamp it to the edge so
          // the paging branch below can still see "did not move".
          if (intent.page) next = clampSlot(next, walkCount)
          // The clamped destination BEFORE wrapping. Whenever it equals the slot we
          // are already on, this press is pressed against an end of the walk.
          //
          // This is stated as an explicit comparison rather than as the cheaper
          // `clampSlot(...) === cursor`, which is ALSO true at the draft end
          // (slot 0) for a downward press and would therefore have made the older
          // edge test fire on the wrong gesture.
          const clampedNext = clampSlot(cursor - intent.direction, walkCount)
          const atEdge = clampedNext === cursor && cursor > 0
          // A single step sitting exactly on the older edge pages ONCE instead of
          // wrapping; the following press at the same edge (nothing new arrived)
          // falls through to the wrap. `pageTriedRef` is what distinguishes the two
          // presses — see its declaration.
          const atEdgePress = atEdge && !pageTriedRef.current
          if (intent.direction === -1 && atEdgePress && walkCount > 0 && loadThroughRef.current !== undefined) {
            pageTriedRef.current = true
            const oldest = walkFrames[0]
            /* v8 ignore next -- `walkCount > 0` guarantees a first frame. */
            if (oldest !== undefined) {
              // Record the window size BEFORE the page; the effect above reconciles
              // against it once the frames arrive (or fail to). Doing that comparison
              // here would read a stale list — see `pendingPage`.
              setPendingPage({ before: walkCount })
              void loadThroughRef.current(oldest.seq).catch(() => {
                // A failed page is an edge the user must hear about, not a silent
                // stop (the plugin's standing rule for this branch).
                setPendingPage(undefined)
                setEdgeReached(true)
              })
            }
            event.preventDefault()
            return
          }
          // A step that lands on the slot it already occupies is a no-op, and it
          // must stay one. The quick chord writes through `reuse`, so letting it
          // fall through re-wrote the same message on EVERY extra press — in
          // append mode that duplicated the text into the draft each time
          // (reproduced: three extra writes after reaching the oldest frame).
          // Swallowing the key is deliberate: for Ctrl+Up at the top it does
          // exactly what the walk would have done, and it stops the browser's own
          // history/default action from firing instead.
          //
          // The step back ONTO slot 0 is exempt, and that exemption is the fix for
          // "Ctrl+Down does nothing". Slot 0 is the draft, so a Ctrl+Down that
          // clamps there from slot 1 lands on the slot it is leaving — the guard
          // read that as "cannot move", in BOTH phases, and swallowed the one
          // gesture that returns the user's own draft (measured live: two
          // Ctrl+Down presses in a row left the composer holding the reused
          // message, and the user's `RESET-ME` draft never came back).
          // A-16: with no frames there is nothing to walk, and the quick chord must
          // not be a silent no-op. This was the user's "Ctrl+Up does nothing at all
          // in this session, but Escape is fine": `Esc` only enters the walk (it
          // never reads the frames), while the chord needs a frame to reuse — and
          // with `count === 0` it fell into `restoreOwnDraft()`, which had nothing
          // stashed, so it focused the composer and returned without a word.
          //
          // A-13/A-14 merge the session-wide outline precisely so a window holding
          // no user message still yields frames; when even that is unavailable the
          // honest answer is to SAY so. Raising the edge flag surfaces the readout's
          // existing "no earlier history" language instead of the plugin appearing
          // dead — the same standing rule the failed-page branch above follows.
          //
          // This MUST come before the "cannot move" guard below, and that ordering is
          // the whole fix: with `count === 0` the only slot is 0, so `next` always
          // equals the current slot and the guard returned early — the announcement
          // was unreachable and the chord stayed silent. The spec caught the
          // ordering, not just the block.
          //
          // Tested against the cursor's OWN frame set (A-19): a session whose every
          // turn was system-initiated has roaming frames but nothing the chord may
          // reuse, and the chord must say so rather than silently reusing nothing.
          if (walkCount === 0) {
            moveCursor(0)
            // From the composer a press on an empty walk used to be completely
            // invisible, so it announced itself through the SAME readout the roaming
            // walk uses — including entering the roaming phase, which is what makes
            // that readout render at all (its `roaming` gate is also the `pointer`
            // gate for the whole bar). Anything less would leave the user unable to
            // tell "this session has no history" from "the shortcut is broken".
            if (!roaming) setPhase('roaming')
            setEdgeReached(true)
            if (!roaming) restoreOwnDraft()
            event.preventDefault()
            break
          }
          const returningToDraft = next === 0 && cursor !== 0
          if (next === cursor && !returningToDraft) {
            // Only the CHORD announces, and only when the readout is ALREADY on
            // screen. Both halves of that restraint are deliberate:
            //
            //   * Roaming keeps this guard as the ordinary "nothing moved" case (a
            //     clamped PageUp, or a downward press already on the draft). Raising
            //     the edge notice there would claim "no earlier history" about a
            //     gesture that never asked for older history.
            //   * The chord does NOT enter the roaming PHASE to say it. That would
            //     leave the user in a walk they never opened, and it leaked the phase
            //     into unrelated behaviour when tried (measured: three specs broke).
            //     Instead the readout is allowed to SHOW this one notice without the
            //     phase — see the `roaming: phase === 'roaming' || edgeReached` publish
            //     above, which is the whole mechanism.
            //
            // So a chord press at its older edge now names the end of the walk in both
            // phases, which is exactly the A-16 contract ("never a silent no-op") that
            // A-21 would otherwise have quietly reintroduced once the wrap was gone.
            if (intent.quick && atEdge) setEdgeReached(true)
            event.preventDefault()
            return
          }
          const frameIndex = frameAtSlot(next, walkCount)
          // Any actual move means we are no longer parked at that edge, so a later
          // visit is entitled to its own paging attempt.
          pageTriedRef.current = false
          setEdgeReached(false)
          // Which of the two features this step belongs to is decided by the
          // INTENT, not by the phase (A-18). A bare arrow moves the cursor so the
          // user can look at a message; the Ctrl/Cmd chord also writes that
          // message back into the composer so the user can reuse it. Both are
          // available in both phases, so gating on `roaming` here made the chord
          // mean two different things depending on how the user got there.
          if (!intent.quick) {
            // The cursor moves FIRST. The scroll below is this feature's only DOM
            // dependency, and a throw there must not be able to lose the move:
            // with the scroll first, a missing `CSS.escape` swallowed the step
            // entirely and the cursor stuck on the draft slot (observed under
            // jsdom, and reachable in any build without the anchor attribute).
            moveCursor(next)
            // Roaming shows where it is: bring the frame's row into view, or the
            // composer itself when the walk has returned to the draft slot. The
            // draft slot has its own visible destination (the composer), so a
            // previous frame's "could not scroll" notice no longer applies.
            if (frameIndex === undefined) { setOffscreen(false); restoreOwnDraft() }
            else {
              // `frameAtSlot` answers an in-range index, so the frame is present.
              const frame = walkFrames[frameIndex]
              /* v8 ignore next -- unreachable by construction: the slot arithmetic above cannot name an absent frame. */
              if (frame !== undefined) {
                // An outline-only frame has no row to scroll to, so asking for one
                // is a silent no-op — the defect the user reported on
                // system-initiated turns. Page the turn in and scroll when its real
                // row exists (see `pendingScroll`).
                // An outline-only frame with no loader to page it in cannot be
                // shown at all, and that is worth saying: the alternative is the
                // silent no-op the user reported.
                if (frame.unloaded && loadThroughRef.current === undefined) setOffscreen(true)
                else if (frame.unloaded && frame.turn !== undefined && frame.seq > 0
                  && loadThroughRef.current !== undefined) {
                  // A page is now the thing that will decide where the page goes,
                  // so the previous frame's verdict is stale.
                  setOffscreen(false)
                  setPendingScroll(frame.turn)
                  void loadThroughRef.current(frame.seq).catch(() => {
                    // A failed page must not leave the request armed forever, and
                    // it must not be silent either: the readout says the frame
                    // could not be shown (the plugin's standing rule).
                    setPendingScroll(undefined)
                    setEdgeReached(true)
                  })
                } else {
                  // A loaded frame's row is asked for and nothing is reported when
                  // it is missing: a transcript row can legitimately not be in the
                  // DOM yet (a virtualized list, a row that has not painted), and a
                  // notice on every such step would be noise rather than feedback.
                  // The reportable case is narrower and lives in the settlement
                  // below: a frame that was PAGED IN because it had no row, and
                  // still has none once its page has arrived.
                  scrollFrameIntoView(frame.key)
                }
              }
            }
          } else {
            // The quick chord writes the text straight away — a user pressing
            // Ctrl+Up wants the message, not a highlight to confirm. It reads the
            // DESTINATION slot, so the move and the reuse are one step rather than
            // "look at the frame you were already on".
            //
            // While roaming the cursor advances too: the two features are
            // distinguished by what a press DOES (move vs. move-and-reuse), not by
            // whether the roaming highlight exists. Reusing without moving would
            // make the chord re-read the same frame on every press.
            moveCursor(next)
            const quickIndex = frameAtSlot(next, walkCount)
            const resolved = quickIndex === undefined ? undefined : walkFrames[quickIndex]
            if (resolved === undefined) restoreOwnDraft()
            else if (resolved.unloaded && resolved.turn !== undefined && resolved.seq > 0
              && loadThroughRef.current !== undefined) {
              // A-13 applies to the CHORD too, and this is the arm that actually
              // exercises it: the chord reuses straight from the walk without the
              // roam step's paging (A-26), so it is the one gesture that can land on
              // an outline-only frame. Its `text` is the projection's bounded
              // PREVIEW, so writing it would hand the user a truncated message.
              // Defer exactly as `case 'reuse'` does: page the turn in, and let the
              // settlement below write the LOADED text when it arrives.
              setOffscreen(false)
              // `commit: false` — the chord is mid-walk and its press must not end it.
              setPendingReuse({ turn: resolved.turn, commit: false })
              void loadThroughRef.current(resolved.seq).catch(() => {
                setPendingReuse(undefined)
                setEdgeReached(true)
              })
            } else reuse(resolved)
          }
          break
        }
        case 'edge':
          if (intent.to === 'draft') restoreOwnDraft()
          // Deliberately NOT paging: Home is a JUMP ("take me to the top of what you
          // have"), not a step, so it stops at the oldest loaded frame. Only the
          // STEP gestures page — pressing up at the edge is a request to go further,
          // which is the distinction the user's report is about. The existing spec
          // pins this, so it is a decision rather than an omission.
          setSlot(intent.to === 'oldest' ? count : 0)
          break
        case 'reuse': {
          const frameIndex = frameAtSlot(state.slot, count)
          const frame = frameIndex === undefined ? undefined : state.frames[frameIndex]
          if (frame !== undefined) {
            if (frame.unloaded && frame.turn !== undefined && frame.seq > 0 && loadThroughRef.current !== undefined) {
              // A-13: this frame came from the session-wide outline, so its `text` is
              // that projection's bounded PREVIEW — writing it would hand the user a
              // truncated message. Page the turn in first, then reuse the real one.
              // Deferred through the same reconciliation the edge press uses: once
              // the page lands, the frame of that turn is the LOADED one, and the
              // pending reuse resolves against it (see `pendingReuse`).
              // `commit: true` — Enter's ending, applied once the real text is in.
              setPendingReuse({ turn: frame.turn, commit: true })
              void loadThroughRef.current(frame.seq)
              break
            }
            reuse(frame)
          }
          // Enter is a COMMITMENT: the reused text is now what the user is working
          // on, so the stashed draft is dropped rather than offered back on a later
          // walk. Only the quick chord (which never leaves the composer) keeps it.
          ownDraftRef.current = undefined
          lastWriteRef.current = undefined
          setPhase('idle')
          break
        }
        case 'palette':
          // The palette is a DIFFERENT overlay with its own listener, so this one
          // neither acts on the chord nor consumes it: consuming it here would
          // preventDefault the keystroke before the palette ever saw it, and the
          // palette could never open. Leaving `defaultPrevented` alone is what
          // lets the two overlays share the chord.
          return
        default:
          // 'leave' — Escape is ours, an ordinary keystroke is the user's and is
          // left to reach the composer with its normal meaning.
          setPhase('idle')
          if (isLeave(intent) && intent.consume) focusComposer()
          break
      }
      if (consumes(intent)) event.preventDefault()
    }
    // A capture listener, so the gesture is seen before the composer's own key
    // handling. `defaultPrevented` is deliberately not consulted: this plugin's
    // own menu bridge also runs in capture phase, so a sibling handler's
    // preventDefault must not silently cancel the history gesture.
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [enabled])

  // The visual state is published as attributes on the root element: CSS paints
  // the conversation highlight from them, and a test can read them without
  // depending on generated class names.
  // A-21 exposed this: the readout followed the ROAMING slot unconditionally, so a
  // chord write made from the composer could leave the composer holding the oldest
  // history message while the readout said "Current draft" — measured in the browser
  // lane, where the draft was HISTORY-1 and the readout still read "History 0 / 24
  // Current draft". That is worse than a missing notice: it actively contradicts what
  // the user sees in the composer.
  //
  // The rule: the readout describes the cursor that LAST ACTED, because that is the
  // one whose effect the user is looking at. Inferring it from the phase is wrong and
  // the browser lane proved it: a user who presses Escape and then drives the CHORD
  // is in the roaming phase while the roaming cursor never moves (A-19 gave the chord
  // its own cursor), so a phase-based readout reported slot 0 — "Current draft" —
  // while the composer held the oldest message the chord had just written.
  //
  // `chordIsCursor` therefore records the last mover rather than deriving it. Roaming
  // still owns the readout the moment Escape opens the walk (that is what the user
  // asked to see), and any chord step hands it back to the chord.
  const chordIsCursor = quickIsCurrent
  // `frameAtSlot` only ever answers an in-range index (or undefined), so the lookups
  // are unguarded; the list a slot belongs to is the one its own cursor walks.
  const highlightedIndex = chordIsCursor
    ? frameAtSlot(quickSlot, quickFrames.length)
    : frameAtSlot(slot, frames.length)
  const highlightedFrame = highlightedIndex === undefined
    ? undefined
    : (chordIsCursor ? quickFrames : frames)[highlightedIndex]
  const highlightedKey = highlightedFrame?.key ?? ''

  useEffect(() => {
    /* v8 ignore next -- guard for the server-rendered shell; a jsdom spec always has a document. */
    if (typeof document === 'undefined') return
    const root = document.documentElement
    if (phase !== 'roaming') {
      root.removeAttribute('data-atlas-roaming')
      root.removeAttribute('data-atlas-frame-key')
      return
    }
    root.setAttribute('data-atlas-roaming', 'true')
    if (highlightedKey === '') root.removeAttribute('data-atlas-frame-key')
    else root.setAttribute('data-atlas-frame-key', highlightedKey)
    return () => {
      root.removeAttribute('data-atlas-roaming')
      root.removeAttribute('data-atlas-frame-key')
    }
  }, [phase, highlightedKey])

  // Paint the cursor's frame. The band is a boolean marker per row rather than a
  // class, because the rows belong to the chat package and an attribute is the
  // least intrusive thing this plugin can put on someone else's element.
  //
  // `frames` is deliberately NOT a dependency even though the walk produces it:
  // `useMemo` gives that array a fresh identity whenever the node map does, so
  // depending on it re-queried every anchor row on every streamed token — while
  // the only thing that changes the ANSWER is which key is highlighted. The
  // `frames.length` term keeps a growing session repainted (a row that arrives
  // while the cursor is parked must not stay unmarked) without the array identity
  // forcing a repaint when nothing moved.
  useEffect(() => {
    /* v8 ignore next -- guard for the server-rendered shell; a jsdom spec always has a document. */
    if (typeof document === 'undefined') return
    const rows = document.querySelectorAll('[data-chat-anchor-key]')
    for (const row of rows) {
      const hit = phase === 'roaming' && highlightedKey !== '' && row.getAttribute('data-chat-anchor-key') === highlightedKey
      if (hit) row.setAttribute('data-atlas-frame-hit', '')
      else row.removeAttribute('data-atlas-frame-hit')
    }
    return () => {
      for (const row of rows) row.removeAttribute('data-atlas-frame-hit')
    }
  }, [phase, highlightedKey, frames.length])

  // The readout used to be a `position: fixed` strip whose left edge and width
  // were copied from the composer card's rect here, because a fixed element has no
  // ancestor to take those from. It now renders INSIDE the composer's own dock —
  // a flex column that already has the composer's width — so the measurement, the
  // two custom properties, and the forced layout they cost are all gone rather
  // than merely made cheaper. The card's geometry is no longer this component's
  // business.

  const frameCount = frames.length
  // A-16: an empty walk says so instead of reporting "第 0 / 0 条 当前草稿", which
  // reads as a working walk sitting on the draft and is precisely what made the user
  // conclude the key was broken. It is a SINGLE sentence, so the preview is blanked
  // rather than following it with a meaningless draft label.
  //
  // "Empty" is judged against the list the ACTIVE cursor walks (see `chordIsCursor`):
  // a session where nothing is user-authored has a full roaming walk but nothing the
  // chord may reuse, and reporting the roaming total there would promise the chord
  // frames it does not have (A-19 tests this from the chord's own side).
  const readoutCount = chordIsCursor ? quickFrames.length : frameCount
  const empty = readoutCount === 0
  // A-20: a system-initiated turn has no prompt in the outline, so its preview is
  // empty and the readout used to draw a blank cell. Name the origin instead, and
  // fall back to a sentence when there is no text at all — a tag alone would leave
  // the row looking half-filled.
  const systemInitiated = highlightedFrame?.systemInitiated === true && !empty
  // The origin wins over the kind: a turn nobody asked a question in is a SYSTEM
  // turn, and its answer is the only place that fact can surface — tagging it
  // "回复" would hide who opened it. A reply to a prompt is tagged as a reply.
  const tag = systemInitiated
    ? t('history.systemTag')
    : highlightedFrame?.kind === 'reply' && !empty ? t('history.replyTag') : ''
  const preview = empty
    ? ''
    : highlightedFrame === undefined
      ? t('history.draftSlot')
      : highlightedFrame.preview === '' && systemInitiated
        ? t('history.systemOnly')
        : highlightedFrame.preview
  // A-33: the unit follows the ladder. `'turn'` mode counts TURNS — the same
  // number the page's right-side rail draws — so the readout says 轮 and a user
  // can check it against the ruler at a glance. `'message'` mode still counts
  // messages, and saying 轮 there would be a lie.
  const positionKey = mode === 'turn' ? 'history.positionTurn' : 'history.position'
  const count = empty
    ? t('history.empty')
    : highlightedIndex === undefined
      ? t(positionKey, { index: '0', total: String(readoutCount) })
      : t(positionKey, { index: String(readoutCount - highlightedIndex), total: String(readoutCount) })

  // Publish for the dock-hosted readout. This runs after every render but the
  // store compares by value, so a streamed token that changes nothing the readout
  // shows does not re-render it. `roam` is held in the injected face and is never
  // an effect dependency — the shell re-injects on every render, so depending on
  // the face would restart this effect forever.
  //
  // `roaming` here means "the readout is showing", not strictly "the walk is open".
  // A-21 made the chord CLAMP at its edge, and a consumed press that changes nothing
  // is exactly the A-16 complaint ("完全不起作用"). The chord cannot enter the roaming
  // PHASE to explain that — that would leave the user in a walk they never opened, and
  // it leaked the phase into unrelated behaviour when tried. So the one thing it is
  // allowed to do is surface this ONE notice, which is what the `edgeReached` arm
  // below adds; the walk itself stays closed.
  const roamStore = roamRef.current
  useEffect(() => {
    roamStore?.set({
      roaming: phase === 'roaming' || edgeReached || offscreen,
      count,
      preview,
      edge: edgeReached,
      tag,
      offscreen,
    })
  }, [roamStore, phase, count, preview, edgeReached, tag, offscreen])

  if (phase !== 'roaming') return null

  // The overlay renders NOTHING visible: its job is the keyboard, and the readout
  // it drives lives in the input dock so it cannot float over `/goal` or `/todo`.
  return null
}

/** Injected surface for the dock-hosted readout. */
export interface FrameReadoutInjected {
  /** The store the overlay publishes the cursor into. */
  readonly roam?: RoamStore
}

/**
 * The dock-hosted counterpart of `FrameCursorProps`, for the readout half.
 *
 * It deliberately does NOT take the Chat hook: the cursor is already computed by
 * the overlay half, and recomputing the walk here would double the work for a
 * value it would then have to keep in step. It reads the published store instead.
 */
export type FrameReadoutProps =
  & PropsRuntime<'conversation.input.dock'>
  & InjectFace<FrameReadoutInjected>
  & PropsLocale<typeof NS>

/**
 * The roaming readout, rendered above the composer.
 *
 * It lives in `conversation.input.dock` rather than in an overlay, which is what
 * the user asked for: `/goal` and `/todo` are dock entries too, and the dock is a
 * flex column, so the three STACK instead of covering one another. That is a
 * structural guarantee — there is no z-index to get wrong and no geometry to
 * measure — and it also means the readout shares the composer's width for free,
 * which is what the retired card-measuring effect used to arrange by hand.
 *
 * It renders nothing at all while the walk is inactive, so the dock gains no
 * permanent row when the feature is not in use.
 * @param props - the dock slot props, carrying the injected store.
 * @returns the readout strip, or null when not roaming.
 */
export function FrameReadout(props: FrameReadoutProps): ReactElement | null {
  const t = props.t
  const store = props.roam
  // The store is optional (an injected spec may omit it), and hooks cannot be
  // called conditionally, so the subscription reads through a fallback that never
  // notifies rather than branching around the call.
  const view = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIBE,
    store?.getSnapshot ?? readHidden,
    store?.getSnapshot ?? readHidden,
  )
  if (!view.roaming) return null
  return (
    <div className="dsh_atlas_roamBar" role="status" aria-live="polite">
      <div className="dsh_atlas_roamBarInner">
        <span className="dsh_atlas_roamBarTag">{t('history.roamLabel')}</span>
        <span className="dsh_atlas_roamBarCount">{view.count}</span>
        <span className="dsh_atlas_roamBarSep" aria-hidden="true" />
        {view.tag === '' ? null : <span className="dsh_atlas_roamBarOrigin">{view.tag}</span>}
        <span className="dsh_atlas_roamBarText">{view.preview}</span>
        {view.edge ? <span className="dsh_atlas_roamBarEdge">{t('history.edge')}</span> : null}
        {view.offscreen ? <span className="dsh_atlas_roamBarEdge">{t('history.offscreen')}</span> : null}
      </div>
    </div>
  )
}

/** A subscription for the no-store case, so the hook call stays unconditional. */
const NO_SUBSCRIBE = (): (() => void) => () => {}

/**
 * The view reported when no store was injected: hidden.
 *
 * A single frozen instance, NOT a fresh object per call: `useSyncExternalStore`
 * compares its `getSnapshot` result with `Object.is` and re-renders whenever it
 * differs, so a getter that built a new object every time would re-render this
 * component until React aborted with "getSnapshot should be cached" (observed:
 * the no-store spec threw instead of rendering nothing).
 */
const HIDDEN_VIEW: RoamView = { roaming: false, count: '', preview: '', edge: false, tag: '', offscreen: false }

/** The reader for the no-store case, kept out of the JSX so its identity is stable. */
const readHidden = (): RoamView => HIDDEN_VIEW

/**
 * Scroll one frame's row into view, when the build exposes the anchor attribute.
 *
 * The scroll is the ONLY DOM dependency in this feature. The row attributes are
 * present in the harness source but absent from some shipped builds (verified
 * against this machine's `apps/web/dist`), so a missing row must degrade to
 * "highlight without scrolling" instead of throwing.
 *
 * The boolean is what keeps that degradation from being SILENT: the caller turns
 * a `false` into a readout notice, because "the page did not move" is exactly the
 * report this feature keeps attracting, and a build without the anchor attribute
 * would otherwise look identical to a broken one.
 * @param key - the Chat node key, which is also the row's `data-chat-anchor-key`.
 * @returns whether a row was found and asked to scroll.
 */
function scrollFrameIntoView(key: string): boolean {
  /* v8 ignore next -- guard for the server-rendered shell; a jsdom spec always has a document. */
  if (typeof document === 'undefined' || key === '') return false
  // Both `CSS.escape` and `scrollIntoView` are optional here on purpose: this is
  // the degraded path, and a build that can highlight without scrolling is the
  // documented fallback rather than a failure.
  const escaped = typeof CSS === 'undefined' ? key.replace(/["\\]/g, '\\$&') : CSS.escape(key)
  const row = document.querySelector(`[data-chat-anchor-key="${escaped}"]`)
  if (row === null) return false
  row.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  return true
}

/**
 * Build the frame list from the session's live Chat snapshot.
 *
 * `useChat` arrives as a standard PROP rather than through this plugin's
 * injection face: the ui-chat package declares it in `SessionStandardProps`, and
 * the renderer spreads that bundle into every session-scoped slot component, so
 * the hook is available on the props object directly. Selecting `order` and
 * `nodes` separately keeps the rebuild tied to the node set rather than to every
 * snapshot identity.
 * @param useChat - the session's standard Chat selector hook.
 * @param mode - the configured frame granularity.
 * @param projections - the session's projection face, when this build has one.
 * @returns the frames, oldest first.
 */
function useHistoryFrames(
  useChat: HistoryChatHook,
  mode: HistoryFrameMode,
  projections?: ProjectionFace,
): readonly HistoryFrame[] {
  const order = useChat(snapshot => snapshot.order)
  const nodes = useChat(snapshot => snapshot.nodes)

  // The session-wide turn outline, merged in so the walk's total matches the
  // page's own ruler instead of stopping at the paged window (A-13).
  //
  // `useSyncExternalStore` rather than a React hook of the framework's: the
  // projection face is a bare `ObservableSnapshot` (the same shape ui-goal and
  // ui-model-selection read), and this plugin is not handed `useProjection` —
  // that hook is declared on `ChatViewInjected`, which only the
  // `conversation.view` slot receives. The subscribe/getSnapshot pair is pulled
  // off a REF-held stable face, because the shell re-injects on every render and
  // a fresh pair each time would resubscribe forever.
  const outlineFace = projections?.faceOf('turnOutline')
  const outlineFaceRef = useRef(outlineFace)
  outlineFaceRef.current = outlineFace
  const subscribeOutline = useCallback(
    (listener: () => void) => outlineFaceRef.current?.subscribe(listener) ?? noop,
    [],
  )
  const outlineSnapshot = useCallback(() => outlineFaceRef.current?.getSnapshot(), [])
  const outline = useSyncExternalStore(subscribeOutline, outlineSnapshot, outlineSnapshot)

  // `buildFrames` is a full walk of the session's nodes and is NOT cheap on a long
  // session (measured in this repo: 10.1ms at 2000 turns / 4000 nodes, 5.3ms at
  // 1000, 0.4ms at 50). It was the obvious suspect for the reported first-press
  // stall, and it was MEASURED AND EXONERATED: in the browser lane the first
  // Ctrl/Cmd+Up on a real session costs 18ms, and the slowest of four presses was
  // 63ms. Do not add a cache here on the theory that the walk is slow — a cache
  // keyed on the store's identities is exactly what `useMemo` already does, so it
  // buys nothing and reads as an optimisation that is not one. Making this faster
  // would mean changing what `buildFrames` reads, not how often it runs.
  return useMemo(
    () => buildFrames(order, key => nodes.get(key) as never, mode, outline),
    [order, nodes, mode, outline],
  )
}

/** A subscription that never fires; see `useHistoryFrames`. */
function noop(): () => void {
  return () => {}
}
