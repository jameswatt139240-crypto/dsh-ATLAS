/**
 * `history-keys.ts` — pure key resolution.
 *
 * The interesting cases are the GIVE-WAY arms: every one of them is a real
 * interface the harness owns (the `@` menu, a modal, an IME composition, a
 * foreign text field), and getting one wrong means either a stolen keystroke or
 * a broken composition. The slot arithmetic is asserted at both clamps, because
 * "keep pressing up" ending on the draft slot is the behaviour the user
 * described.
 */
import { describe, expect, it } from 'vitest'
import {
  commandLabel,
  clampSlot,
  consumes,
  frameAtSlot,
  isLeave,
  resolveIntent,
  slotOfFrame,
  stepSlot,
  type HistoryEnvironment,
  type HistoryIntent,
  type HistoryPhase,
  type KeyFacts,
} from '../src/client/history-keys.ts'

/** One key event, with the boring fields defaulted. */
function key(value: string, overrides: Partial<KeyFacts> = {}): KeyFacts {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...overrides,
  }
}

/** A permissive environment; each test narrows what it is about. */
function env(overrides: Partial<HistoryEnvironment> = {}): HistoryEnvironment {
  return { enabled: true, menuOpen: false, modalOpen: false, foreignEditor: false, ...overrides }
}

/** Resolve with a quiet environment unless the test says otherwise. */
function at(facts: KeyFacts, phase: HistoryPhase = 'idle', environment = env()): HistoryIntent | undefined {
  return resolveIntent(facts, phase, environment)
}

describe('commandLabel', () => {
  it('reads the platform string case-insensitively', () => {
    expect(commandLabel('MacIntel')).toBe('⌘')
    expect(commandLabel('macOS')).toBe('⌘')
  })

  it('answers Ctrl everywhere else', () => {
    expect(commandLabel('Win32')).toBe('Ctrl')
    expect(commandLabel('Linux x86_64')).toBe('Ctrl')
  })
})

describe('resolveIntent: environment gates', () => {
  it('declines everything when the feature is off', () => {
    expect(at(key('Escape'), 'idle', env({ enabled: false }))).toBeUndefined()
    expect(at(key('ArrowUp'), 'roaming', env({ enabled: false }))).toBeUndefined()
    expect(at(key('h', { ctrlKey: true }), 'idle', env({ enabled: false }))).toBeUndefined()
  })

  it('declines everything while an IME composition is running', () => {
    expect(at(key('Escape', { isComposing: true }))).toBeUndefined()
    expect(at(key('ArrowUp', { isComposing: true }), 'roaming')).toBeUndefined()
  })

  it('declines Escape while a modal owns the keyboard', () => {
    // The modal's own Escape listener does not preventDefault, so acting first
    // in capture phase would leave the modal open AND start roaming.
    expect(at(key('Escape'), 'idle', env({ modalOpen: true }))).toBeUndefined()
    expect(at(key('Enter'), 'roaming', env({ modalOpen: true }))).toBeUndefined()
  })

  it('lets the palette own its keys while it is open', () => {
    expect(at(key('ArrowUp'), 'palette')).toBeUndefined()
    expect(at(key('Escape'), 'palette')).toBeUndefined()
  })
})

