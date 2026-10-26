// @vitest-environment jsdom
/**
 * The F1 history palette: the chord opens it, the filter narrows it, the arrows
 * move the highlight, and Enter (or a click) puts the message back in the
 * composer. The frame index itself is covered in `history-frames.spec.ts`; this
 * spec is about the component's own behaviour and its key ownership.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import { HistoryPalette, matchesQuery, type HistoryPaletteProps } from '../src/client/HistoryPalette.tsx'
import type { HistoryFrame } from '../src/client/history-frames.ts'
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

/** One assistant step, in the Host's `blocks[]` shape. */
function assistantNode(text: string, turn: number): unknown {
  return { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text }] }, location: { kind: 'turn', turn: { turn } } }
}

/** A session snapshot holding the given nodes in order. */
function chatStub(table: Record<string, unknown>): HistoryPaletteProps['useChat'] {
  const order = Object.keys(table)
  const nodes = new Map(Object.entries(table))
  return (<T,>(selector: (snapshot: { order: readonly string[]; nodes: Map<string, unknown> }) => T): T =>
    selector({ order, nodes })) as HistoryPaletteProps['useChat']
}

/** Mount-ready props for the palette. */
function props(over: {
  table?: Record<string, unknown>
  draft?: string
  historyJump?: boolean
  historyJumpFrames?: 'message' | 'turn'
  historyJumpReuseMode?: 'replace' | 'append'
  setDraft?: (text: string) => void
} = {}): HistoryPaletteProps {
  const table = over.table ?? {
    u1: userNode('first question', 1),
    a1: assistantNode('answer one', 1),
    u2: userNode('second question', 2),
    a2: assistantNode('answer two', 2),
  }
  const stub = {
    session: {},
    scope: {
      getSnapshot: () => ({
        value: {
          historyJump: over.historyJump ?? true,
          historyJumpFrames: over.historyJumpFrames ?? 'message',
          historyJumpReuseMode: over.historyJumpReuseMode ?? 'replace',
        },
      }),
      subscribe: () => () => {},
    },
    useInput: <T,>(selector: (state: { draft: string }) => T): T => selector({ draft: over.draft ?? '' }),
    inputActions: { setDraft: over.setDraft ?? (() => {}) },
    useChat: chatStub(table),
    t,
  }
  return stub as unknown as HistoryPaletteProps
}

function mount(element: ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return { root, container }
}

// Each test starts from an empty document: a leaked palette layer from the
// previous test would otherwise be found by `palette()` and mask a real failure.
beforeEach(() => { document.body.innerHTML = '' })

/**
 * Dispatch one capture-phase keydown, as the component listens for.
 *
 * Dispatched on an explicitly chosen target rather than on `document.activeElement`:
 * an unmounted test leaves a detached node as the active element, and events
 * dispatched there never reach the document listener at all.
 * @param key - the key value.
 * @param init - extra event fields.
 * @param target - where to dispatch; `document.body` by default.
 */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

/**
 * Type into a controlled input the way a user does.
 *
 * React tracks the previous value on the DOM node, so assigning `.value`
 * directly is ignored; the native setter plus a bubbling `input` event is the
 * sequence React actually listens for.
 * @param input - the input element.
 * @param value - the text to put in it.
 */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** The palette dialog, or null while it is closed. */
function palette(): HTMLElement | null {
  return document.querySelector('[data-atlas-history-palette]')
}

/** The filter input, once the palette is open. */
function filterInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[data-atlas-history-filter]')!
}

/** The visible rows' text, in display order. */
function rows(): string[] {
  return [...document.querySelectorAll('[data-atlas-history-row]')].map(node => node.textContent ?? '')
}

describe('matchesQuery', () => {
  const frame = {
    key: 'k', seq: 1, turn: 1, time: 0, kind: 'user' as const,
    text: 'Question', preview: 'question about the parser', answer: 'answer about lexing', hasAttachment: false,
  }

  it('matches everything on an empty query', () => {
    expect(matchesQuery(frame as HistoryFrame, '')).toBe(true)
  })

  it('matches the message text case-insensitively', () => {
    expect(matchesQuery(frame as HistoryFrame, 'parser')).toBe(true)
  })

  it('matches the turn answer too', () => {
    // "the one where we talked about X" is as often remembered by the reply.
    expect(matchesQuery(frame as HistoryFrame, 'lexing')).toBe(true)
  })

  it('rejects a frame matching neither', () => {
    expect(matchesQuery(frame as HistoryFrame, 'nothing here')).toBe(false)
  })
})

