// @vitest-environment jsdom
/**
 * F2: the frame roaming cursor. Escape enters, the arrows walk, Enter reuses,
 * and the quick chord does the same walk straight from the composer.
 *
 * The pure key resolution and the frame index are covered in their own specs;
 * this one is about what the COMPONENT does with an intent: which draft it
 * writes, which attributes it paints on the document, and that it gives the
 * palette's chord a clear field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import { FrameCursor, ROAM_PAGE_ROWS, type FrameCursorProps, type FrameReadoutProps, FrameReadout } from '../src/client/FrameCursor.tsx'
import { createRoamStore, type RoamStore, type RoamView } from '../src/client/roam-store.ts'
import { fmt, zh } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

const t = (key: string, params?: Record<string, string>): string => fmt(zh[key] ?? key, params)

/** One user message node, in the Host's `content[]` shape. */
function userNode(text: string, turn: number, kind = 'user'): unknown {
  return {
    kind,
    data: { content: [{ type: 'text', text }], seq: turn, time: turn * 1_000 },
    location: { kind: 'turn', turn: { turn } },
  }
}

/**
 * One node whose message the SYSTEM started rather than a human.
 *
 * `user/message` events carry a `source` discriminant, and `source.kind !== 'user'`
 * is the Host's own verdict for a message nobody typed — injected context, an
 * automated follow-up. The node kind is still `user` (it renders as a message), so
 * only the source distinguishes it, which is exactly the case A-19 filters on.
 * @param text - the injected text.
 * @param turn - the owning turn.
 * @returns the node.
 */
function systemNode(text: string, turn: number): unknown {
  return {
    kind: 'user',
    data: {
      content: [{ type: 'text', text }],
      seq: turn,
      time: turn * 1_000,
      source: { kind: 'plugin' },
    },
    location: { kind: 'turn', turn: { turn } },
  }
}

/**
 * A transcript scroller holding one row per anchor key, each at a given top.
 *
 * The follow logic measures distance from the top of the viewport, which jsdom
 * does not lay out, so each row's `getBoundingClientRect` is stubbed: the caller
 * says which row is nearest the reading line by giving it the smallest top.
 * @param tops - anchor key to the row's viewport top in px.
 * @returns the scroller element, already attached to the document.
 */
function scrollerWithRows(tops: Record<string, number>): HTMLElement {
  const scroller = document.createElement('div')
  scroller.setAttribute('data-conversation-scroll', '')
  const topsNow: Record<string, number> = { ...tops }
  for (const key of Object.keys(topsNow)) {
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', key)
    row.getBoundingClientRect = () => {
      const top = topsNow[key] as number
      return { top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) }
    }
    // Scrolling a row into view moves it to the reading line AND produces a real
    // scroll event, as it does in a browser. Both halves matter: without the event
    // the walk would never even reach the follow listener, and the guard that
    // keeps the walk from following itself would look unnecessary.
    row.scrollIntoView = () => {
      for (const other of Object.keys(topsNow)) topsNow[other] = other === key ? 8 : 400
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    scroller.appendChild(row)
  }
  document.body.appendChild(scroller)
  return scroller
}

/**
 * Animation frames queued by the smart-follow listener (A-24).
 *
 * The follow coalesces its measurement into a `requestAnimationFrame`, so a spec
 * that only dispatches a scroll is looking at the DOM before the cursor moved.
 * jsdom's rAF is a real timer, so the callbacks are captured here and pumped
 * synchronously instead of waiting on the clock — the same discipline the key
 * presses use, and it keeps the assertion about the cursor rather than about
 * timing.
 */
const frameCallbacks: FrameRequestCallback[] = []

beforeEach(() => {
  frameCallbacks.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameCallbacks.push(callback)
    return frameCallbacks.length
  })
})

afterEach(() => { vi.unstubAllGlobals() })

/**
 * Bring one row to the reading line and report the scroll, as a user would.
 *
 * The listener is registered on `document` in the CAPTURE phase, so a bubbling
 * event dispatched from the scroller reaches it with `target` set to the scroller
 * — which is what a real scroll does.
 * @param scroller - the scroller holding the rows.
 * @param key - the anchor key now nearest the top of the viewport.
 */
function userScrollsTo(scroller: HTMLElement, key: string): void {
  // Two flushes: the first dispatches the native scroll, the second runs the
  // animation frame the listener queued, because the follow defers its
  // measurement by one frame. Without the second the spec would read the
  // pre-update DOM.
  flushSync(() => {
    scroller.querySelector<HTMLElement>(`[data-chat-anchor-key="${key}"]`)?.scrollIntoView?.()
  })
  flushSync(() => { frameCallbacks.splice(0).forEach(callback => { callback(0) }) })
}

/** One assistant step, in the Host's `blocks[]` shape. */
function assistantNode(text: string, turn: number): unknown {
  return { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text }] }, location: { kind: 'turn', turn: { turn } } }
}

/**
 * A chat snapshot over the given nodes, in insertion order.
 *
 * The snapshot is built ONCE per stub and the same `order`/`nodes` references are
 * handed back on every call, which is what the real selector hook does. Building
 * a fresh pair per call would let two selections in one render disagree, and the
 * frame list would then briefly read as empty and the component's clamp would
 * reset the cursor (observed while writing these tests).
 * @param table - node key to node.
 * @returns the selector hook.
 */
function chatStub(table: Record<string, unknown>, generating = false): FrameCursorProps['useChat'] {
  const order = Object.keys(table)
  const nodes = new Map(Object.entries(table))
  // `partial` is the snapshot's streaming step: non-null means a turn is running.
  const snapshot = { order, nodes, partial: generating ? { streaming: true } : null }
  return (<T,>(selector: (value: typeof snapshot) => T): T => selector(snapshot)) as FrameCursorProps['useChat']
}

/**
 * One stable `useChat` per table object.
 *
 * The real hook is per-SESSION and its identity is therefore stable across the
 * re-renders of one session — which is exactly what the component reads as "the
 * same conversation". A fresh function per `props()` call would instead look like
 * a session switch on every render. Keying on the table identity reproduces the
 * real contract: same table (same session) → same function; a different table
 * (a different session) → a different function.
 *
 * A spec that needs the SAME session to change its node set (a shrink, a
 * compaction) uses `sessionStub` below instead of swapping the table.
 * @param table - node key to node.
 * @param generating - whether a turn is running.
 * @returns the selector hook.
 */
function stableChatStub(table: Record<string, unknown>, generating = false): FrameCursorProps['useChat'] {
  const cached = chatStubs.get(table)
  if (cached !== undefined && cached.generating === generating) return cached.hook
  const hook = chatStub(table, generating)
  chatStubs.set(table, { hook, generating })
  return hook
}

/**
 * A stable hook for ONE session whose node set can change under it.
 *
 * Identity stays fixed (it is one session) while `set` swaps what the snapshot
 * answers, which is how a compaction or a node removal actually reaches the
 * component: the same session, a shorter history.
 * @param initial - the starting node key to node table.
 * @returns the hook plus a `set` that replaces the table.
 */
function sessionStub(initial: Record<string, unknown>): {
  useChat: FrameCursorProps['useChat']
  set: (table: Record<string, unknown>) => void
} {
  let table = initial
  let nodes = countingNodes(initial)
  const useChat = (<T,>(selector: (value: unknown) => T): T => {
    const order = Object.keys(table)
    return selector({ order, nodes, partial: null })
  }) as FrameCursorProps['useChat']
  // `set` rebuilds the map, which is what models a store that republishes on
  // change — and is why the walk's cache cannot help a genuine content change.
  return { useChat, set: next => { table = next; nodes = countingNodes(next) } }
}

const chatStubs = new WeakMap<Record<string, unknown>, { hook: FrameCursorProps['useChat']; generating: boolean }>()

/**
 * How many node lookups the component has performed on the current stub session.
 *
 * `buildFrames` walks the order and calls `get` for every key, so this counts
 * WALKS rather than renders: a cached render reads nothing. Spying on the import
 * itself is not possible (`buildFrames` is called inside `FrameCursor.tsx`), so
 * the count is taken at the one seam the walk cannot avoid — the node map the
 * selector hands it.
 */
let nodeReads = 0
function walkCount(): number { return nodeReads }
function resetWalkCount(): void { nodeReads = 0 }

/**
 * A node map that counts every `get`, so a spec can assert on how many walks
 * happened rather than on how long they took.
 * @param table - node key to node.
 * @returns a counting view over a real Map.
 */
function countingNodes(table: Record<string, unknown>): Map<string, unknown> {
  const nodes = new Map(Object.entries(table))
  return {
    get: (key: string) => { nodeReads += 1; return nodes.get(key) },
    has: (key: string) => nodes.has(key),
    entries: () => nodes.entries(),
    keys: () => nodes.keys(),
    values: () => nodes.values(),
    forEach: (...args: Parameters<Map<string, unknown>['forEach']>) => nodes.forEach(...args),
    get size() { return nodes.size },
  } as unknown as Map<string, unknown>
}

/**
 * The table `props()` uses when a spec does not supply one.
 *
 * Hoisted to a module constant on purpose: it stands for one session, and the
 * selector-hook identity is keyed on it, so rebuilding it per call would read as
 * a session switch on every render.
 */
const DEFAULT_TABLE: Record<string, unknown> = {
  u1: userNode('first question', 1),
  a1: assistantNode('answer one', 1),
  u2: userNode('second question', 2),
  a2: assistantNode('answer two', 2),
}

/**
 * A controllable menu store, for the "the @ menu owns the arrows" cases.
 * @param initial - the menu's open state at mount.
 * @returns the store, plus a `set` that notifies subscribers like the real one.
 */
function menuStub(initial: boolean): {
  getSnapshot: () => { open: boolean }
  subscribe: (listener: () => void) => () => void
  set: (open: boolean) => void
} {
  let open = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ open }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: boolean) => { open = next; for (const listener of listeners) listener() },
  }
}

/**
 * A session projection face stub, shaped like the real one.
 *
 * The real face is the session's `projections` seat: `faceOf(key)` answers an
 * identity-stable observable whose snapshot is the key's value. Only
 * `turnOutline` is ever asked for, and an absent key answers `undefined` — the
 * same "capability absent" spelling the framework uses.
 * @param outline - the outline value to publish.
 * @returns the face.
 */
function projectionStub(outline: readonly unknown[]): FrameCursorProps['projections'] {
  const face = { getSnapshot: () => outline, subscribe: () => () => {} }
  return { faceOf: (key: string) => (key === 'turnOutline' ? face : { getSnapshot: () => undefined, subscribe: () => () => {} }) }
}

/** Mount-ready props. */
function props(over: {
  table?: Record<string, unknown>
  draft?: string
  historyJump?: boolean
  historyJumpFrames?: 'message' | 'turn'
  historyJumpReuseMode?: 'replace' | 'append'
  historyJumpSmartFollow?: boolean
  menu?: ReturnType<typeof menuStub>
  setDraft?: (text: string) => void
  loadThrough?: (seq: number) => Promise<void>
  generating?: boolean
  useChat?: FrameCursorProps['useChat']
  roam?: RoamStore
  outline?: readonly unknown[]
} = {}): FrameCursorProps {
  const table = over.table ?? DEFAULT_TABLE
  const stub = {
    session: {},
    scope: {
      getSnapshot: () => ({
        value: {
          historyJump: over.historyJump ?? true,
          historyJumpFrames: over.historyJumpFrames ?? 'message',
          historyJumpReuseMode: over.historyJumpReuseMode ?? 'replace',
          historyJumpSmartFollow: over.historyJumpSmartFollow ?? false,
        },
      }),
      subscribe: () => () => {},
    },
    useInput: <T,>(selector: (state: { draft: string }) => T): T => selector({ draft: over.draft ?? '' }),
    inputActions: { setDraft: over.setDraft ?? (() => {}) },
    useChat: over.useChat ?? stableChatStub(table, over.generating ?? false),
    // The gate reads the SESSION snapshot's `running`, not the Chat `partial`.
    useSession: <T,>(selector: (state: { running: boolean }) => T): T =>
      selector({ running: over.generating ?? false }),
    menu: over.menu,
    loadThrough: over.loadThrough,
    projections: over.outline === undefined ? undefined : projectionStub(over.outline),
    roam: over.roam ?? createRoamStore(),
    t,
  }
  return stub as unknown as FrameCursorProps
}

/**
 * The readout's props, derived from the overlay's.
 *
 * Only the store and the translator cross over: the readout deliberately does NOT
 * take the Chat hook, because recomputing the walk for it would duplicate the
 * cursor the overlay already computed.
 * @param built - the overlay's props.
 * @returns props for `FrameReadout`.
 */
function readoutProps(built: Record<string, unknown>): FrameReadoutProps {
  return { roam: built.roam, t: built.t } as unknown as FrameReadoutProps
}

function mount(element: ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return { root, container }
}

/** Dispatch one capture-phase keydown at the document body. */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

/**
 * Press a key and let React commit the resulting state before returning.
 *
 * Each press needs its own flush: `FrameCursor` reads the previous slot through
 * a ref refreshed during render, so two presses inside one flush would both see
 * the same stale slot and the walk would advance only once.
 * @param key - the key value.
 * @param init - extra event fields.
 * @param target - where to dispatch; `document.body` by default.
 */
function pressAndSettle(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): void {
  flushSync(() => { press(key, init, target) })
}