describe('resolveIntent: entering roaming', () => {
  it('enters on a plain Escape', () => {
    expect(at(key('Escape'))).toEqual({ kind: 'enter' })
  })

  it('does not enter on a modified Escape', () => {
    expect(at(key('Escape', { ctrlKey: true }))).toBeUndefined()
    expect(at(key('Escape', { metaKey: true }))).toBeUndefined()
    expect(at(key('Escape', { altKey: true }))).toBeUndefined()
  })

  it('does not enter while the @ menu owns the arrows', () => {
    expect(at(key('Escape'), 'idle', env({ menuOpen: true }))).toBeUndefined()
  })

  it('does not enter while a turn is generating, but keeps the palette chord', () => {
    // B-03: a running turn owns Escape (the interrupt gesture). The palette
    // chord is deliberately NOT gated — reading history is what a waiting user
    // does — and the quick chord stays live too.
    const running = env({ generating: true })
    expect(at(key('Escape'), 'idle', running)).toBeUndefined()
    expect(at(key('h', { ctrlKey: true }), 'idle', running)).toEqual({ kind: 'palette' })
    expect(at(key('ArrowUp', { ctrlKey: true }), 'idle', running))
      .toEqual({ kind: 'step', direction: -1, page: false, quick: true })
  })

  it('stands down mid-walk while the @ menu owns the arrows', () => {
    // The menu moves its own highlight on the same keys, so both reacting would
    // drive the menu and the cursor at once.
    const menu = env({ menuOpen: true })
    expect(at(key('ArrowUp'), 'roaming', menu)).toBeUndefined()
    expect(at(key('ArrowDown'), 'roaming', menu)).toBeUndefined()
    expect(at(key('PageUp'), 'roaming', menu)).toBeUndefined()
    expect(at(key('Home'), 'roaming', menu)).toBeUndefined()
    expect(at(key('Enter'), 'roaming', menu)).toBeUndefined()
  })

  it('still lets Escape leave the walk while the @ menu is open', () => {
    // Escape is how the user gets out; the menu must not trap them in roaming.
    expect(at(key('Escape'), 'roaming', env({ menuOpen: true }))).toEqual({ kind: 'leave', consume: true })
  })

  it('does not enter from a foreign text field', () => {
    expect(at(key('Escape'), 'idle', env({ foreignEditor: true }))).toBeUndefined()
  })

  it('ignores ordinary keys while idle', () => {
    expect(at(key('a'))).toBeUndefined()
    expect(at(key('ArrowUp'))).toBeUndefined()
  })
})

describe('resolveIntent: roaming navigation', () => {
  it('steps older and newer on the arrows', () => {
    expect(at(key('ArrowUp'), 'roaming')).toEqual({ kind: 'step', direction: -1, page: false, quick: false })
    expect(at(key('ArrowDown'), 'roaming')).toEqual({ kind: 'step', direction: 1, page: false, quick: false })
  })

  it('pages on PageUp and PageDown', () => {
    expect(at(key('PageUp'), 'roaming')).toEqual({ kind: 'step', direction: -1, page: true, quick: false })
    expect(at(key('PageDown'), 'roaming')).toEqual({ kind: 'step', direction: 1, page: true, quick: false })
  })

  it('jumps to the ends on Home and End', () => {
    expect(at(key('Home'), 'roaming')).toEqual({ kind: 'edge', to: 'oldest' })
    expect(at(key('End'), 'roaming')).toEqual({ kind: 'edge', to: 'draft' })
  })

  it('reuses on Enter and leaves on Escape', () => {
    expect(at(key('Enter'), 'roaming')).toEqual({ kind: 'reuse' })
    expect(at(key('Escape'), 'roaming')).toEqual({ kind: 'leave', consume: true })
  })

  it('leaves without consuming on an ordinary keystroke', () => {
    // The character must reach the composer; swallowing it to exit a mode would
    // silently eat the first letter the user types.
    expect(at(key('a'), 'roaming')).toEqual({ kind: 'leave', consume: false })
    expect(at(key('Backspace'), 'roaming')).toEqual({ kind: 'leave', consume: false })
    expect(at(key('Tab'), 'roaming')).toEqual({ kind: 'leave', consume: false })
  })

  it('keeps the chord quick while roaming, and still declines printable chords', () => {
    // A-18 reverses what this spec used to assert. It read
    // `{ kind: 'step', direction: -1, page: false }` with no marker, i.e. the
    // chord was indistinguishable from a bare arrow while roaming. The user wants
    // the two features separate: Ctrl+Arrow keeps its reuse semantics wherever it
    // is pressed, so the intent is the QUICK variant.
    expect(at(key('ArrowUp', { ctrlKey: true }), 'roaming'))
      .toEqual({ kind: 'step', direction: -1, page: false, quick: true })
    expect(at(key('ArrowDown', { ctrlKey: true }), 'roaming'))
      .toEqual({ kind: 'step', direction: 1, page: false, quick: true })
    expect(at(key('ArrowUp', { metaKey: true }), 'roaming'))
      .toEqual({ kind: 'step', direction: -1, page: false, quick: true })
    // A printable chord is still the browser's and the composer's.
    expect(at(key('a', { ctrlKey: true }), 'roaming')).toBeUndefined()
    expect(at(key('a', { metaKey: true }), 'roaming')).toBeUndefined()
    expect(at(key('a', { altKey: true }), 'roaming')).toBeUndefined()
  })
})