describe('HistoryPalette', () => {
  it('stays closed until the chord is pressed', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('opens on Ctrl+H and lists every user message, newest first', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(palette()).not.toBeNull()
    const text = rows()
    // Four messages: two questions and the replies they got. The reply frames are
    // why the list is longer than the user-authored count the chord walks.
    expect(text).toHaveLength(4)
    // Newest first: a searchable list is read from the top.
    expect(text[0]).toContain('answer two')
    expect(text[1]).toContain('second question')
    expect(text[2]).toContain('answer one')
    expect(text[3]).toContain('first question')
    root.unmount()
  })

  it('accepts Cmd as well as Ctrl', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { metaKey: true })
    flushSync(() => {})
    expect(palette()).not.toBeNull()
    root.unmount()
  })

  it('shows each turn answer under its message', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(rows()[0]).toContain('answer two')
    root.unmount()
  })

  it('tags a mid-turn interjection', () => {
    const { root } = mount(<HistoryPalette {...props({
      table: { u1: userNode('a question', 1), u2: userNode('an interjection', 1, 'steering') },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(rows()[0]).toContain(zh['history.steeringTag'])
    root.unmount()
  })

  it('does not open when the feature is off', () => {
    const { root } = mount(<HistoryPalette {...props({ historyJump: false })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('does not open from inside a foreign text field', () => {
    const { root, container } = mount(<HistoryPalette {...props()} />)
    const input = document.createElement('input')
    container.appendChild(input)
    // Dispatched ON the input: the guard reads `event.target`, so an event sent
    // to the body would not exercise it at all.
    press('h', { ctrlKey: true }, input)
    flushSync(() => {})
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('does not open while an IME composition is running', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true, isComposing: true })
    flushSync(() => {})
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('does not open while a modal already owns the keyboard', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(palette()).toBeNull()
    modal.remove()
    root.unmount()
  })

  it('ignores a bare h', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h')
    flushSync(() => {})
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('folds the history to one row per turn in turn mode', () => {
    const { root } = mount(<HistoryPalette {...props({ historyJumpFrames: 'turn' })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(rows()).toHaveLength(2)
    root.unmount()
  })

  it('narrows the list as the filter is typed, and reports the count', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    flushSync(() => { type(filterInput(), 'first') })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('first question')
    root.unmount()
  })

  it('says so when nothing matches', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    flushSync(() => { type(filterInput(), 'zzzz') })
    expect(rows()).toHaveLength(0)
    expect(palette()?.textContent).toContain(zh['history.paletteEmpty'])
    root.unmount()
  })

  it('fills the composer with the highlighted message on Enter', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({ setDraft: text => { written.push(text) } })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    // The newest message is highlighted first — the reply.
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['answer two'])
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('walks the highlight with the arrows and wraps at both ends', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({ setDraft: text => { written.push(text) } })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('ArrowDown')
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    // One step down from the reply is the question that asked it.
    expect(written).toEqual(['second question'])
    root.unmount()
  })

  it('wraps from the top back to the bottom', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({ setDraft: text => { written.push(text) } })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('ArrowUp')
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['first question'])
    root.unmount()
  })

  it('reuses a message clicked directly', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({ setDraft: text => { written.push(text) } })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    const row = [...document.querySelectorAll<HTMLElement>('[data-atlas-history-row]')][1]!
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync(() => {})
    expect(written).toEqual(['second question'])
    root.unmount()
  })

  it('appends instead of replacing when that mode is configured', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({
      draft: 'keep me',
      historyJumpReuseMode: 'append',
      setDraft: text => { written.push(text) },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['keep me\nanswer two'])
    root.unmount()
  })

  it('replaces the draft by default', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({
      draft: 'discard me',
      setDraft: text => { written.push(text) },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['answer two'])
    root.unmount()
  })

  it('closes on Escape without writing anything', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({ setDraft: text => { written.push(text) } })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('Escape')
    flushSync(() => {})
    expect(palette()).toBeNull()
    expect(written).toEqual([])
    root.unmount()
  })

  it('closes when the backdrop is clicked', () => {
    const { root, container } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    const backdrop = container.querySelector('.dsh_atlas_paletteBackdrop')!
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync(() => {})
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('keeps an open palette open when the chord is pressed again', () => {
    // Ctrl+H is a toggle for OPENING, but while the palette is up it must not
    // close the thing the user is reading.
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(palette()).not.toBeNull()
    root.unmount()
  })

  it('reports the frame count on the root for a test to read', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(palette()?.getAttribute('data-atlas-frame-count')).toBe('4')
    root.unmount()
  })

  it('opens a session with no history without listing anything', () => {
    const { root } = mount(<HistoryPalette {...props({ table: {} })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(palette()).not.toBeNull()
    expect(rows()).toHaveLength(0)
    root.unmount()
  })

  it('does nothing on Enter when the filter matches nothing', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({ setDraft: text => { written.push(text) } })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    flushSync(() => { type(filterInput(), 'zzzz') })
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual([])
    root.unmount()
  })

  it('steps down through the middle of a longer list', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({
      table: { u1: userNode('one', 1), u2: userNode('two', 2), u3: userNode('three', 3) },
      setDraft: text => { written.push(text) },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    // Newest first: [three, two, one]. Two downs lands on the oldest.
    press('ArrowDown')
    flushSync(() => {})
    press('ArrowDown')
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['one'])
    root.unmount()
  })

  it('steps back up from the middle of a longer list', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({
      table: { u1: userNode('one', 1), u2: userNode('two', 2), u3: userNode('three', 3) },
      setDraft: text => { written.push(text) },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('ArrowDown')
    flushSync(() => {})
    press('ArrowUp')
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['three'])
    root.unmount()
  })

  it('moves the highlight when the pointer enters a row', () => {
    // React derives onMouseEnter from the bubbling mouseover/mouseout pair and
    // only fires it when relatedTarget is OUTSIDE the element, which is fiddly to
    // synthesise faithfully. Driving the handler the event would reach is the
    // honest version: React hangs it off the row's own props.
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    const rows = [...document.querySelectorAll<HTMLElement>('[data-atlas-history-row]')]
    expect(rows[0]!.getAttribute('data-atlas-history-active')).toBe('')
    // The handler is reachable through React's internal props key on the node.
    const propsKey = Object.keys(rows[1]!).find(key => key.startsWith('__reactProps'))
    expect(propsKey).toBeDefined()
    const handler = (rows[1] as unknown as Record<string, { onMouseEnter?: () => void }>)[propsKey!]?.onMouseEnter
    expect(handler).toBeTypeOf('function')
    flushSync(() => { handler?.() })
    expect(rows[1]!.getAttribute('data-atlas-history-active')).toBe('')
    expect(rows[0]!.getAttribute('data-atlas-history-active')).toBeNull()
    root.unmount()
  })

  it('names the draft slot for a message that carries no text', () => {
    // An attachment-only message has no preview; the row still needs a label.
    const { root } = mount(<HistoryPalette {...props({
      table: {
        u1: { kind: 'user', data: { content: [{ type: 'image' }] }, location: { kind: 'turn', turn: { turn: 1 } } },
      },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    expect(rows()[0]).toContain(zh['history.draftSlot'])
    root.unmount()
  })

  it('ignores a non-chord key while closed', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('x')
    flushSync(() => {})
    expect(palette()).toBeNull()
    root.unmount()
  })

  it('opens on the Shift spelling too, but not on an Alt chord', () => {
    const withShift = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true, shiftKey: true })
    flushSync(() => {})
    expect(palette()).not.toBeNull()
    withShift.root.unmount()

    // AltGr is Ctrl+Alt on Windows: an Alt-carrying chord must fall through.
    const withAlt = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true, altKey: true })
    flushSync(() => {})
    expect(palette()).toBeNull()
    withAlt.root.unmount()
  })

  it('does not add a second newline when the draft already ends with one', () => {
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({
      draft: 'keep me\n',
      historyJumpReuseMode: 'append',
      setDraft: text => { written.push(text) },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['keep me\nanswer two'])
    root.unmount()
  })

  it('appends nothing when the draft is blank', () => {
    // A blank draft is not something to append AFTER: the message stands alone.
    const written: string[] = []
    const { root } = mount(<HistoryPalette {...props({
      draft: '   ',
      historyJumpReuseMode: 'append',
      setDraft: text => { written.push(text) },
    })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('Enter')
    flushSync(() => {})
    expect(written).toEqual(['answer two'])
    root.unmount()
  })

  it('keeps the arrows harmless while the list is empty', () => {
    const { root } = mount(<HistoryPalette {...props({ table: {} })} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    press('ArrowUp')
    press('ArrowDown')
    flushSync(() => {})
    // No rows to highlight, and no crash from the clamping arithmetic.
    expect(rows()).toHaveLength(0)
    root.unmount()
  })

  it('ignores the chord while open instead of closing', () => {
    const { root } = mount(<HistoryPalette {...props()} />)
    press('h', { ctrlKey: true })
    flushSync(() => {})
    // A Shift-carrying chord is not the toggle, so it must fall through the
    // default arm and leave the palette alone.
    press('h', { ctrlKey: true, shiftKey: true })
    flushSync(() => {})
    expect(palette()).not.toBeNull()
    root.unmount()
  })
})