/** The roaming readout, or null while idle. */
function roamBar(): HTMLElement | null {
  return document.querySelector('.dsh_atlas_roamBar')
}

/**
 * Mount the roaming PAIR.
 *
 * The gesture and the readout are two components in two slots — the overlay owns
 * the keyboard, the dock draws the strip — so a spec that wants to see the
 * readout has to mount both against one store, exactly as `apply` does. Mounting
 * only the overlay is still valid for a spec about keys; it simply renders nothing.
 * @param over - the overrides `props()` takes.
 * @returns the root and the overlay's container.
 */
function mountPair(over: Parameters<typeof props>[0] = {}): { root: Root; container: HTMLDivElement } {
  const built = props(over)
  return mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
}

/**
 * Both halves as ONE tree, for specs that re-render to simulate a new session or a
 * new chat snapshot. Re-rendering only the overlay would leave the dock showing a
 * stale cursor — which is the very bug those specs exist to catch — so the pair has
 * to stay paired across renders too, and this takes the same props object shape so
 * a re-render is a one-word change.
 * @param rest - the overlay's props, which carry the store the readout needs.
 * @returns the overlay and the readout.
 */
function PairMount(rest: Record<string, unknown>): ReactElement {
  return (
    <>
      <FrameCursor {...(rest as unknown as FrameCursorProps)} />
      <FrameReadout {...readoutProps(rest)} />
    </>
  )
}

beforeEach(() => {
  // The suite shares ONE jsdom document, and this overlay writes state in three
  // separate places: the body, attributes on `documentElement`, and the card
  // geometry as CSS custom properties. Clearing only the body left the rest to the
  // next spec, which is how a stale `data-atlas-roaming` made an unrelated test
  // read as a B-03 regression and a leftover anchor row inflated a scroll count.
  document.body.innerHTML = ''
  for (const name of ['data-atlas-roaming', 'data-atlas-frame-key', 'data-atlas-frame-count']) {
    document.documentElement.removeAttribute(name)
  }
  document.documentElement.style.removeProperty('--dsh-atlas-roam-left')
  document.documentElement.style.removeProperty('--dsh-atlas-roam-width')
  resetWalkCount()
})