describe('resolveIntent: the quick chords', () => {
  it('steps from the composer without entering roaming first', () => {
    expect(at(key('ArrowUp', { ctrlKey: true }))).toEqual({ kind: 'step', direction: -1, page: false, quick: true })
    expect(at(key('ArrowDown', { ctrlKey: true }))).toEqual({ kind: 'step', direction: 1, page: false, quick: true })
  })

  it('accepts Cmd as well as Ctrl', () => {
    expect(at(key('ArrowUp', { metaKey: true }))).toEqual({ kind: 'step', direction: -1, page: false, quick: true })
  })

  it('declines a chord carrying Shift or Alt', () => {
    expect(at(key('ArrowUp', { ctrlKey: true, shiftKey: true }))).toBeUndefined()
    expect(at(key('ArrowUp', { ctrlKey: true, altKey: true }))).toBeUndefined()
  })

  it('declines the chord in a foreign text field', () => {
    expect(at(key('ArrowUp', { ctrlKey: true }), 'idle', env({ foreignEditor: true }))).toBeUndefined()
  })

  it('works while the @ menu is open, because the menu does not use it', () => {
    expect(at(key('ArrowUp', { ctrlKey: true }), 'idle', env({ menuOpen: true })))
      .toEqual({ kind: 'step', direction: -1, page: false, quick: true })
  })

  it('works while the turn is still generating', () => {
    expect(at(key('ArrowUp', { ctrlKey: true }), 'idle', env({ generating: true })))
      .toEqual({ kind: 'step', direction: -1, page: false, quick: true })
  })
})