describe('FrameCursor', () => {
  it('renders nothing until Escape is pressed', () => {
    const { root } = mountPair()
    expect(roamBar()).toBeNull()
    expect(document.documentElement.hasAttribute('data-atlas-roaming')).toBe(false)
    root.unmount()
  })

  it('enters roaming on Escape and names the draft slot first', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    expect(roamBar()).not.toBeNull()
    // The walk starts on the draft, which is what the user is looking at.
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    expect(document.documentElement.getAttribute('data-atlas-roaming')).toBe('true')
    root.unmount()
  })

  it('walks to the newest message on the first ArrowUp', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    // The newest MESSAGE here is the assistant's reply: an answer is a message too,
    // which is the gap the user reported ("为什么系统轮次不会像用户轮次一样被跳到").
    expect(roamBar()?.textContent).toContain('answer two')
    expect(document.documentElement.getAttribute('data-atlas-frame-key')).toBe('a2')
    // The question the walk used to stop on is now the next stop back.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    expect(document.documentElement.getAttribute('data-atlas-frame-key')).toBe('u2')
    root.unmount()
  })
  it('pages an unloaded frame in, then scrolls to the row the page reveals (A-26)', () => {
    // The reported defect: roaming onto a frame the window has NOT loaded did
    // nothing visible. Such a frame is outline-only, and a system-initiated turn is
    // exactly the kind of turn the outline has while the window does not (A-20: a
    // system turn's prompt is empty in the projection). Its key is the synthetic
    // `turn:1`, no transcript element carries that key, so the scroll resolved to
    // null and the page sat still while the readout said a frame had been reached.
    //
    // The fix pages the turn in and scrolls when the REAL row exists, so this spec
    // observes both halves: the page was requested for the right turn, and the
    // scroll then happened against the loaded frame's key — which is the part a
    // spec asserting only "loadThrough was called" would miss entirely.
    const asked: number[] = []
    const scrolled: string[] = []
    const outline = [{ turn: 1, seq: 1, prompt: '', response: 'system-only turn' }]
    // The window holds only turn 9, so turn 1 exists ONLY in the outline.
    const session = sessionStub({ a: userNode('ninth question', 9) })
    const loadThrough = (seq: number) => { asked.push(seq); return Promise.resolve() }
    const { root, container } = mountPair({ useChat: session.useChat, outline, loadThrough })
    pressAndSettle('Escape')
    // Slot 1 is the NEWEST frame (turn 9, which the window holds), so this step pages
    // nothing: a loaded frame already has its row.
    pressAndSettle('ArrowUp')
    expect(asked).toEqual([])
    // Slot 2 is the oldest — the outline-only turn. Asserting the request pins WHICH
    // turn was paged, because paging any other frame would look identical from the
    // cursor's position alone.
    pressAndSettle('ArrowUp')
    expect(asked).toEqual([1])
    // Nothing has scrolled: turn 1's row does not exist until the page lands, which
    // is precisely why the old code had nothing to do here.
    expect(scrolled).toEqual([])

    // The page arrives: turn 1's LOADED frame (node key `z`, deliberately not the
    // synthetic `turn:1`) replaces the outline frame.
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'z')
    row.scrollIntoView = () => { scrolled.push('z') }
    document.body.appendChild(row)
    flushSync(() => { session.set({ z: userNode('system kickoff', 1), a: userNode('ninth question', 9) }) })
    flushSync(() => {
      root.render(<PairMount {...props({ useChat: session.useChat, outline, loadThrough })} />)
    })
    // The scroll is the whole point: the page MOVED once the row existed.
    expect(scrolled).toEqual(['z'])
    root.unmount()
    container.remove()
    row.remove()
  })

  it('says so when the paged-in frame still has no row to show (A-26)', () => {
    // The other half of the same report, and the reason the notice is not simply
    // "the page finished": a page can land and still leave nothing on screen (a
    // build without the anchor attribute, a row that never painted). Then the
    // gesture IS a no-op as far as the user can see, so it must say why rather
    // than look dead — the standing rule A-16 established for the chord.
    const outline = [{ turn: 1, seq: 1, prompt: '', response: 'system-only turn' }]
    const session = sessionStub({ a: userNode('ninth question', 9) })
    const { root, container } = mountPair({
      useChat: session.useChat,
      outline,

    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')

    pressAndSettle('ArrowUp')

    // The page lands with the turn's frame, but NO row is planted for it.
    flushSync(() => { session.set({ z: userNode('system kickoff', 1), a: userNode('ninth question', 9) }) })
    flushSync(() => {
      root.render(<PairMount {...props({
        useChat: session.useChat,
        outline,

      })} />)
    })
    expect(roamBar()?.textContent).toContain(zh['history.offscreen'])
    root.unmount()
    container.remove()
  })

  it('keeps walking back through older messages', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    // Four stops: the reply to turn 2, the question of turn 2, the reply to turn 1,
    // and finally the first question.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer one')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('first question')
    // A-17: at the oldest frame the walk WRAPS to the other end — the draft. This
    // used to clamp (the spec pinned "another press changes nothing"), which the
    // user asked to replace with a wrap: "从历史第一条消息到了 最后一条之后，
    // 再按 Ctrl up 就会回到 草稿（如果有的话）".
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('explains the chord clamp instead of swallowing the press (A-21 + A-16)', () => {
    // Removing the chord's wrap (A-21) made `next === cursor` reachable for the
    // chord for the FIRST time: before, an edge press always moved the cursor to the
    // other end. A consumed press that changes nothing is precisely the A-16 report
    // ("完全不起作用"), and the browser lane caught it in that exact form — the edge
    // press moved neither the draft nor the readout.
    //
    // The notice is only observable while ROAMING, because the readout bar renders
    // only in that phase. That is a limit of where the product can speak, not a hole
    // in the contract: from the composer the chord's effect is the draft it writes.
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    // Drive the CHORD to its own older edge (A-19: it has its own cursor).
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    expect(roamBar()?.textContent).not.toContain(zh['history.edge'])
    // The next chord press has nowhere older to go and must SAY so.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    expect(roamBar()?.textContent).toContain(zh['history.edge'])
    root.unmount()
  })

  it('describes the frame the CHORD wrote, not the roaming slot it never moved (A-21)', async () => {
    // Found in the browser lane once A-21 landed. The readout followed the ROAMING
    // slot unconditionally, so a chord write made from the composer left the composer
    // holding the oldest history message while the readout still said the walk was on
    // the draft — measured there as the draft holding HISTORY-1 while the bar read
    // "History 0 / 24 Current draft". That contradicts what the user is looking at,
    // which is worse than saying nothing.
    //
    // The rule this pins: the readout names the cursor actually in play. Roaming owns
    // it while the walk is open; otherwise the CHORD owns it — and the bar becomes
    // visible exactly when the chord has something to say (A-21's clamp notice).
    //
    // Note what this spec deliberately does NOT assert: a bare chord move from the
    // composer draws no bar. The readout is not a HUD for the chord — it appears when
    // the chord reaches its edge and has to explain itself, which is the next spec.
    // Asserting a bar on an ordinary move would pin a design nobody asked for.
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(roamBar()).toBeNull()
    expect(written).toEqual(['second question'])
    // A second press reaches the chord's oldest frame: still an ordinary move, so
    // still no bar. The readout is not a HUD that follows every chord step.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(written).toEqual(['second question', 'first question'])
    expect(roamBar()).toBeNull()
    // The THIRD press has nowhere older to go. THAT is the edge, and the readout
    // appears to say so — describing the frame the chord is sitting on, which is what
    // the pre-fix readout got wrong by reporting the roaming slot (`0 / 2 Current
    // draft`) while the composer held the oldest message.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(written).toEqual(['second question', 'first question'])
    expect(roamBar()?.textContent).toContain('first question')
    expect(roamBar()?.textContent).toContain(zh['history.edge'])
    root.unmount()
  })

  it('follows the chord even while the roaming walk is open (A-21)', async () => {
    // The exact shape the browser lane caught, and the reason `chordIsCursor` is
    // STATE rather than `phase !== 'roaming'`: the user presses Escape (opening the
    // roaming walk) and THEN drives the chord. The phase is roaming the whole time,
    // but the roaming cursor never moves — A-19 gave the chord its own cursor — so a
    // phase-based readout described slot 0 while the composer held the message the
    // chord had just written. Measured there as the draft holding HISTORY-1 while the
    // bar read "History 0 / 24 Current draft".
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    // The chord walks to its own older edge, never touching the roaming slot.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(written).toEqual(['second question', 'first question'])
    // The readout describes the CHORD's frame, not the roaming walk's untouched draft.
    expect(roamBar()?.textContent).toContain('first question')
    expect(roamBar()?.textContent).not.toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('walks forward again with ArrowDown, ending on the draft', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    // Home jumps straight to the OLDEST frame, whatever the walk's length is now
    // that replies are stops too (draft -> a2 -> u2 -> a1 -> u1).
    pressAndSettle('Home')
    expect(roamBar()?.textContent).toContain('first question')
    pressAndSettle('ArrowDown')
    expect(roamBar()?.textContent).toContain('answer one')
    pressAndSettle('ArrowDown')
    expect(roamBar()?.textContent).toContain('second question')
    pressAndSettle('ArrowDown')
    expect(roamBar()?.textContent).toContain('answer two')
    pressAndSettle('ArrowDown')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    expect(document.documentElement.hasAttribute('data-atlas-frame-key')).toBe(false)
    root.unmount()
  })

  it('jumps to the oldest on Home and back to the draft on End', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    pressAndSettle('Home')
    expect(roamBar()?.textContent).toContain('first question')
    pressAndSettle('End')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('pages by the roam page size', () => {
    // Five messages, so one PageUp from the draft must reach the oldest, while
    // one ArrowUp only reaches the newest.
    const table: Record<string, unknown> = {}
    for (let index = 1; index <= ROAM_PAGE_ROWS; index += 1) table[`u${index}`] = userNode(`message ${index}`, index)
    const { root } = mountPair({ table })
    pressAndSettle('Escape')
    pressAndSettle('PageUp')
    expect(roamBar()?.textContent).toContain('message 1')
    pressAndSettle('PageDown')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('fills the composer with the highlighted message on Enter', () => {
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('Enter')
    // The newest MESSAGE is the reply, so that is what Enter hands back.
    expect(written).toEqual(['answer two'])
    // Reusing ends the walk.
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('does nothing on Enter while still on the draft slot', () => {
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    pressAndSettle('Enter')
    expect(written).toEqual([])
    root.unmount()
  })

  it('leaves on Escape without writing anything', () => {
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('Escape')
    expect(roamBar()).toBeNull()
    expect(written).toEqual([])
    root.unmount()
  })

  it('leaves on an ordinary keystroke without consuming it', () => {
    // The character has to reach the composer: swallowing it to exit a mode
    // would silently eat the first letter the user types.
    const { root } = mountPair()
    pressAndSettle('Escape')
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    flushSync(() => {})
    expect(roamBar()).toBeNull()
    expect(event.defaultPrevented).toBe(false)
    root.unmount()
  })

  it('consumes the keystrokes that are its own', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    flushSync(() => {})
    expect(event.defaultPrevented).toBe(true)
    root.unmount()
  })

  it('does not enter roaming when the feature is off', () => {
    const { root } = mountPair({ historyJump: false })
    pressAndSettle('Escape')
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('does not enter roaming while a modal owns the keyboard', () => {
    const { root } = mountPair()
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    pressAndSettle('Escape')
    expect(roamBar()).toBeNull()
    modal.remove()
    root.unmount()
  })

  it('does not enter roaming from a foreign text field', () => {
    const { root, container } = mountPair()
    const input = document.createElement('input')
    container.appendChild(input)
    pressAndSettle('Escape', {}, input)
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('does not enter roaming while the @ menu owns the arrows', () => {
    const menu = menuStub(true)
    const { root } = mountPair({ menu })
    // The menu's open state arrives in an effect, so it needs one flush before
    // the guard can see it: pressing into a half-committed render would test
    // nothing.
    flushSync(() => {})
    pressAndSettle('Escape')
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('hands the arrows back when the @ menu opens mid-walk', () => {
    const menu = menuStub(false)
    const { root } = mountPair({ menu })
    flushSync(() => {})
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    // The composer's @ menu opening takes the arrows over: another ArrowUp must
    // not move the cursor behind the menu's back.
    flushSync(() => { menu.set(true) })
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    // And closing it gives the arrows back.
    flushSync(() => { menu.set(false) })
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    root.unmount()
  })

  it('works without the optional menu injection', () => {
    const { root } = mountPair({ menu: undefined })
    pressAndSettle('Escape')
    expect(roamBar()).not.toBeNull()
    root.unmount()
  })

  it('steps and reuses straight from the composer with the quick chord', () => {
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    // No Escape first: Ctrl+Up alone must reach the newest message.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question'])
    // The chord never paints the roaming state.
    expect(roamBar()).toBeNull()
    expect(document.documentElement.hasAttribute('data-atlas-roaming')).toBe(false)
    root.unmount()
  })

  it('walks further back on a second quick chord press', () => {
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    root.unmount()
  })

  it('returns to the draft with the quick down chord', () => {
    const written: string[] = []
    const { root } = mountPair({
      draft: 'my own words',
      setDraft: text => { written.push(text) },
    })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowDown', { ctrlKey: true })
    // Reaching the draft slot hands the composer back to the user. That REQUIRES a
    // write: once a frame is on screen the composer holds the reused message, so
    // "return to the draft" without writing left the user staring at a message
    // they had not typed. Measured live before the fix: Ctrl+Down walked the
    // cursor to slot 0 while the text stayed on the last frame.
    expect(written).toEqual(['second question', 'my own words'])
    root.unmount()
  })

  // --- A-15: while roaming, a modified arrow is the SAME gesture as a bare one ---
  //
  // The user's report was "进入ESC模式后，按 ctrl + up 或 down 为何还是识别为 up 或
  // down?" — the chord DID reach the walk, but through the chord arm, so it carried
  // chord semantics (write the frame into the draft) instead of the walk's own.
  // These specs pin the equality the user asked for: the two spellings must produce
  // the same cursor and the same readout while roaming.

  // A-18 REVERSES this pair. They used to assert that Ctrl+Arrow while roaming was
  // indistinguishable from a bare Arrow and wrote nothing back. The user asked for
  // the opposite: the chord keeps its "reuse this message" semantics wherever it is
  // pressed, so what distinguishes the two features is the modifier, not the phase.
  //
  // Note the previous versions could not have caught the reversal either way: one
  // asserted `written` against a LOCAL array that was never wired to the component,
  // so it was vacuously true. These read the composer itself.

  it('reuses a frame on Ctrl+Up while roaming instead of only moving', () => {
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    // One bare press parks the roaming cursor on the newest frame. The CHORD's own
    // cursor is untouched by it (A-19 item 2), so it is still on its own slot 0.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    expect(written).toEqual([])
    // The chord's first press reaches the newest frame — its own walk starts from
    // the draft, not from wherever roaming happens to be — and hands the text back.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question'])
    // A second press continues the chord's OWN walk.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    root.unmount()
  })

  it('reuses a frame on Ctrl+Down while roaming too', () => {
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    // Walk the CHORD (not roaming) two frames back, then one forward again: the
    // step back must write the newer frame rather than repeat the older one.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    pressAndSettle('ArrowDown', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question', 'second question'])
    root.unmount()
  })

  it('treats Meta as the command chord, because isCommandOnly accepts it', () => {
    // A-18 kept the old A-15 win of NOT dropping a modified arrow merely because
    // "some modifier is held", and A-19 then split the two features by cursor. A
    // Meta arrow IS the command chord on every platform this plugin supports
    // (`isCommandOnly` = ctrl OR meta, without Alt/Shift), so it drives the CHORD's
    // cursor and writes back — it does not move the roaming highlight.
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp', { metaKey: true })
    expect(written).toEqual(['second question'])
    root.unmount()
  })

  it('treats Alt as plain navigation, because Alt is not the command key', () => {
    // The complement of the spec above: Alt must NOT be read as the chord, or a
    // user holding Alt would silently rewrite their draft. It stays navigation.
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp', { altKey: true })
    expect(written).toEqual([])
    // Alt+Arrow drives the ROAMING cursor, so the readout moves: the newest
    // message is the reply, and the question that asked it is the stop behind it.
    expect(roamBar()?.textContent).toContain('answer two')
    pressAndSettle('ArrowUp', { altKey: true })
    expect(roamBar()?.textContent).toContain('second question')
    root.unmount()
  })

  it('still keeps the chord non-navigational keys out of the walk', () => {
    // A-15 widens the walk to MODIFIED ARROWS only. A modified non-navigation key
    // (Ctrl+C to copy, Ctrl+A to select) must stay untouched, or the walk would
    // swallow shortcuts the composer and the browser own.
    const { root } = mountPair()
    pressAndSettle('Escape')
    const before = roamBar()?.textContent
    pressAndSettle('a', { ctrlKey: true })
    // A printable key leaves the walk entirely (its documented behaviour), so the
    // assertion is that it did not MOVE the cursor on the way out.
    expect(roamBar()?.textContent ?? before).not.toContain('first question')
    root.unmount()
  })

  // --- A-19: the chord's frame set and cursor are its own ---

  it('skips a system-initiated frame when walking with the chord', () => {
    // A-19 item 1: the chord exists so a user can reuse something they WROTE, so a
    // turn the system started on its own must not be reachable by it. Roaming keeps
    // every frame, because reading around a message is a different job.
    const written: string[] = []
    const { root } = mountPair({
      table: {
        a: userNode('first question', 1),
        // `source.kind !== 'user'` is the Host's own verdict for injected context.
        b: systemNode('injected context nobody typed', 2),
        c: userNode('second question', 3),
      },
      setDraft: text => { written.push(text) },
    })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    // The newest USER frame, not the newer system one.
    expect(written).toEqual(['second question'])
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    // The system frame is never written, no matter how many presses follow — this
    // is the whole point of the filter.
    for (let press = 0; press < 3; press += 1) pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).not.toContain('injected context nobody typed')
    root.unmount()
  })

  it('keeps the system-initiated frame reachable while roaming', () => {
    // The complement: A-19 filters the CHORD only. Escape + arrows must still show
    // every frame, including the one the chord skips.
    const { root } = mountPair({
      table: {
        a: userNode('first question', 1),
        b: systemNode('injected context nobody typed', 2),
        c: userNode('second question', 3),
      },
    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('injected context')
    root.unmount()
  })

  // --- A-20: the roam bar must name a system turn instead of going blank ---

  it('labels a system-initiated frame in the roam bar and still shows its text', () => {
    const { root } = mountPair({
      table: {
        a: userNode('first question', 1),
        b: systemNode('injected context nobody typed', 2),
        c: userNode('second question', 3),
      },
    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    const bar = roamBar()
    // The origin is named...
    expect(bar?.textContent).toContain(zh['history.systemTag'])
    // ...and the message text is still there, because a loaded node carries it.
    expect(bar?.textContent).toContain('injected context')
    root.unmount()
  })

  it('does not label a normal user frame as system-initiated', () => {
    // The one error worse than the blank this fixes: calling the user's own
    // message "system". A user frame must carry no tag at all.
    const { root } = mountPair({ table: { a: userNode('first question', 1) } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    const bar = roamBar()
    expect(bar?.textContent).toContain('first question')
    expect(bar?.textContent).not.toContain(zh['history.systemTag'])
    root.unmount()
  })

  it('fills the blank cell of an unloaded system turn with the origin and a reason', () => {
    // THE REPORTED BLANK. An outline-only frame has no node, so there is no text
    // to show: the projection records a prompt only for a human message, leaving a
    // system-started turn with an empty prompt. Before A-20 that rendered as an
    // empty cell. The window here holds NO node for the system turn, so the frame
    // comes from the outline — exactly the case the user hit.
    //
    // The system turn is the NEWEST one, because frames sort ascending by turn and
    // the walk counts down from the newest: one ArrowUp from the draft must land on
    // it. Putting it first would have landed on the user's own turn and the spec
    // would have proved nothing about the blank.
    const { root } = mountPair({
      table: { a: userNode('first question', 1) },
      outline: [
        { turn: 1, seq: 1, prompt: 'first question', response: 'an answer' },
        { turn: 2, seq: 2, prompt: '', response: 'a system answer' },
      ],
    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    const bar = roamBar()
    expect(bar?.textContent).toContain(zh['history.systemTag'])
    expect(bar?.textContent).toContain(zh['history.systemOnly'])
    root.unmount()
  })

  it('keeps the two cursors independent in both directions', () => {
    // A-19 item 2: walking one feature must not move the other. Roaming three
    // frames back and then pressing the chord must NOT continue from there — the
    // chord resumes from its own position.
    const written: string[] = []
    const { root } = mountPair({
      table: {
        a: userNode('first question', 1),
        b: userNode('second question', 2),
        c: userNode('third question', 3),
      },
      setDraft: text => { written.push(text) },
    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    // The chord's own cursor never moved, so its first press is still the newest.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['third question'])
    root.unmount()
  })

  // --- A-21 item 2: the chord resets its position when the walk's start changes ---

  it('resets the chord to the draft once the user sends a new message', () => {
    // "刷新页面或用户发起新消息后都将内部位置重置，以确保用户复用文本的起点始终是当下的
    // 初始位置（草稿位置）". Park the chord two frames back, then let the user send
    // something: the next Ctrl+Up must read the NEWEST message, not continue from
    // where the old walk had stopped.
    //
    // `sessionStub` rather than a swapped table, because sending a message is ONE
    // session whose node set GREW — swapping the table would change the hook identity
    // and look like a session switch, which resets the walk for an entirely different
    // reason and would have made this spec pass without the A-21 code.
    const session = sessionStub({
      a: userNode('first question', 1),
      b: userNode('second question', 2),
    })
    const written: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => {
      root.render(<PairMount {...props({ useChat: session.useChat, setDraft: (v: string) => { written.push(v) } })} />)
    })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    // The user sends a third message: same session, one more user-authored frame.
    flushSync(() => {
      session.set({
        a: userNode('first question', 1),
        b: userNode('second question', 2),
        c: userNode('third question', 3),
      })
    })
    // The new snapshot has to be RENDERED for the component to see it: `set` only
    // swaps what the hook would answer next.
    flushSync(() => {
      root.render(<PairMount {...props({ useChat: session.useChat, setDraft: (v: string) => { written.push(v) } })} />)
    })
    written.length = 0
    pressAndSettle('ArrowUp', { ctrlKey: true })
    // The newest frame, i.e. the reset worked. Without it the chord would have kept
    // walking from the oldest and written nothing at all.
    expect(written).toEqual(['third question'])
    root.unmount()
    container.remove()
  })

  it('leaves the roaming walk parked where it was when a new message arrives', () => {
    // The reset is the CHORD's alone. Roaming is a deliberate "put me back" gesture,
    // so a new message must not yank the highlight out from under the user.
    const table = { a: userNode('first question', 1), b: userNode('second question', 2) }
    const session = sessionStub(table)
    // ONE store across both renders: `props()` builds a fresh one each call, and the
    // readout subscribes to whichever it was given, so re-rendering with a different
    // store would unmount the bar this spec is reading.
    const roam = createRoamStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => {
      root.render(<PairMount {...props({ useChat: session.useChat, roam })} />)
    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    flushSync(() => {
      session.set({ ...table, c: userNode('third question', 3) })
    })
    expect(roamBar()?.textContent).toContain('second question')
    root.unmount()
    container.remove()
  })

  it('starts the chord at the draft on a fresh mount, which is what a refresh gives', () => {
    // The refresh half of A-21 needs no code — the slot is component state seeded to
    // 0 — so this pins the contract rather than a mechanism: a brand-new mount walks
    // from the draft, with no position inherited from anywhere.
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question'])
    root.unmount()
  })

  // --- A-19 item 3: opt-in smart follow ---

  it('leaves both cursors alone when smart follow is off, which is the default', () => {
    // The user's default口径: the two features each work from their own internal
    // position no matter what the user scrolled to. A scroll is not a move of that
    // position unless the user explicitly asked for the follow.
    const scroller = scrollerWithRows({ u1: 8, u2: 400 })
    const { root } = mountPair({ setDraft: () => {} })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    // The user scrolls to the older frame; without the opt-in nothing changes.
    userScrollsTo(scroller, 'u1')
    expect(roamBar()?.textContent).toContain('answer two')
    root.unmount()
    scroller.remove()
  })

  it('re-seats the walk on the row at the reading line when smart follow is on', () => {
    // `u1` is nearest the reading line, so the user is looking at the OLDER frame
    // now, not the one the walk parked on.
    const scroller = scrollerWithRows({ u1: 8, u2: 400 })
    const { root } = mountPair({ historyJumpSmartFollow: true, setDraft: () => {} })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    userScrollsTo(scroller, 'u1')
    expect(roamBar()?.textContent).toContain('first question')
    root.unmount()
    scroller.remove()
  })

  it('ignores a scroll that came from no element, and one with no rows to follow', () => {
    const { root } = mountPair({ historyJumpSmartFollow: true, setDraft: () => {} })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    const before = roamBar()?.textContent
    expect(before).toContain('answer two')

    // The document scrolled, not an element: there is no scroller to read.
    flushSync(() => { document.dispatchEvent(new Event('scroll', { bubbles: true })) })
    flushSync(() => { frameCallbacks.splice(0).forEach(callback => { callback(0) }) })
    expect(roamBar()?.textContent).toBe(before)

    // An element scrolled, but it holds no anchor row: no nearest row, so the
    // cursor stays where the walk put it instead of jumping to a neighbour.
    const empty = document.createElement('div')
    document.body.appendChild(empty)
    flushSync(() => { empty.dispatchEvent(new Event('scroll', { bubbles: true })) })
    flushSync(() => { frameCallbacks.splice(0).forEach(callback => { callback(0) }) })
    expect(roamBar()?.textContent).toBe(before)
    empty.remove()
    root.unmount()
  })

  it('re-seats the chord from a ruler jump, which is itself a scroll', () => {
    // A ruler jump needs no separate signal: `navigateToTurn` scrolls the
    // transcript, so it arrives here as an ordinary scroll. This spec is why the
    // feature needs no Host change and no new wire endpoint.
    const scroller = scrollerWithRows({ u1: 8, u2: 400 })
    const written: string[] = []
    const { root } = mountPair({
      historyJumpSmartFollow: true,
      setDraft: text => { written.push(text) },
    })
    userScrollsTo(scroller, 'u1')
    // The chord's cursor now sits on the OLDER user frame, so its first press
    // moves forward from there — to the newest frame — rather than starting at
    // the draft as it would with the follow off.
    pressAndSettle('ArrowDown', { ctrlKey: true })
    expect(written).toEqual(['second question'])
    root.unmount()
    scroller.remove()
  })

  it('is not derailed by the scrolls the walk itself performs', () => {
    // The walk scrolls each frame into view, and in a browser that scroll comes
    // back to this same listener. Re-seating onto the frame the walk just reached
    // is idempotent, so the walk must simply continue: this is the regression
    // guard for a follow that would fight its own feature.
    const scroller = scrollerWithRows({ u1: 400, u2: 400 })
    const { root } = mountPair({ historyJumpSmartFollow: true, setDraft: () => {} })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    // Four stops: reply, question, reply, question — then the wrap.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer one')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('first question')
    // The oldest frame reached, the walk wraps to the draft as it always does.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
    scroller.remove()
  })

  it('measures the reading position once per frame, not once per scroll event', () => {
    // THE A-24 REGRESSION. The freeze was a cost problem, not a logic problem: the
    // handler called `getBoundingClientRect()` per row on EVERY scroll event, and a
    // scroll fires many times per frame, so the forced-layout count grew with the
    // conversation. Asserting "it still works" would pass even with the freeze, so
    // this spec counts the LAYOUT READS: many events in one frame must produce one
    // measurement pass, not one per event.
    const scroller = scrollerWithRows({ u1: 400, u2: 40 })
    let reads = 0
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
      const original = row.getBoundingClientRect.bind(row)
      row.getBoundingClientRect = () => { reads += 1; return original() }
    }
    const { root } = mountPair({ historyJumpSmartFollow: true, setDraft: () => {} })
    pressAndSettle('Escape')
    reads = 0
    // 25 scroll events inside ONE animation frame — a burst any real drag produces.
    flushSync(() => {
      for (let i = 0; i < 25; i += 1) scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(reads).toBe(0)
    flushSync(() => { frameCallbacks.splice(0).forEach(callback => { callback(0) }) })
    // One frame, one pass over the two rows — not 25 passes over them.
    expect(reads).toBe(2)
    root.unmount()
    scroller.remove()
  })

  it('warns once when the follow pass has an implausible number of rows to measure', () => {
    // A-24's other half: the user asked for a LOG, because "容易卡死" arrived with
    // nothing to confirm it. The warning must fire on the condition that actually
    // means trouble (a measurement pass covering an implausible number of rows) and
    // must fire ONCE, so a dragging user does not flood the console with the same
    // line every frame.
    const tops: Record<string, number> = {}
    for (let index = 0; index < 501; index += 1) tops[`u${index}`] = 400 + index
    const scroller = scrollerWithRows(tops)
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(String(args[0])) })
    const { root } = mountPair({ historyJumpSmartFollow: true, setDraft: () => {} })
    pressAndSettle('Escape')
    try {
      flushSync(() => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
      flushSync(() => { frameCallbacks.splice(0).forEach(callback => { callback(0) }) })
      const afterFirst = warnings.filter(line => line.includes('[dsh-atlas]')).length
      expect(afterFirst).toBe(1)
      // A second frame over the same oversized list must NOT warn again.
      flushSync(() => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
      flushSync(() => { frameCallbacks.splice(0).forEach(callback => { callback(0) }) })
      expect(warnings.filter(line => line.includes('[dsh-atlas]')).length).toBe(1)
    } finally {
      warn.mockRestore()
      root.unmount()
      scroller.remove()
    }
  })

  it('stays quiet for a normal transcript, so the warning keeps its meaning', () => {
    // The converse, and the reason the threshold is not a formality: one layout read
    // per row per frame is the HEALTHY path, so warning on it would make the log
    // useless exactly when it is needed.
    const scroller = scrollerWithRows({ u1: 400, u2: 40 })
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(String(args[0])) })
    const { root } = mountPair({ historyJumpSmartFollow: true, setDraft: () => {} })
    pressAndSettle('Escape')
    try {
      flushSync(() => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
      flushSync(() => { frameCallbacks.splice(0).forEach(callback => { callback(0) }) })
      expect(warnings.filter(line => line.includes('[dsh-atlas]'))).toEqual([])
    } finally {
      warn.mockRestore()
      root.unmount()
      scroller.remove()
    }
  })

  // --- A-16: a chord with nothing to walk must say so, not do nothing ---

  it('does not walk silently when there is no history at all', () => {
    // The reported second symptom: Ctrl+Up "完全不起作用" in a session the ruler
    // showed history for. The walk was empty, `frameAtSlot` answered undefined and
    // the handler returned after focusing the composer — a silent no-op with no
    // state change a test (or a user) could observe. A-16 makes the empty walk
    // visibly reported instead.
    const written: string[] = []
    const { root } = mountPair({ table: {}, setDraft: text => { written.push(text) } })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    // Nothing was reused — there is no frame to reuse — and the walk announced
    // itself so the user can tell "no history" from "the key is broken".
    expect(written).toEqual([])
    expect(roamBar()?.textContent).toContain(zh['history.empty'])
    root.unmount()
  })

  it('reports the empty walk when roaming too, rather than freezing', () => {
    const { root } = mountPair({ table: {} })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain(zh['history.empty'])
    root.unmount()
  })

  // --- A-17: the walk wraps at both ends ---

  it('wraps from the oldest message round to the draft slot', () => {
    // The user's口径: "从历史第一条消息到了 最后一条之后，再按 Ctrl up 就会回到 草稿
    // （如果有的话）". With no loader there is nothing to page, so a single press at
    // the oldest frame is already the wrap.
    const { root } = mountPair({ draft: 'my own words' })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('first question')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('wraps back to the oldest message from the draft slot', () => {
    // The reverse half of the cycle. Slots run 0 (draft) .. N (OLDEST), and the
    // wrap is symmetric: `↑` from the oldest reaches the draft, so `↓` from the
    // draft reaches the OLDEST — which is the far end of the cycle, not the newest
    // frame. That asymmetry is easy to assume wrong, so it is pinned explicitly.
    const { root } = mountPair()
    pressAndSettle('Escape')
    pressAndSettle('ArrowDown')
    expect(roamBar()?.textContent).toContain('first question')
    root.unmount()
  })

  it('stops the quick chord at the oldest frame instead of wrapping (A-21)', () => {
    // This spec USED to assert the opposite, and the inversion is the requirement:
    // A-17 gave both features the cycle, A-21 took it away from the chord alone
    // ("Ctrl up 和 down 去掉 首尾循环"). The roaming walk keeps it — see the sibling
    // spec below, which is what proves the two features really did split.
    const written: string[] = []
    const { root } = mountPair({ draft: 'my own words', setDraft: text => { written.push(text) } })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    // draft -> newest -> oldest, and then it STAYS on the oldest: no third write, so
    // the user's own draft is not handed back by a wrap they did not ask for.
    expect(written).toEqual(['second question', 'first question'])
    root.unmount()
  })

  it('still wraps the roaming walk, which is where A-17 keeps holding', () => {
    // The other half of the A-21 split. If this ever fails together with the spec
    // above, the two features have been collapsed back into one and the user's
    // "两个功能都是独立的快捷键" principle is broken again.
    const { root } = mountPair({})
    pressAndSettle('Escape')
    for (let step = 0; step < 4; step += 1) pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('first question')
    // Why the READOUT is the only place the chord's clamp can be announced: the bar
    // renders only while the roaming phase is on. From the composer there is nowhere
    // to say it, and entering roaming to say it would leave the user in a walk they
    // never opened — measured, not assumed (doing that leaked the phase into three
    // unrelated specs). So the clamp speaks to a user who IS roaming: below, one more
    // press at the oldest frame wraps round to the draft slot.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('does not wrap a paged move inside one gesture', () => {
    // PageUp walks five slots at once. A wrap per sub-step would make a single
    // PageUp on a three-frame session land nowhere in particular, so the paged move
    // is CLAMPED: it stops at the oldest frame it can reach.
    const table: Record<string, unknown> = { u1: userNode('one', 1), u2: userNode('two', 2) }
    const { root } = mountPair({ table })
    pressAndSettle('Escape')
    pressAndSettle('PageUp')
    expect(roamBar()?.textContent).toContain('one')
    // ...and the walk is still on a real frame, not wrapped past it.
    expect(roamBar()?.textContent).not.toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('appends instead of replacing when that mode is configured', () => {
    const written: string[] = []
    const { root } = mountPair({
      draft: 'keep me',
      historyJumpReuseMode: 'append',
      setDraft: text => { written.push(text) },
    })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['keep me\nsecond question'])
    root.unmount()
  })

  it('leaves the palette chord alone so the palette can open', () => {
    // Both overlays listen in capture phase at the document: if this one
    // consumed the chord, the palette's own listener would never see it.
    const { root } = mountPair()
    const event = new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    flushSync(() => {})
    expect(event.defaultPrevented).toBe(false)
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('leaves the palette chord alone while roaming too', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    const event = new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    flushSync(() => {})
    expect(event.defaultPrevented).toBe(false)
    // The walk is undisturbed.
    expect(roamBar()).not.toBeNull()
    root.unmount()
  })

  it('folds the walk to one frame per turn in turn mode', () => {
    const { root } = mountPair({ historyJumpFrames: 'turn' })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('second question')
    // One more step exhausts the folded list.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('first question')
    root.unmount()
  })

  it('positions the readout with the frame count', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    // Four messages in this session: two questions and the two replies they got.
    expect(roamBar()?.textContent).toContain('/ 4')
    root.unmount()
  })

  it('walks a session with no history without crashing', () => {
    const { root } = mountPair({ table: {} })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('Home')
    // Nothing to walk to. A-16 replaced the old "第 0 / 0 条 当前草稿" reading — which
    // looked like a working walk parked on the draft — with an explicit sentence, so
    // the assertion is on THAT rather than on the draft label.
    expect(roamBar()?.textContent).toContain(zh['history.empty'])
    root.unmount()
  })

  it('paints the frame highlight on a row the build exposes', () => {
    // The row attribute belongs to the chat package; this only asserts that a
    // present row is marked and an absent one degrades silently.
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'a2')
    document.body.appendChild(row)
    const { root } = mountPair()
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(row.hasAttribute('data-atlas-frame-hit')).toBe(true)
    // Stepping back to the previous message moves the highlight off that row.
    pressAndSettle('ArrowDown')
    expect(row.hasAttribute('data-atlas-frame-hit')).toBe(false)
    root.unmount()
    row.remove()
  })

  it('marks a steering frame as an interjection', () => {
    const { root } = mountPair({
      table: { u1: userNode('a question', 1), s1: userNode('an interjection', 1, 'steering') },
    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('an interjection')
    root.unmount()
  })

  it('clears the roaming attributes when it unmounts', () => {
    const { root } = mountPair()
    pressAndSettle('Escape')
    expect(document.documentElement.hasAttribute('data-atlas-roaming')).toBe(true)
    flushSync(() => { root.unmount() })
    expect(document.documentElement.hasAttribute('data-atlas-roaming')).toBe(false)
  })

  it('gives the composer focus back when the walk is left', () => {
    // A-01/A-03: the point of Escape is to hand focus to the chat area, so
    // leaving must put it back in the composer — pressing Escape and then being
    // unable to type would make the gesture a trap. The composer is a Lexical
    // contenteditable inside the composer card, which is the only markup this
    // feature reaches for.
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.tabIndex = 0
    card.appendChild(editable)
    document.body.appendChild(card)

    const { root } = mountPair()
    pressAndSettle('Escape')
    expect(document.activeElement).not.toBe(editable)
    pressAndSettle('Escape')
    expect(document.activeElement).toBe(editable)

    root.unmount()
    card.remove()
  })

  it('draws the readout with the frame count', () => {
    // The readout is rendered by the DOCK half, from the store the overlay
    // publishes into. This is the seam that replaced a shared component: if the
    // two halves ever stop agreeing on the store, the strip goes blank — which is
    // what the previous three specs (measuring the composer card) used to guard.
    const { root } = mountPair()
    pressAndSettle('Escape')
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    expect(roamBar()?.textContent).toContain(t('history.position', { index: '1', total: '4' }))
    root.unmount()
  })

  it('renders the readout without measuring or styling the composer card', () => {
    // The strip used to be `position: fixed` and copy the card's rect into two CSS
    // custom properties, because a fixed element has no ancestor to take a width
    // from. It now sits INSIDE the composer's dock, which already has that width,
    // so the measurement is gone — and with it any temptation to reintroduce the
    // z-index/offset class of bug the user hit. This asserts the absence directly:
    // a card with a deliberately hostile rect must not affect the readout at all.
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.getBoundingClientRect = () => ({ left: 511, width: 928, right: 1439, top: 0, bottom: 0, height: 0, x: 511, y: 0, toJSON: () => ({}) }) as DOMRect
    document.body.appendChild(card)

    const { root } = mountPair()
    pressAndSettle('Escape')
    expect(roamBar()).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--dsh-atlas-roam-left')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--dsh-atlas-roam-width')).toBe('')
    root.unmount()
    card.remove()
  })

  it('adds no dock row while the walk is inactive', () => {
    // The dock is a permanent part of the composer stack, so a readout that always
    // rendered a row would push `/goal` and `/todo` up for every user who never
    // presses Escape. It must contribute nothing until it has something to say.
    const { root } = mountPair()
    expect(roamBar()).toBeNull()
    pressAndSettle('Escape')
    expect(roamBar()).not.toBeNull()
    pressAndSettle('Escape')
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('renders nothing when no store was injected at all', () => {
    // An injected spec, or a host that never registered the overlay half, leaves the
    // readout with no store. It must render nothing rather than throw: the dock is a
    // permanent part of the composer stack, so a crash here would take the composer
    // with it for a feature the user never asked for.
    const { root } = mount(<FrameReadout {...({ t } as unknown as FrameReadoutProps)} />)
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('draws the edge marker only when the walk is parked at the loaded edge', () => {
    // `edge` is set by the overlay when it has been pushed against the oldest LOADED
    // frame; the strip is how the user learns the difference between "no more
    // history" and "no more history loaded". The readout therefore has to react to
    // that flag crossing the store, in both directions.
    const store = createRoamStore()
    const { root } = mount(
      <FrameReadout {...({ roam: store, t } as unknown as FrameReadoutProps)} />,
    )
    expect(roamBar()).toBeNull()

    act(() => { store.set({ roaming: true, count: '1 / 3', preview: 'first', edge: false, tag: '', offscreen: false }) })
    expect(roamBar()?.textContent).toContain('first')
    expect(roamBar()?.textContent).not.toContain(zh['history.edge'])

    act(() => { store.set({ roaming: true, count: '3 / 3', preview: 'first', edge: true, tag: '', offscreen: false }) })
    expect(roamBar()?.textContent).toContain(zh['history.edge'])

    act(() => { store.set({ roaming: false, count: '', preview: '', edge: false, tag: '', offscreen: false }) })
    expect(roamBar()).toBeNull()
    root.unmount()
  })

  it('notifies subscribers by value, and stops once unsubscribed', () => {
    // This store is the seam between the two halves, and the reason it exists rather
    // than `useState` is that the overlay publishes on EVERY render. If `set`
    // notified on identity alone, the readout would re-render for every streamed
    // token even though nothing it shows had changed. The unsubscribe half matters
    // for the same reason: a stale listener would keep a torn-down dock alive.
    const store = createRoamStore()
    let notified = 0
    const stop = store.subscribe(() => { notified += 1 })

    const hidden: RoamView = { roaming: false, count: '', preview: '', edge: false, tag: '', offscreen: false }
    store.set({ ...hidden })
    expect(notified).toBe(0)
    expect(store.getSnapshot()).toEqual(hidden)

    store.set({ roaming: true, count: '1 / 2', preview: 'hello', edge: false, tag: '', offscreen: false })
    expect(notified).toBe(1)
    expect(store.getSnapshot().preview).toBe('hello')

    // Same values again: a fresh object with equal fields must stay silent.
    store.set({ roaming: true, count: '1 / 2', preview: 'hello', edge: false, tag: '', offscreen: false })
    expect(notified).toBe(1)

    // Only the edge flag differs, which is a real change and must notify.
    store.set({ roaming: true, count: '1 / 2', preview: 'hello', edge: true, tag: '' })
    expect(notified).toBe(2)

    stop()
    store.set({ ...hidden })
    expect(notified).toBe(2)
  })

  it('dresses the readout in the framework dock-card recipe, not its own', () => {
    // The user's request: match the official `/goal` styling. jsdom does not APPLY
    // the injected stylesheet, so this cannot assert computed values; what it can do
    // is assert the STRUCTURE the recipe depends on — an outer spacer carrying the
    // dock inset and an inner surface carrying the card — which is the part that was
    // actually wrong. The two boxes are not cosmetic: the outer is sized from the
    // stack and the inner is capped to the card, so collapsing them into one box
    // (the earlier shape) is what let the strip overhang the composer.
    const { root } = mountPair()
    pressAndSettle('Escape')
    const bar = roamBar() as HTMLElement
    expect(bar.className).toBe('dsh_atlas_roamBar')
    const surface = bar.querySelector('.dsh_atlas_roamBarInner') as HTMLElement | null
    expect(surface).not.toBeNull()
    // The card's children, in the order the recipe lays them out.
    expect([...(surface as HTMLElement).children].map(child => child.className)).toEqual([
      'dsh_atlas_roamBarTag',
      'dsh_atlas_roamBarCount',
      'dsh_atlas_roamBarSep',
      'dsh_atlas_roamBarText',
    ])
    root.unmount()
  })

  it('coexists with the other docks instead of covering them', () => {
    // The user's requirement, stated as a test: the readout must be visible WITHOUT
    // displacing or hiding `/goal` and `/todo`. The guarantee is structural — all
    // three are entries of `conversation.input.dock`, whose container is a flex
    // column with a gap — so the readout has to be a NORMAL FLOW row. A
    // `position: fixed` strip (what this used to be) is the failure mode: it
    // renders outside the flow, so it neither pushes its siblings nor respects
    // them, and it covers whatever is behind it. Asserting `position` is therefore
    // the honest check: it is the one property whose absence makes coexistence
    // impossible, and it is exactly what regressing to an overlay would restore.
    const { root } = mountPair()
    pressAndSettle('Escape')
    const bar = roamBar()
    expect(bar).not.toBeNull()
    expect(getComputedStyle(bar as HTMLElement).position).not.toBe('fixed')
    expect(getComputedStyle(bar as HTMLElement).position).not.toBe('absolute')
    // The siblings are the dock's other occupants; the readout must not be inside a
    // stacking context of its own that could lift it over them.
    expect(getComputedStyle(bar as HTMLElement).zIndex === 'auto' || getComputedStyle(bar as HTMLElement).zIndex === '').toBe(true)
    root.unmount()
  })

  it('returns focus and the original text together when a frame is reused', () => {
    // A-04: Enter on a frame must leave BOTH the text and the caret in the
    // composer, which is what makes the gesture a "reuse" rather than a copy.
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.tabIndex = 0
    card.appendChild(editable)
    document.body.appendChild(card)

    let written: string | undefined
    const { root } = mountPair({ setDraft: text => { written = text } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('Enter')
    expect(written).toBe('answer two')
    expect(document.activeElement).toBe(editable)
    // Enter is a reuse, not a send: the walk ends and nothing else happens.
    expect(roamBar()).toBeNull()

    root.unmount()
    card.remove()
  })

  it('scopes the scroll to the frame row the build exposes', () => {
    // A row for the NEWEST frame: walking onto it must ask that row to scroll,
    // which is the one DOM write this feature performs.
    // jsdom keeps this suite's DOM across tests, so a row another spec leaked
    // under the same key would read as extra scrolls here.
    for (const stray of document.querySelectorAll('[data-chat-anchor-key="a2"]')) stray.remove()
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'a2')
    document.body.appendChild(row)
    let scrolled = 0
    row.scrollIntoView = () => { scrolled += 1 }
    const { root } = mountPair()
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(scrolled).toBe(1)
    root.unmount()
    // The scroll searches the whole document, and jsdom keeps this suite's DOM
    // across tests: a leftover row would make a later spec see an extra hit for
    // this key (`escapes the key with CSS.escape` observed exactly that).
    row.remove()
  })

  it('highlights without scrolling when the row is absent', () => {
    // The shipped build may not carry the anchor attribute at all; that is the
    // documented degraded path, not a failure.
    const { root } = mountPair()
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('answer two')
    expect(document.documentElement.getAttribute('data-atlas-frame-key')).toBe('a2')
    root.unmount()
  })

  it('leaves Escape alone while a turn is generating', () => {
    // B-03. A running turn owns Escape (the interrupt gesture), so the walk must
    // not enter on it. The quick chords stay live: Ctrl+Up reads history without
    // touching the composer, which is what a waiting user wants.
    const { root } = mountPair({ generating: true })
    pressAndSettle('Escape')
    expect(roamBar()).toBeNull()
    expect(document.documentElement.hasAttribute('data-atlas-roaming')).toBe(false)
    // The chord still walks, straight into the quick path.
    let written: string | undefined
    root.unmount()
    const second = mountPair({ generating: true, setDraft: text => { written = text } })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toBe('second question')
    second.root.unmount()
  })

  it('drops the walk when the session under it changes', () => {
    // B-06. The overlay is NOT keyed per session: the shell renders the composer
    // chain without a session key, so React reuses this very instance and the
    // slot/phase state would otherwise survive into the next conversation, where
    // slot N means a different message. The session standard prop is the signal:
    // a different `useChat` is a different session.
    const first = props()
    const { root } = mount(<PairMount {...(first as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()).not.toBeNull()

    // A different session: its own chat selection (new keys, new hook identity).
    const next = props({ table: { v1: userNode('other session message', 9) } })
    flushSync(() => { root.render(<PairMount {...next} />) })

    expect(roamBar()).toBeNull()
    expect(document.documentElement.hasAttribute('data-atlas-roaming')).toBe(false)
    root.unmount()
  })

  it('marks a row whose key needs escaping', () => {
    // The selector is built from the Chat node key, which is not guaranteed to
    // be a bare identifier.
    const key = 'u 2"x'
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', key)
    document.body.appendChild(row)
    const { root } = mountPair({ table: { [key]: userNode('odd key', 1) } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(row.hasAttribute('data-atlas-frame-hit')).toBe(true)
    root.unmount()
  })

  it('clamps the cursor when the history shrinks under it', () => {
    // A compaction or a session switch can shorten the list while the user is
    // roaming; the cursor must not be left pointing past the end. The clamp is a
    // passive effect that schedules its own `setSlot`, so a keypress is what
    // drives the committing render — the same route a real user takes.
    const table: Record<string, unknown> = {
      u1: userNode('one', 1),
      u2: userNode('two', 2),
      u3: userNode('three', 3),
    }
    // One session whose node set SHRINKS: the hook identity stays put, only the
    // table changes, which is how a compaction actually reaches the component.
    const session = sessionStub(table)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => { root.render(<PairMount {...props({ table, useChat: session.useChat })} />) })
    pressAndSettle('Escape')
    // `Home` is a boundary JUMP, so it lands on the oldest frame without stepping
    // — which matters now that a repeated `↑` would wrap (A-17) and leave the
    // cursor somewhere this spec did not intend.
    pressAndSettle('Home')
    expect(container.textContent).toContain('one')
    // Re-render with a one-frame history. The clamp is what pulls the cursor back
    // from slot 3, and it is a passive effect that schedules its own `setSlot`, so
    // it settles on the render this re-render triggers — the same route a real user
    // takes, since the shrink itself arrives mid-walk.
    session.set({ u1: userNode('one', 1) })
    flushSync(() => { root.render(<PairMount {...props({ table, useChat: session.useChat })} />) })
    // A keypress drives the committing render the passive clamp scheduled.
    pressAndSettle('ArrowDown')
    pressAndSettle('ArrowUp')
    expect(container.textContent).toContain('one')
    // The clamp already pulled the slot in line with the shorter walk, so the
    // position reads the single remaining frame rather than a stale slot past the
    // end.
    expect(container.textContent).toContain(t('history.position', { index: '1', total: '1' }))
    root.unmount()
  })

  it('shows the draft slot readout when the highlighted frame vanishes', () => {
    const table: Record<string, unknown> = { u1: userNode('one', 1), u2: userNode('two', 2) }
    // Same session, one frame removed — not a session switch.
    const session = sessionStub(table)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => { root.render(<PairMount {...props({ table, useChat: session.useChat })} />) })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('one')
    // The oldest frame disappears; the cursor falls back to the draft slot
    // rather than rendering an empty readout.
    session.set({ u2: userNode('two', 2) })
    flushSync(() => { root.render(<PairMount {...props({ table, useChat: session.useChat })} />) })
    expect(roamBar()?.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('adds no second newline when the draft already ends with one', () => {
    const written: string[] = []
    const { root } = mountPair({
      draft: 'keep me\n',
      historyJumpReuseMode: 'append',
      setDraft: text => { written.push(text) },
    })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['keep me\nsecond question'])
    root.unmount()
  })

  it('does not append when the draft is blank', () => {
    const written: string[] = []
    const { root } = mountPair({
      draft: '   ',
      historyJumpReuseMode: 'append',
      setDraft: text => { written.push(text) },
    })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question'])
    root.unmount()
  })

  it('leaves the cursor alone when the history does not shrink', () => {
    // The clamp compares against the length, so an unchanged length must not move
    // the cursor: growing or steady history keeps whatever slot the user chose.
    const table: Record<string, unknown> = { u1: userNode('one', 1), u2: userNode('two', 2) }
    // Same session throughout: only the node set changes.
    const session = sessionStub(table)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => { root.render(<PairMount {...props({ table, useChat: session.useChat })} />) })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(container.textContent).toContain(t('history.position', { index: '2', total: '2' }))
    // Same length, different content: the cursor stays where it is.
    session.set({ u1: userNode('one', 1), u3: userNode('three', 3) })
    flushSync(() => { root.render(<PairMount {...props({ table, useChat: session.useChat })} />) })
    pressAndSettle('Home')
    expect(container.textContent).toContain(t('history.position', { index: '2', total: '2' }))
    root.unmount()
  })

  it('paints no highlight key when the slot has no frame left', () => {
    // A slot can be in range while its frame is gone (a node dropped mid-walk);
    // the readout then falls back to the draft wording instead of an empty tag.
    const session = sessionStub(DEFAULT_TABLE)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => { root.render(<PairMount {...props({ useChat: session.useChat })} />) })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(document.documentElement.getAttribute('data-atlas-frame-key')).toBe('a2')
    // Drop the newest frame so slot 1 has nothing behind it, and press Home to
    // land on the oldest surviving slot without changing the frame count.
    session.set({ u1: userNode('first question', 1), a1: assistantNode('answer one', 1) })
    flushSync(() => { root.render(<PairMount {...props({ useChat: session.useChat })} />) })
    pressAndSettle('End')
    expect(document.documentElement.hasAttribute('data-atlas-frame-key')).toBe(false)
    expect(container.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('does not rebuild the walk for a re-render that changed nothing', () => {
    // A guard against a future change that makes the walk depend on something
    // unstable: a fresh array or map identity per render would silently re-walk
    // the whole session on every keystroke and every streamed token.
    //
    // NOTE: this pins CURRENT behaviour, it is not a fix. `useMemo` on
    // [order, nodes, mode] already provides it, and it does NOT explain the
    // reported first-press stall — `buildFrames` was measured and exonerated
    // (first press 18ms in the browser lane; the walk is 10.1ms only at 2000 turns).
    const table = DEFAULT_TABLE
    const order = Object.keys(table)
    const nodes = countingNodes(table)
    const useChat = (<T,>(selector: (value: unknown) => T): T => {
      return selector({ order, nodes, partial: null })
    }) as FrameCursorProps['useChat']
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => { root.render(<PairMount {...props({ useChat })} />) })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(document.documentElement.getAttribute('data-atlas-frame-key')).toBe('a2')

    // Re-render with the SAME identities several times. `buildFrames` reads the
    // node map through `get`, so the count is the walk count. The walk ran for the
    // mounted session, so the equality below is not vacuously true.
    const before = walkCount()
    expect(before).toBeGreaterThan(0)
    for (let update = 0; update < 4; update += 1) {
      flushSync(() => { root.render(<PairMount {...props({ useChat })} />) })
    }
    expect(walkCount()).toBe(before)
    root.unmount()
  })

  it('writes the original text back verbatim, code fences and refs included', () => {
    // A-07. The preview collapses whitespace, so the risk is that the COLLAPSED
    // text is what gets reused. Reuse must write the frame's original text.
    const original = '看这段：\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n还有 @src/index.ts 和 🎯 emoji\n第二行'
    const table: Record<string, unknown> = { u1: userNode(original, 1) }
    let written: string | undefined
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => {
      root.render(<PairMount {...props({ table, setDraft: (v: string) => { written = v } })} />)
    })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    // The row shows the collapsed preview...
    expect(roamBar()?.textContent).not.toContain('\n')
    pressAndSettle('Enter')
    // ...but the draft gets every byte back.
    expect(written).toBe(original)
    root.unmount()
  })

  it('pages history back when the walk runs off the oldest loaded frame', () => {
    // A-05. The window, not the session, ran out: asking for an older frame at
    // the oldest loaded one must request the page for THAT frame's seq.
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const asked: number[] = []
    const { root, container } = mount(<PairMount {...(props({ table, loadThrough: (seq: number) => { asked.push(seq); return Promise.resolve() } }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp') // newest
    pressAndSettle('ArrowUp') // oldest
    expect(container.textContent).toContain('first question')
    expect(asked).toEqual([])
    // Now a further step back: still the oldest, so this is the boundary. A-12
    // takes priority over A-17's wrap, so this press PAGES rather than wrapping.
    pressAndSettle('ArrowUp')
    expect(asked).toEqual([1])
    // The page brought nothing (the loader never grows the walk), so the edge is
    // now confirmed and the NEXT press wraps instead of asking the same question
    // again. Asking twice was the old behaviour; with a wrap available it would
    // mean the wrap could never be reached while a loader exists.
    pressAndSettle('ArrowUp')
    expect(asked).toEqual([1])
    expect(container.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('pages from the quick chord too, and stays put until the frames arrive', () => {
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const asked: number[] = []
    let written: string | undefined
    const { root, container } = mount(<PairMount {...(props({
          table,
          setDraft: (v: string) => { written = v },
          loadThrough: (seq: number) => { asked.push(seq); return Promise.resolve() },
        }) as unknown as Record<string, unknown>)} />)
    // Ctrl+Up twice reaches the oldest frame and writes it; the third is the boundary.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toBe('first question')
    expect(asked).toEqual([])
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(asked).toEqual([1])
    // The cursor did not move and nothing new was written: a slow page must not
    // strand the cursor or double-write.
    expect(written).toBe('first question')
    expect(container.textContent).toBe('')
    root.unmount()
  })

  it('does not re-write on every extra quick-chord press at the oldest frame', () => {
    // The degraded quick chord (no loader): pressing Ctrl+Up past the top must not
    // re-reuse the same frame on every further press — in append mode each extra
    // press would otherwise append the same text again, which is the bug this spec
    // exists for.
    //
    // A-17 puts a WRAP on the far side of that edge, so the press after the oldest
    // frame lands on the DRAFT slot. Nothing is reused there: the walk hands the
    // composer its own (empty) draft back. The "no duplicate" rule is therefore
    // asserted on the REUSED frames, which are the only writes a repeated press
    // could ever duplicate.
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const writes: string[] = []
    const { root } = mount(<PairMount {...(props({
          table,
          historyJumpReuseMode: 'append',
          setDraft: (v: string) => { writes.push(v) },
        }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(writes).toEqual(['second question', 'first question'])
    // A-21: there is no wrap for the chord, so the press after the oldest frame is
    // pressed against the edge and stays there. Two more presses still write
    // NOTHING — which is the "no duplicate" rule this spec is really about, now
    // asserted head-on instead of via the wrap's side effect.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(writes).toEqual(['second question', 'first question'])
    root.unmount()
  })

  it('keeps the highlight on the oldest frame when roaming past the top', () => {
    // The roaming counterpart of the no-op rule: an edge step must leave the
    // highlight where it was rather than blanking it or drifting. The readout
    // gains the A-05 edge notice, so the comparison is on the FRAME and the
    // POSITION rather than on the whole string.
    //
    // A-17 changed what happens BEYOND the edge: a second press wraps to the draft.
    // This spec pins the FIRST press at the edge, which — with a loader present — is
    // the paging attempt and must leave the cursor exactly where it was. A loader is
    // therefore required here: without one the very first edge press would wrap, and
    // the spec would be asserting the wrap while claiming to test the no-op.
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const { root } = mount(<PairMount {...(props({ table, loadThrough: () => Promise.resolve() }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    const atOldest = roamBar()?.textContent ?? ''
    expect(atOldest).toContain('first question')
    // `index = frameCount - highlighted`, so the OLDEST frame reads "2 / 2".
    expect(atOldest).toContain('2 / 2')
    // One press at the edge: the paging attempt, which does not move the cursor.
    pressAndSettle('ArrowUp')
    const stillThere = roamBar()?.textContent ?? ''
    expect(stillThere).toContain('first question')
    expect(stillThere).toContain('2 / 2')
    root.unmount()
  })

  it('says so when the walk is parked at the oldest loaded frame', async () => {
    // A-05/§5.4: stopping silently reads as "this is the start of the session",
    // when it may only be the start of what has been paged in. With a loader
    // available the edge press is the one that has more behind it, so it is the
    // one that must explain itself — and moving away must take the notice down.
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const { root } = mount(<PairMount {...(props({ table, loadThrough: () => Promise.resolve() }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).not.toContain(zh['history.edge'])
    // The edge press asks the loader and explains itself. WHICH press that is depends
    // on the `pageTriedRef` contract (A-17): one visit spends exactly ONE press on
    // paging, and only a following press at the same frame wraps. Arriving at the
    // oldest frame is not itself that press, so pressing until the notice appears is
    // the assertion's real meaning — and it stops the spec from depending on whether
    // an earlier press in this sequence happened to be the one spent paging, which is
    // what made it order-sensitive under a busy suite.
    for (let press = 0; press < 3; press += 1) {
      if ((roamBar()?.textContent ?? '').includes(zh['history.edge'])) break
      pressAndSettle('ArrowUp')
      // Wait for the notice to APPEAR rather than for one microtask: a single
      // `await Promise.resolve()` was enough when this file ran alone but not when the
      // full suite had every worker busy, and the spec failed intermittently with the
      // readout still on the frame. Polling the condition is what the assertion
      // actually means, so it cannot go stale under load.
      //
      // The wait must cross a MACROTASK, not just microtasks. The loader's promise
      // settles on the microtask queue, but the component's `.then` that records the
      // page runs after React has committed that render — and under `--coverage` the
      // instrumentation makes that commit itself asynchronous. A microtask-only spin
      // therefore returns before the page is recorded, which is how this spec failed
      // ONLY in the coverage run while passing alone. `setTimeout(0)` yields past both
      // queues, and the loop still exits the moment the notice is there.
      await act(async () => {
        for (let tick = 0; tick < 20 && !(roamBar()?.textContent ?? '').includes(zh['history.edge']); tick += 1) {
          await new Promise(resolve => { setTimeout(resolve, 0) })
        }
      })
    }
    expect(roamBar()?.textContent).toContain(zh['history.edge'])
    // Moving back down clears it again.
    pressAndSettle('ArrowDown')
    expect(roamBar()?.textContent).not.toContain(zh['history.edge'])
    root.unmount()
  })

  it('stops at the oldest loaded frame when the client has no jump loader', () => {
    // The documented degradation (§5.4): no `loadThrough` on older builds means
    // the walk ends at the oldest loaded frame instead of failing.
    //
    // A-17 makes that "end" a WRAP rather than a clamp, and this spec is the one
    // that separates the two: with no loader there is nothing to page, so the very
    // first press at the oldest frame goes straight to the wrap — the draft — and
    // never claims an unloaded edge it cannot fetch.
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const { root, container } = mountPair({ table })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(container.textContent).toContain('first question')
    pressAndSettle('ArrowUp')
    expect(container.textContent).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('pages on Home to the oldest, and does not page when there is no history', () => {
    const table: Record<string, unknown> = { u1: userNode('first question', 1) }
    const asked: number[] = []
    const { root } = mount(<PairMount {...(props({ table, loadThrough: (seq: number) => { asked.push(seq); return Promise.resolve() } }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(asked).toEqual([])
    // Home already lands on the oldest loaded frame; it must not pre-emptively page.
    pressAndSettle('Home')
    expect(asked).toEqual([])
    root.unmount()
  })

  it('swallows a rejected page instead of surfacing an unhandled rejection', async () => {
    const table: Record<string, unknown> = { u1: userNode('first question', 1) }
    let rejected = false
    const { root } = mount(<PairMount {...(props({
          table,
          loadThrough: () => { rejected = true; return Promise.reject(new Error('pager busy')) },
        }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(rejected).toBe(true)
    // Let the rejection settle: an unhandled one would fail this spec.
    await Promise.resolve()
    await Promise.resolve()
    root.unmount()
  })

  it('continues the walk into a page that actually arrives, and keeps counting', async () => {
    // The user's report: with a REAL multi-page session, pressing up at the oldest
    // loaded frame did nothing — they had to click the ruler to page by hand. The
    // spec above never caught it because it models a page that reveals NOTHING (the
    // loader resolves without re-rendering the props), so only the "genuine edge"
    // arm was ever exercised; the "page prepended frames, continue into them" arm
    // had no test at all. This is that test: the loader re-renders with an OLDER
    // window, exactly as the session face does when `loadThrough` resolves.
    // One SESSION whose node set grows, which is exactly what `loadThrough` does:
    // the hook identity stays fixed (it is the same session) and only the node set
    // changes. Swapping the table instead would read as a session switch and the
    // walk would be rebuilt rather than continued.
    const session = sessionStub({ u2: userNode('second question', 2) })
    const asked: number[] = []
    const built = props({ useChat: session.useChat })
    built.loadThrough = (seq: number) => {
      asked.push(seq)
      // The older window arrives: the page REPLACES the frame list with one that
      // reaches further back, so the pre-page oldest frame is no longer the oldest.
      session.set({ u1: userNode('first question', 1), u2: userNode('second question', 2) })
      return Promise.resolve()
    }
    const { root, container } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    // Parked on the oldest loaded frame (`second question`), 1 of 1.
    expect(roamBar()?.textContent).toContain('1 / 1')
    // The press that used to do nothing: it asks for the oldest frame's seq...
    pressAndSettle('ArrowUp')
    await act(async () => { await Promise.resolve() })
    expect(asked).toEqual([2])
    // ...and the page is now in the session, so the walk must land on the frame it
    // revealed rather than staying where it was.
    await act(async () => { await Promise.resolve() })
    // Two frames now exist, the cursor sits on the oldest one, and the readout says
    // so — the total grew AND the index followed it, which is the user's "更新消息
    // 总数及当前消息序号" applied to the paging path.
    expect(roamBar()?.textContent).toContain('2 / 2')
    expect(roamBar()?.textContent).toContain('first question')
    // And it is NOT reported as an edge, because it was not one.
    expect(roamBar()?.textContent).not.toContain(zh['history.edge'])
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('counts the turns the loaded window does not hold, so the walk is not empty', async () => {
    // The user's report: the page's own turn ruler drew a dozen marks while the
    // readout said "0 / 0", and Ctrl+Up could not summon anything. Both are one
    // bug. The ruler is fed by the session-wide `turnOutline` projection, which
    // folds the WHOLE log, whereas this walk only read the Chat snapshot — the
    // PAGED window. A session opened at a jump target (or simply long enough that
    // the client has not paged its head in) holds no `user` node at all, so the
    // frame list came out empty and there was nothing to step through.
    // A window with NO user node, and an outline naming three turns: the shape the
    // user was looking at.
    const { root, container } = mount(<PairMount {...(props({
      table: { a3: assistantNode('answer three', 3) },
      outline: [
        { turn: 1, seq: 11, prompt: 'oldest question', response: 'answer one' },
        { turn: 2, seq: 22, prompt: 'middle question', response: 'answer two' },
        { turn: 3, seq: 33, prompt: 'newest question', response: 'answer three' },
      ],
    }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    // The total is the outline's, not the window's.
    expect(roamBar()?.textContent).toContain('0 / 3')
    // The newest stop is turn 3's ANSWER: the window holds no prompt for that
    // turn, so it is a system turn and the answer is its only trace on the walk —
    // the reported gap ("第 9-13 条都是系统发起的，但都没随 up/down 切换").
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('1 / 3')
    expect(roamBar()?.textContent).toContain('answer three')
    expect(roamBar()?.textContent).toContain(zh['history.systemTag'])
    // Behind it are the outline's turns, all the way to the oldest one, without
    // anything having been loaded.
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('2 / 3')
    expect(roamBar()?.textContent).toContain('middle question')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('3 / 3')
    expect(roamBar()?.textContent).toContain('oldest question')
    // Nothing was asked of the loader: these frames need no page to be walked.
    // A frame whose row the window does not hold simply has no row to scroll to,
    // which is the walk's existing "highlight without scrolling" degradation.
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('keeps the loaded window authoritative for a turn the outline also names', async () => {
    // The outline and the window overlap for every turn the client HAS paged in.
    // A turn must not appear twice, and its frame must be the loaded one — the
    // outline only carries a bounded preview, so preferring it would silently
    // downgrade a reuse from the original text to a truncated one.
    const { root, container } = mount(<PairMount {...(props({
      table: { u2: userNode('second question', 2) },
      outline: [
        { turn: 1, seq: 11, prompt: 'oldest question', response: 'answer one' },
        { turn: 2, seq: 22, prompt: 'second quest', response: 'answer two' },
      ],
    }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    // Turn 2 is held, turn 1 is not: two frames, not three.
    expect(roamBar()?.textContent).toContain('0 / 2')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('1 / 2')
    // The LOADED text, spelled in full — the outline's `second quest` is its own
    // truncated preview and must not be what a reuse receives.
    expect(roamBar()?.textContent).toContain('second question')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('2 / 2')
    expect(roamBar()?.textContent).toContain('oldest question')
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('drops a malformed outline entry rather than counting a frame it cannot page', async () => {
    // The outline is projection data off the wire, so it is narrowed rather than
    // trusted. `seq` is what pages a turn in and `turn` is what identifies it, so
    // an entry missing either cannot be walked and is dropped; a damaged preview
    // is decorative and degrades to an empty one.
    const { root, container } = mount(<PairMount {...(props({
      table: {},
      outline: [
        { turn: 1, seq: 11, prompt: 'kept', response: 'kept answer' },
        { turn: 'nope', seq: 22, prompt: 'bad turn', response: '' },
        { turn: 2, prompt: 'no seq', response: '' },
        { turn: 3, seq: -1, prompt: 'negative seq', response: '' },
        { turn: 4, seq: Number.NaN, prompt: 'nan seq', response: '' },
        { turn: 5, seq: 55, prompt: 7, response: null },
      ],
    }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    // Kept: turn 1 (complete) and turn 5 (a damaged preview is still a walkable
    // turn — it degrades to an empty preview, not to a missing frame).
    expect(roamBar()?.textContent).toContain('0 / 2')
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('treats a non-array outline as no outline at all', async () => {
    // The projection can be absent (no baseline frame carried the key yet), and
    // "absent" must degrade to the window-only walk rather than to a crash.
    const { root, container } = mount(<PairMount {...(props({
      table: { u1: userNode('first question', 1) },
      outline: undefined,
    }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    expect(roamBar()?.textContent).toContain('0 / 1')
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('lets the quick chord summon a message the window has not loaded', async () => {
    // The user's second report, verbatim: "ctrl up 也无法调出 历史消息". Same root
    // cause as the empty count — the chord reads the same frame list, so an empty
    // walk meant the chord had nothing to write. This pins the chord against the
    // outline-only shape: from the composer, with no Escape, Ctrl+Up must put the
    // newest outlined turn's text into the draft.
    const written: string[] = []
    const { root, container } = mount(<PairMount {...(props({
      table: { a3: assistantNode('answer three', 3) },
      outline: [
        { turn: 1, seq: 11, prompt: 'oldest question', response: 'answer one' },
        { turn: 2, seq: 22, prompt: 'newest question', response: 'answer two' },
      ],
      setDraft: (text: string) => { written.push(text) },
    }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['newest question'])
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['newest question', 'oldest question'])
    // Coming back down returns the user's own draft, unchanged behaviour.
    pressAndSettle('ArrowDown', { ctrlKey: true })
    pressAndSettle('ArrowDown', { ctrlKey: true })
    expect(written.at(-1)).toBe('')
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('pages a turn in before reusing it, so a preview never becomes the draft', async () => {
    // The outline ships a BOUNDED preview (50 chars then an ellipsis), so reusing an
    // unloaded frame's `text` would hand the user a truncated message. Enter on such a
    // frame must therefore take the page first and reuse the LOADED text.
    const session = sessionStub({ a3: assistantNode('answer three', 3) })
    const asked: number[] = []
    const written: string[] = []
    const built = props({
      useChat: session.useChat,
      outline: [{ turn: 2, seq: 22, prompt: 'truncated previ…', response: '' }],
      setDraft: (text: string) => { written.push(text) },
    })
    built.loadThrough = (seq: number) => {
      asked.push(seq)
      // The page brings the REAL message in, spelled in full.
      session.set({ u2: userNode('the whole second question', 2), a3: assistantNode('answer three', 3) })
      return Promise.resolve()
    }
    const { root, container } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    // Turn 3's answer (a system turn's frame) is the newest stop; the turn this
    // spec is about is the one behind it.
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('2 / 2')
    // Enter on the unloaded frame: the page is asked for BEFORE anything is written,
    // and what finally reaches the composer is the LOADED text — never the outline's
    // truncated preview. (`pressAndSettle` flushes the settle effect, so both halves
    // are observable from here; `asked` ordering is what proves the page came first.)
    pressAndSettle('Enter')
    expect(asked).toEqual([22])
    expect(written).toEqual(['the whole second question'])
    expect(written).not.toContain('truncated previ…')
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('reuses a loaded frame immediately, without asking for a page', async () => {
    // The other arm: an ordinary loaded frame must not pay a round trip. This is the
    // half that a spec exercising only the unloaded arm would leave unproven.
    const asked: number[] = []
    const written: string[] = []
    const built = props({
      table: { u1: userNode('first question', 1) },
      setDraft: (text: string) => { written.push(text) },
    })
    built.loadThrough = (seq: number) => { asked.push(seq); return Promise.resolve() }
    const { root, container } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('Enter')
    expect(written).toEqual(['first question'])
    expect(asked).toEqual([])
    expect(container).not.toBeNull()
    root.unmount()
  })


  it('defers the chord onto an outline frame, then writes the loaded text (A-13 + A-26)', async () => {
    // The arm A-26 made reachable: the CHORD reuses straight from the walk without
    // the roam step's paging, so it is the gesture that lands on an outline-only
    // frame. Before this, `Ctrl+Up` onto such a frame called `reuse` unconditionally
    // and wrote the outline's bounded PREVIEW — a truncated message in the composer.
    // A-13's guard now covers the chord too, so the press DEFERS and the real text is
    // what finally lands.
    const asked: number[] = []
    const written: string[] = []
    const session = sessionStub({ a9: assistantNode('answer nine', 9) })
    const built = props({
      useChat: session.useChat,
      // Turn 2 is outline-only: the window below does not hold it, so its frame is
      // unloaded and its `prompt` is the projection's truncated preview.
      outline: [{ turn: 2, seq: 22, prompt: 'truncated previ…', response: '' }],
      setDraft: (text: string) => { written.push(text) },
    })
    built.loadThrough = (seq: number) => {
      asked.push(seq)
      // The page brings the REAL message in, spelled in full.
      session.set({ u2: userNode('the whole second question', 2), a9: assistantNode('answer nine', 9) })
      return Promise.resolve()
    }
    const { root, container } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    // Slot 1 is the OLDEST frame and the chord reads the DESTINATION slot, so the
    // first press lands on the outline-only turn 2 and must DEFER rather than write
    // its truncated preview.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(asked).toEqual([22])
    expect(written).not.toContain('truncated previ…')
    // Let the settlement run against the page that has now landed. The yield goes
    // past the MACROTASK queue: a microtask-only wait can miss work that runs after
    // a React commit, which is the trap that made this kind of assertion fail only
    // under the coverage run.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(written).toContain('the whole second question')
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('keeps a chord-deferred walk — and the draft it stashed — alive, where Enter commits (A-13 + A-26)', async () => {
    // The two gestures that can land on an outline-only frame both defer the write
    // until the page lands, and neither of them means the same thing afterwards. The
    // chord is MID-WALK: its press must not end the walk that is still in progress,
    // and the draft the page overwrites has to stay recoverable. Enter is a
    // COMMITMENT: its destination is the frame, so once the real text is in, the walk
    // is over and the pre-walk draft is spent rather than stashed.
    //
    // The browser lane is where this was measured. The settlement used to run Enter's
    // tail for BOTH gestures, so a chord press that had to page cleared `ownDraftRef`,
    // closed the walk and put the chord back on the draft slot; the press AFTER the
    // page then wrote the newest turn a second time instead of continuing the walk
    // (measured in B-10 on the 40-turn fixture).
    //
    // What has to survive the page here is the stashed draft, which only a settling
    // gesture that is not a commitment may keep. The other half of that same browser
    // bug — the chord's own cursor being reset because the frame list changed under it
    // — is locked by B-10 rather than here: reproducing it needs the outline's
    // attribution quirk in a real multi-page session (a turn counted twice until the
    // page reveals the message itself), which a stub projection cannot honestly do.
    const asked: number[] = []
    const written: string[] = []
    const session = sessionStub({ a9: assistantNode('answer nine', 9) })
    const built = props({
      useChat: session.useChat,
      draft: 'my own words',
      // Turn 2 is outline-only: the window below does not hold it, so its frame is
      // unloaded and its `prompt` is the projection's truncated preview.
      outline: [{ turn: 2, seq: 22, prompt: 'truncated previ…', response: '' }],
      setDraft: (text: string) => { written.push(text) },
    })
    built.loadThrough = (seq: number) => {
      asked.push(seq)
      // The page brings the REAL message in, spelled in full.
      session.set({ u2: userNode('the whole second question', 2), a9: assistantNode('answer nine', 9) })
      return Promise.resolve()
    }
    const { root } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(asked).toEqual([22])
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(written).toContain('the whole second question')
    // The walk is still open, and it still belongs to the CHORD (A-21): pre-fix this
    // bar was gone, because the settle closed the walk, and the cursor it described
    // had been reset to the draft slot by the frame count changing.
    expect(roamBar()).not.toBeNull()
    expect(roamBar()?.textContent).toContain('the whole second question')
    expect(roamBar()?.textContent).not.toContain(zh['history.draftSlot'])
    // And the draft the page overwrote is still stashed, so End hands it back.
    pressAndSettle('End')
    expect(written).toContain('my own words')
    root.unmount()

    // The SAME deferral through Enter, which is the commitment: the real text lands
    // and is kept, the walk ends, and the pre-walk draft is spent.
    const committed: string[] = []
    const askedAgain: number[] = []
    const enterSession = sessionStub({ a9: assistantNode('answer nine', 9) })
    const enterBuilt = props({
      useChat: enterSession.useChat,
      draft: 'my own words',
      outline: [{ turn: 2, seq: 22, prompt: 'truncated previ…', response: '' }],
      setDraft: (text: string) => { committed.push(text) },
    })
    enterBuilt.loadThrough = (seq: number) => {
      askedAgain.push(seq)
      enterSession.set({ u2: userNode('the whole second question', 2), a9: assistantNode('answer nine', 9) })
      return Promise.resolve()
    }
    const enter = mount(<PairMount {...(enterBuilt as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    // Home is a JUMP rather than a step, so it stops on the oldest frame without
    // paging — which is how Enter can be pressed ON an outline-only frame, the arm
    // that defers the commitment.
    pressAndSettle('Home')
    pressAndSettle('Enter')
    expect(askedAgain).toEqual([22])
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(committed).toContain('the whole second question')
    expect(roamBar()).toBeNull()
    // The commitment spent the stash: walking back to the draft must NOT resurrect
    // the words the user had in the composer before the walk.
    pressAndSettle('End')
    expect(committed).not.toContain('my own words')
    enter.root.unmount()
  })

  it('says so when the chord cannot page an outline frame in (A-13 + A-16)', async () => {
    // The failure half of the chord's deferral. A page that REJECTS must not leave the
    // reuse armed forever, and it must not be silent either: the readout names the end
    // of the walk, which is this plugin's standing rule for a gesture that could not do
    // what it was asked (A-16, "never a silent no-op").
    const written: string[] = []
    const built = props({
      // A window that does NOT hold turn 2, so the chord's only route to it is the
      // outline frame — which is unloaded, and is what makes this the deferral path.
      table: { a9: assistantNode('answer nine', 9) },
      outline: [{ turn: 2, seq: 22, prompt: 'truncated previ…', response: '' }],
      setDraft: (text: string) => { written.push(text) },
    })
    built.loadThrough = () => Promise.reject(new Error('offline'))
    const { root, container } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp', { ctrlKey: true })
    // The rejection settles on the macrotask queue, so the handler runs only after a
    // real yield — a microtask-only wait would leave the arm unexecuted.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    // The rejected page wrote nothing, and the truncated preview never reached the
    // composer in its place.
    expect(written).not.toContain('truncated previ…')
    expect(container).not.toBeNull()
    root.unmount()
  })
  it('gives up on a deferred reuse whose turn the page did not bring', async () => {
    // An honest failure: if the page could not produce the turn, the composer is left
    // ALONE rather than filled with the outline's truncated preview.
    const session = sessionStub({ a3: assistantNode('answer three', 3) })
    const written: string[] = []
    const built = props({
      useChat: session.useChat,
      outline: [{ turn: 2, seq: 22, prompt: 'truncated previ…', response: '' }],
      setDraft: (text: string) => { written.push(text) },
    })
    built.loadThrough = () => {
      // A page that reveals nothing for that turn.
      session.set({ a3: assistantNode('answer three', 3) })
      return Promise.resolve()
    }
    const { root, container } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    // Past the loaded turn 3 answer, onto the unloaded turn 2 frame.
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    pressAndSettle('Enter')
    await act(async () => { await Promise.resolve() })
    expect(written).toEqual([])
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('drops a deferred reuse whose frame disappeared before the page landed', async () => {
    // A compaction while the page is in flight: the turn is gone, so the request is
    // moot and must not be retried forever against a frame that no longer exists.
    const session = sessionStub({ a3: assistantNode('answer three', 3) })
    const written: string[] = []
    const built = props({
      useChat: session.useChat,
      outline: [
        { turn: 1, seq: 11, prompt: 'gone soon', response: '' },
        { turn: 2, seq: 22, prompt: 'stays', response: '' },
      ],
      setDraft: (text: string) => { written.push(text) },
    })
    built.loadThrough = () => {
      // The compaction: outline turn 1 is simply no longer in the frame list at all.
      session.set({ u2: userNode('stays loaded', 2) })
      return Promise.resolve()
    }
    const { root, container } = mount(<PairMount {...(built as unknown as Record<string, unknown>)} />)
    // Move onto the OLDEST outlined turn (turn 1) and press Enter.
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    pressAndSettle('Enter')
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    // Nothing is written, and the walk is still usable rather than wedged.
    expect(written).toEqual([])
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('records the seq it pages from and keeps a loaded page in the walk', async () => {
    // The user's third request: pressing up at the loaded edge must GO FURTHER, not
    // stop and explain. The paging branch asks the loader for the oldest frame's
    // seq, and when the page actually prepends frames the cursor moves onto them —
    // which is what keeps the readout's index in step with its total, since both
    // are derived from the same live frame list.
    const table: Record<string, unknown> = { u1: userNode('first question', 1) }
    const asked: number[] = []
    const { root, container } = mount(<PairMount {...(props({
          table,
          loadThrough: (seq: number) => {
            asked.push(seq)
            // Model a page the way the session does: the loader REPLACES the
            // snapshot with an older window, so the props (and therefore the frame
            // list) are re-rendered before the promise settles.
            return Promise.resolve()
          },
        }) as unknown as Record<string, unknown>)} />)
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    // At the oldest frame: the next press asks the loader for that frame's seq.
    pressAndSettle('ArrowUp')
    // The edge verdict is reached in the effect that sees the grown (here: unchanged)
    // list, so the loader's settlement and that effect both have to run.
    await act(async () => { await Promise.resolve() })
    expect(asked).toEqual([1])
    // Nothing older arrived, so this is a real edge and says so rather than
    // pretending the walk continued.
    expect(roamBar()?.textContent).toContain(zh['history.edge'])
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('gives back a draft typed AFTER an earlier walk, not the earlier walk’s stash', () => {
    // The stash is only good while the composer still holds what this plugin last
    // wrote. Once the user types their own text over a reused message, THAT is the
    // draft a later walk must return. Measured live in the browser lane: without
    // the guard, Ctrl+Down restored a message from a previous walk
    // (`Create the relative path…`) because the stale stash was never replaced.
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const written: string[] = []
    // A draft the harness can mutate, standing in for the user typing.
    let live = 'typed before'
    const { root, container } = mount(<PairMount {...(props({ table, draft: live, setDraft: text => { written.push(text); live = text } }) as unknown as Record<string, unknown>)} />)
    // First walk: reuse a frame, stashing `typed before`.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question'])
    // The user now types over the reused message. Re-render the way the shell does
    // when the draft store changes — `useInput` is re-invoked with the new draft,
    // which is what lets the plugin tell the user's text from its own write.
    live = 'typed after'
    flushSync(() => {
      root.render(<PairMount {...props({ table, draft: live, setDraft: text => { written.push(text); live = text } })} />)
    })
    // Walk out and back: the draft that comes back is the one the user typed.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    pressAndSettle('ArrowDown', { ctrlKey: true })
    pressAndSettle('ArrowDown', { ctrlKey: true })
    expect(written[written.length - 1]).toBe('typed after')
    expect(container).not.toBeNull()
    root.unmount()
  })

  it('treats a missing session snapshot as idle rather than refusing every key', () => {
    // The harness types `useSession`'s selector as possibly answering nothing, and
    // an absent snapshot must mean "no turn is running" — the opposite default
    // would make Escape a no-op on any build whose session hook has not resolved,
    // i.e. the whole feature silently dead.
    const base = props() as unknown as Record<string, unknown>
    const { root } = mount(
      <PairMount {...base} useSession={(() => undefined) as unknown as FrameCursorProps['useSession']} />,
    )
    pressAndSettle('Escape')
    expect(roamBar()).not.toBeNull()
    root.unmount()
  })

  it('keeps the first stash across a walk that reuses several frames', () => {
    // Walking onto a second frame must NOT replace the stash with the first reused
    // message: only the draft the user actually had is theirs to get back. The
    // composer is made to echo the plugin's own writes here, because that is what
    // the real `setDraft` does — `lastWriteRef` is what tells the plugin's own text
    // apart from the user's, and a harness that never feeds it back cannot reach
    // the "this is still my write" branch at all.
    const table: Record<string, unknown> = { u1: userNode('first question', 1), u2: userNode('second question', 2) }
    const written: string[] = []
    let live = 'my own words'
    const echo = (text: string): void => { written.push(text); live = text }
    const { root } = mountPair({ table, draft: live, setDraft: echo })
    // Two reuses: the second must recognise the first one's text as its own write.
    pressAndSettle('ArrowUp', { ctrlKey: true })
    flushSync(() => {
      root.render(<PairMount {...props({ table, draft: live, setDraft: echo })} />)
    })
    pressAndSettle('ArrowUp', { ctrlKey: true })
    expect(written).toEqual(['second question', 'first question'])
    // Back to the draft: the user's own words, not the first reused message.
    flushSync(() => {
      root.render(<PairMount {...props({ table, draft: live, setDraft: echo })} />)
    })
    pressAndSettle('ArrowDown', { ctrlKey: true })
    flushSync(() => {
      root.render(<PairMount {...props({ table, draft: live, setDraft: echo })} />)
    })
    pressAndSettle('ArrowDown', { ctrlKey: true })
    expect(written[written.length - 1]).toBe('my own words')
    root.unmount()
  })

  it('does not write when the walk never overwrote the draft', () => {
    // `restoreOwnDraft` with no stash: the composer already holds the user's own
    // text, so writing would only move the caret for no reason. Roaming is the
    // path that reaches the draft slot without a stash — Escape then ArrowUp moves
    // the CURSOR and scrolls, it does not write a message — so `End` back to the
    // draft must leave the composer alone.
    const written: string[] = []
    const { root } = mountPair({ setDraft: text => { written.push(text) } })
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    expect(roamBar()).not.toBeNull()
    pressAndSettle('End')
    expect(written).toEqual([])
    root.unmount()
  })

  it('escapes the key with CSS.escape when the platform provides it', () => {
    // Browsers have `CSS.escape`; jsdom does not, so the fallback branch is the
    // one the other tests take. Defining it here covers the preferred path.
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'u2')
    document.body.appendChild(row)
    // The scroll searches the WHOLE document for the anchor, and jsdom keeps this
    // suite's DOM across tests, so the row is removed again or a later spec would
    // observe an extra hit for the same key.
    const escaped: string[] = []
    const previous = (globalThis as { CSS?: unknown }).CSS
    ;(globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => { escaped.push(value); return value } }
    try {
      const { root } = mountPair()
      pressAndSettle('Escape')
      pressAndSettle('ArrowUp')
      // ONE press scrolls ONCE. The count is asserted on the LAST entry rather
      // than the whole array: a stray anchor row left in the shared jsdom document
      // by any spec would otherwise add a call for a DIFFERENT key and read as a
      // double scroll, which is a test-order artefact rather than a second scroll.
      expect(escaped[escaped.length - 1]).toBe('a2')
      expect(escaped.filter(k => k === 'a2').length).toBeGreaterThanOrEqual(1)
      root.unmount()
    } finally {
      ;(globalThis as { CSS?: unknown }).CSS = previous
      row.remove()
    }
  })

  it('keeps one step per press when the shell re-injects its faces', () => {
    // The shell hands every session slot a FRESH `inputActions` object on each
    // render. The key listener is a capture listener on `document`, so an effect
    // that depends on that identity re-runs on every render, and a second
    // listener would handle the same keydown: one ArrowDown would then step
    // twice and skip a frame. This pins the single-step invariant across a
    // re-injection; the effect now deliberately depends on `enabled` alone.
    const table: Record<string, unknown> = {
      u1: userNode('first question', 1),
      u2: userNode('second question', 2),
      u3: userNode('third question', 3),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const paint = (): void => {
      flushSync(() => {
        root.render(<PairMount {...props({ table })} />)
      })
    }
    paint()
    pressAndSettle('Escape')
    pressAndSettle('ArrowUp')
    // Three up from the draft reaches the OLDEST frame: draft -> u3 -> u2 -> u1.
    pressAndSettle('ArrowUp')
    pressAndSettle('ArrowUp')
    expect(roamBar()?.textContent).toContain('first question')
    // Re-render with a brand-new face identity, exactly as the shell does.
    paint()
    pressAndSettle('ArrowDown')
    // ONE down must land on the next frame, not two frames along.
    expect(roamBar()?.textContent).toContain('second question')
    root.unmount()
    container.remove()
  })
})