describe('resolveIntent: the palette chord', () => {
  it('toggles on Ctrl/Cmd + H', () => {
    expect(at(key('h', { ctrlKey: true }))).toEqual({ kind: 'palette' })
    expect(at(key('h', { metaKey: true }))).toEqual({ kind: 'palette' })
  })

  it('accepts the uppercase form a Shift-less layout may report', () => {
    expect(at(key('H', { ctrlKey: true }))).toEqual({ kind: 'palette' })
  })

  it('works while generating, which is when reading history is most useful', () => {
    expect(at(key('h', { ctrlKey: true }), 'idle', env({ generating: true }))).toEqual({ kind: 'palette' })
  })

  it('works while the @ menu is open', () => {
    expect(at(key('h', { ctrlKey: true }), 'idle', env({ menuOpen: true }))).toEqual({ kind: 'palette' })
  })

  it('ignores a bare h', () => {
    expect(at(key('h'))).toBeUndefined()
  })

  it('answers the palette chord with or without Shift, and declines Alt', () => {
    // docs/history-jump.md §2 asks for the Shift spelling (bare Ctrl+H is the
    // browser's History, Cmd+H hides the app on macOS); the code always answered
    // the unshifted one. Both are the palette now.
    expect(at(key('h', { ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'palette' })
    expect(at(key('h', { ctrlKey: true }))).toEqual({ kind: 'palette' })
    // AltGr is Ctrl+Alt on Windows, so Alt must stay excluded.
    expect(at(key('h', { ctrlKey: true, altKey: true }))).toBeUndefined()
  })

  it('declines in a foreign text field', () => {
    expect(at(key('h', { ctrlKey: true }), 'idle', env({ foreignEditor: true }))).toBeUndefined()
  })
})

describe('consumes', () => {
  it('consumes every gesture that is ours', () => {
    expect(consumes({ kind: 'enter' })).toBe(true)
    expect(consumes({ kind: 'step', direction: -1, page: false })).toBe(true)
    expect(consumes({ kind: 'edge', to: 'oldest' })).toBe(true)
    expect(consumes({ kind: 'reuse' })).toBe(true)
    expect(consumes({ kind: 'palette' })).toBe(true)
    expect(consumes({ kind: 'leave', consume: true })).toBe(true)
  })

  it('does not consume a keystroke that is the user typing', () => {
    expect(consumes({ kind: 'leave', consume: false })).toBe(false)
  })
})

describe('isLeave', () => {
  it('recognises a leave intent', () => {
    expect(isLeave({ kind: 'leave', consume: false })).toBe(true)
  })

  it('rejects every other intent', () => {
    expect(isLeave({ kind: 'enter' })).toBe(false)
    expect(isLeave({ kind: 'reuse' })).toBe(false)
  })
})

describe('stepSlot', () => {
  it('walks one slot at a time', () => {
    expect(stepSlot(0, -1, 3)).toBe(1)
    expect(stepSlot(2, -1, 3)).toBe(3)
    expect(stepSlot(3, 1, 3)).toBe(2)
  })

  it('wraps from the oldest frame round to the draft slot when wrapping is allowed', () => {
    // A-17, still true for ESC roaming: the roaming walk is a CYCLE, so slot N (the
    // oldest) steps on to slot 0.
    expect(stepSlot(3, -1, 3, true)).toBe(0)
  })

  it('wraps from the draft slot round to the oldest frame when wrapping is allowed', () => {
    expect(stepSlot(0, 1, 3, true)).toBe(3)
  })

  it('stops at the oldest frame instead of wrapping when wrapping is refused', () => {
    // A-21: the Ctrl+↑/↓ chord has no cycle. Pressing on at the oldest message stays
    // there, which is what "去掉首尾循环" asks for.
    expect(stepSlot(3, -1, 3, false)).toBe(3)
    // ...and the same at the draft end, where "older" would otherwise have wrapped.
    expect(stepSlot(0, 1, 3, false)).toBe(0)
  })

  it('still moves normally when wrapping is refused and no end is reached', () => {
    // The refusal must only bite AT an end: a mid-walk step is identical either way,
    // which is what keeps A-21 from changing the ordinary walk.
    expect(stepSlot(1, -1, 3, false)).toBe(2)
    expect(stepSlot(2, 1, 3, false)).toBe(1)
    expect(stepSlot(1, -1, 3, true)).toBe(2)
  })

  it('stays on the draft when there is no history', () => {
    // The single-slot walk is the one case where the wrap is a no-op, because the
    // size is `frameCount + 1 = 1`.
    expect(stepSlot(0, -1, 0, true)).toBe(0)
    expect(stepSlot(0, 1, 0, true)).toBe(0)
  })

  it('clamps where wrapping is not wanted', () => {
    // `clampSlot` is the companion A-17 needs: the PAGED move and the page-settle
    // must stop at an end of the walk, so the wrap can never make a page jump to the
    // far end of the history or teleport the cursor after a page arrives.
    expect(clampSlot(4, 3)).toBe(3)
    expect(clampSlot(-1, 3)).toBe(0)
    expect(clampSlot(2, 3)).toBe(2)
    // A walk with no history has exactly one slot, the draft.
    expect(clampSlot(5, 0)).toBe(0)
  })
})

describe('frameAtSlot', () => {
  it('answers undefined for the draft slot', () => {
    expect(frameAtSlot(0, 3)).toBeUndefined()
    expect(frameAtSlot(-1, 3)).toBeUndefined()
  })

  it('maps the slot space onto the oldest-first frame array', () => {
    // Slot 1 is the NEWEST frame, which is the LAST element of the array.
    expect(frameAtSlot(1, 3)).toBe(2)
    expect(frameAtSlot(2, 3)).toBe(1)
    expect(frameAtSlot(3, 3)).toBe(0)
  })

  it('answers undefined for a slot past the oldest frame', () => {
    expect(frameAtSlot(4, 3)).toBeUndefined()
  })
})

describe('slotOfFrame', () => {
  it('is the inverse of frameAtSlot', () => {
    for (let index = 0; index < 4; index += 1) {
      expect(frameAtSlot(slotOfFrame(index, 4), 4)).toBe(index)
    }
  })
})
