// @vitest-environment jsdom
/**
 * The menu glyph layer: it draws this plugin's icons over the icon slot the
 * framework reserves on each of our rows, and marks exactly those slots so the
 * stylesheet hides the framework's own glyph there — and nowhere else.
 */
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_ATTRIBUTE, MenuIcons, type MenuIconsProps } from '../src/client/MenuIcons.tsx'
import { cssText } from '../src/client/styles.ts'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

const liveRoots = new Set<Root>()

afterEach(() => {
  for (const root of [...liveRoots]) { liveRoots.delete(root); root.unmount() }
  document.body.innerHTML = ''
})

/**
 * One menu option row exactly as the framework renders it (id + icon slot),
 * inside the listbox viewport that clips the list. The viewport matters: the
 * layer only draws into rows that fit inside it.
 */
function optionRow(index: number, withSlot = true): string {
  return '<div role="listbox">'
    + `<button role="option" id="dsh-slash-option-atlas-${index}">`
    + (withSlot ? '<span class="x_itemIcon"><svg data-framework-glyph></svg></span>' : '')
    + `<span class="x_itemName">row ${index}</span></button>`
    + '</div>'
}

/** Lay out one rect over an element (jsdom implements no layout at all). */
function rectOf(element: Element, top: number, height: number, left = 0, width = 300): void {
  element.getBoundingClientRect = () => ({
    top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect
}

/** A menu state with our group ready, holding the given rows. */
function menuState(items: readonly unknown[], open = true, status = 'ready'): MenuState {
  return {
    open,
    hit: { trigger: '@', query: '', position: 'leading', span: { start: 0, end: 1, draftRev: 1 } },
    generation: 1,
    groups: [{ source: 'atlas', status, items }],
    highlight: null,
  } as unknown as MenuState
}

/** Mount the glyph layer over one menu state. */
function mount(items: readonly unknown[], open = true): { root: Root; host: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  liveRoots.add(root)
  const state = menuState(items, open)
  const useMenu = (select: (snapshot: MenuState) => unknown): unknown => select(state)
  flushSync(() => {
    root.render(<MenuIcons {...({ useMenu } as unknown as MenuIconsProps)} />)
  })
  flushSync(() => {})
  return { root, host: container }
}

describe('MenuIcons', () => {
  it('draws the glyphs a menu that was still settling had no slots for yet', async () => {
    // The framework paints our rows a frame or two after the store says they are
    // ready (it opens upward, it scrolls its list into view). The first measure
    // finds nothing; without a retry the glyphs would stay missing until the next
    // keystroke, which is exactly the "sometimes it shows up" report.
    const frames: FrameRequestCallback[] = []
    const realFrame = globalThis.requestAnimationFrame
    const realCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback)
      return frames.length
    }
    globalThis.cancelAnimationFrame = (): void => {}
    try {
      const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'skill' }])
      expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(0)
      // Now the rows land, exactly as the framework would render them late. They
      // are appended, never swapped in: replacing body's markup would take this
      // layer's own container down with it.
      const late = document.createElement('div')
      late.innerHTML = optionRow(0) + optionRow(1)
      document.body.appendChild(late)
      while (frames.length > 0) frames.shift()!(0)
      // The retry measures outside React's event loop, so the state it sets lands
      // in a task of its own; one macrotask is all that is needed to see it.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(2)
    } finally {
      globalThis.requestAnimationFrame = realFrame
      globalThis.cancelAnimationFrame = realCancel
    }
  })

  it('draws one glyph per row, over the slot the framework reserved', () => {
    document.body.innerHTML = optionRow(0) + optionRow(1)
    const { host } = mount([{ mentionKind: 'file', value: 'src/index.ts' }, { mentionKind: 'skill' }])
    const glyphs = host.querySelectorAll('.dsh_atlas_menuIcon')
    expect(glyphs).toHaveLength(2)
    // Monochrome line art from this plugin's own set (the dock's), not the
    // framework's three-glyph set.
    expect(glyphs[0]!.querySelector('svg')?.getAttribute('class')).toContain('tabler-icon-brand-typescript')
    expect(glyphs[1]!.querySelector('svg')?.getAttribute('class')).toContain('tabler-icon-bolt')
    // Exactly the slots we cover are marked, which is what hides the framework's
    // own glyph there and only there.
    const slots = [...document.querySelectorAll('[class*="itemIcon"]')]
    expect(slots.every(slot => slot.hasAttribute(HOST_ATTRIBUTE))).toBe(true)
  })

  it('draws nothing for an owned row the framework left without a slot', () => {
    // Both rows are ours; the second one has no icon slot at all.
    document.body.innerHTML = optionRow(0) + optionRow(1, false)
    const { host } = mount([
      { mentionKind: 'file', value: 'a.ts' },
      { mentionKind: 'file', value: 'b.ts' },
    ])
    expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(1)
  })

  it('draws nothing for a row the framework has not rendered yet', () => {
    // Our group says two rows; the DOM still has only the first one.
    document.body.innerHTML = optionRow(0)
    const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'skill' }])
    expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(1)
  })

  it('stops covering a slot the framework takes away', () => {
    document.body.innerHTML = optionRow(0) + optionRow(1)
    const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'skill' }])
    const slots = [...document.querySelectorAll('[class*="itemIcon"]')] as HTMLElement[]
    expect(slots.every(slot => slot.hasAttribute(HOST_ATTRIBUTE))).toBe(true)
    // The row goes away; the framework's own glyph must come back with it.
    slots[1]!.remove()
    window.dispatchEvent(new Event('resize'))
    flushSync(() => {})
    expect(slots[1]!.hasAttribute(HOST_ATTRIBUTE)).toBe(false)
    expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(1)
  })

  it('marks only the slots it actually covers', () => {
    document.body.innerHTML = optionRow(0) + optionRow(1, false) + optionRow(2)
    const { host } = mount([
      { mentionKind: 'file', value: 'a.ts' },
      { mentionKind: 'plugin', value: 'dsh-atlas' },
      { mentionKind: 'chat', value: 'sess-a' },
    ])
    // The middle row has no slot (the framework renders none for a candidate
    // without an icon), so nothing is drawn and nothing is hidden for it.
    expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(2)
    const rows = [...document.querySelectorAll('[role="option"]')]
    expect(rows[0]!.querySelector('[class*="itemIcon"]')!.hasAttribute(HOST_ATTRIBUTE)).toBe(true)
    expect(rows[1]!.querySelector('[class*="itemIcon"]')).toBeNull()
    expect(rows[2]!.querySelector('[class*="itemIcon"]')!.hasAttribute(HOST_ATTRIBUTE)).toBe(true)
  })

  it('draws nothing while the menu is closed, and unmarks on the way out', () => {
    document.body.innerHTML = optionRow(0)
    const slot = document.querySelector('[class*="itemIcon"]') as HTMLElement
    const closed = mount([{ mentionKind: 'file', value: 'a.ts' }], false)
    expect(closed.host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(0)
    expect(slot.hasAttribute(HOST_ATTRIBUTE)).toBe(false)

    const open = mount([{ mentionKind: 'file', value: 'a.ts' }])
    expect(slot.hasAttribute(HOST_ATTRIBUTE)).toBe(true)
    open.root.unmount()
    liveRoots.delete(open.root)
    expect(slot.hasAttribute(HOST_ATTRIBUTE)).toBe(false)
  })

  it('gives a provider the glyph it declares, and follows the rows it is handed', () => {
    document.body.innerHTML = optionRow(0)
    const git = mount([{ mentionKind: 'provider', providerId: 'git', value: 'a.ts' }])
    expect(git.host.querySelector('svg')?.getAttribute('class')).toContain('tabler-icon-brand-git')

    // A second menu state (another source, or a closed menu) leaves the layer empty.
    const empty = mount([{ mentionKind: 'file', value: 'a.ts' }])
    expect(empty.host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('draws a category row in its accent hue and leaves data rows neutral', () => {
    document.body.innerHTML = optionRow(0) + optionRow(1)
    const { host } = mount([
      { mentionKind: 'category', value: 'file:' },
      { mentionKind: 'file', value: 'src/index.ts' },
    ])
    const glyphs = [...host.querySelectorAll('.dsh_atlas_menuIcon')]
    expect(glyphs).toHaveLength(2)
    // The accent reaches the DOM as an inline colour (the stylesheet's neutral
    // one stays the default for everything else).
    expect((glyphs[0] as HTMLElement).style.color).toContain('--dsw-alias-state-business-primary')
    expect((glyphs[1] as HTMLElement).style.color).toBe('')
  })

  it('keeps the stylesheet invariants the layer depends on', () => {
    /** The declarations of one rule block in the injected stylesheet. */
    const rule = (selector: string): string => {
      const start = cssText.indexOf(`${selector} {`)
      expect(start, `rule ${selector} is missing`).toBeGreaterThanOrEqual(0)
      return cssText.slice(start, cssText.indexOf('}', start))
    }
    // The layer floats above the menu (z-index past the menu's 100) and is
    // click-through, so it can never intercept a pick.
    const layer = rule('.dsh_atlas_menuIcon')
    expect(layer).toContain('position: fixed')
    expect(layer).toContain('pointer-events: none')
    expect(Number(/z-index: (\d+)/u.exec(layer)?.[1])).toBeGreaterThan(100)
    // The neutral colour is a DEFAULT: an `!important` here would silently win
    // over every category accent the layer sets inline.
    expect(layer).toContain('color: var(--dsw-alias-label-secondary, #9aa4b2)')
    expect(layer).not.toContain('!important')
    // The framework's own glyph is hidden exactly on a covered slot, and only on
    // the svg (the slot itself stays measurable and keeps its size).
    const hidden = rule('[data-dsh-atlas-menu-icon-host] > svg')
    expect(hidden).toContain('display: none')
    // The menu cap is ours to publish: the stylesheet must read the variable the
    // navigator sets, with the viewport fallback before the first measurement.
    const menu = rule('[role="listbox"]:has([data-source="atlas"])')
    expect(menu).toContain('max-height: min(760px, var(--dsh-atlas-menu-max, calc(100dvh - 100px)))')
    // ...and it must NOT set a width: the framework's own `left: 0; right: 0`
    // inside the composer card is what keeps the popup exactly as wide as the
    // chat box. A `max-content` width here is what once pushed it past.
    expect(menu).not.toContain('width')
  })

  it('watches the list for rows that land after the frames gave up', async () => {
    // The budget is 500 ms of frames; a menu whose rows arrive after that (a second
    // plugin band repainting above ours, a slow first paint) still has to get its
    // glyphs. The mutation watch is what catches it — no keystroke required.
    const frames: FrameRequestCallback[] = []
    const realFrame = globalThis.requestAnimationFrame
    const realCancel = globalThis.cancelAnimationFrame
    const realNow = performance.now.bind(performance)
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback)
      return frames.length
    }
    globalThis.cancelAnimationFrame = (): void => {}
    try {
      const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'skill' }])
      let ticked = 0
      performance.now = () => { ticked += 1; return ticked * 400 }
      while (frames.length > 0) frames.shift()!(0)
      expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(0)
      const late = document.createElement('div')
      late.innerHTML = optionRow(0) + optionRow(1)
      document.body.appendChild(late)
      // The observer callback is a microtask and the state it sets lands in a task
      // of its own; poll instead of trusting one exact tick.
      for (let waited = 0; waited < 600 && host.querySelectorAll('.dsh_atlas_menuIcon').length < 2; waited += 10) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(2)
    } finally {
      performance.now = realNow
      globalThis.requestAnimationFrame = realFrame
      globalThis.cancelAnimationFrame = realCancel
    }
  })

  it('lets a queued frame go quietly when the layer is torn down first', () => {
    // A frame is already queued when the menu closes; running it after cleanup must
    // do nothing at all (no measure, no state on an unmounted component).
    const frames: FrameRequestCallback[] = []
    const realFrame = globalThis.requestAnimationFrame
    const realCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback)
      return frames.length
    }
    globalThis.cancelAnimationFrame = (): void => {}
    try {
      const { host, root } = mount([{ mentionKind: 'file', value: 'a.ts' }])
      root.unmount()
      liveRoots.delete(root)
      while (frames.length > 0) frames.shift()!(0)
      expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(0)
    } finally {
      globalThis.requestAnimationFrame = realFrame
      globalThis.cancelAnimationFrame = realCancel
    }
  })

  it('works without a MutationObserver at all', async () => {
    // Older runtimes (and a few test environments) have no MutationObserver; the
    // frame budget alone still places every glyph.
    const realObserver = globalThis.MutationObserver
    // @ts-expect-error -- deliberately removing a global to cover the fallback
    delete globalThis.MutationObserver
    try {
      const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'skill' }])
      const late = document.createElement('div')
      late.innerHTML = optionRow(0) + optionRow(1)
      document.body.appendChild(late)
      for (let waited = 0; waited < 600 && host.querySelectorAll('.dsh_atlas_menuIcon').length < 2; waited += 10) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(2)
    } finally {
      globalThis.MutationObserver = realObserver
    }
  })

  it('measures once more on a timer, for a window whose frames are throttled', async () => {
    // Backgrounded windows throttle (or stop) animation frames, so the frame budget
    // can burn without a single measurement. One delayed pass covers that case.
    const realFrame = globalThis.requestAnimationFrame
    const realCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = (): number => 0
    globalThis.cancelAnimationFrame = (): void => {}
    try {
      const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'skill' }])
      const late = document.createElement('div')
      late.innerHTML = optionRow(0) + optionRow(1)
      document.body.appendChild(late)
      // The pass is 120 ms out; poll rather than sleep a fixed 160 ms, so a loaded
      // machine cannot turn a slow timer into a failed assertion.
      for (let waited = 0; waited < 1200 && host.querySelectorAll('.dsh_atlas_menuIcon').length < 2; waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(2)
    } finally {
      globalThis.requestAnimationFrame = realFrame
      globalThis.cancelAnimationFrame = realCancel
    }
  })

  it('never draws a row that is scrolled out of the list, and never covers it', () => {
    // Reported live: the layer is fixed-position, so a glyph placed for a row
    // BELOW the menu's scrolling viewport escaped the menu's clipping and was
    // painted over the composer card. The menu ends at y=200; the row sits at
    // y=400 (scrolled out of sight).
    document.body.innerHTML = optionRow(0) + optionRow(1)
    rectOf(document.querySelector('[role="listbox"]')!, 0, 200)
    const scrolledOut = document.querySelectorAll('[class*="itemIcon"]')[1]!
    rectOf(scrolledOut, 400, 32)
    const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'file', value: 'b.ts' }])
    expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(1)
    expect(document.querySelectorAll('[class*="itemIcon"]')[0]!.hasAttribute(HOST_ATTRIBUTE)).toBe(true)
    // Left unmarked, so the framework's own glyph comes back for that row.
    expect(scrolledOut.hasAttribute(HOST_ATTRIBUTE)).toBe(false)
  })

  it('leaves a half-visible row alone as well, and does not guess without a viewport', () => {
    document.body.innerHTML = optionRow(0) + optionRow(1)
    rectOf(document.querySelector('[role="listbox"]')!, 0, 200)
    const slots = [...document.querySelectorAll('[class*="itemIcon"]')]
    // Straddling the clip edge: drawing here would spill half a glyph outside.
    rectOf(slots[0]!, 190, 32)
    rectOf(slots[1]!, 40, 32)
    rectOf(document.querySelectorAll('[role="listbox"]')[1]!, 0, 200)
    const { host } = mount([{ mentionKind: 'file', value: 'a.ts' }, { mentionKind: 'file', value: 'b.ts' }])
    expect(host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(1)
    expect(slots[0]!.hasAttribute(HOST_ATTRIBUTE)).toBe(false)
    expect(slots[1]!.hasAttribute(HOST_ATTRIBUTE)).toBe(true)

    // Unknown markup (no listbox around the row): draw nothing rather than guess.
    document.body.innerHTML = '<button role="option" id="dsh-slash-option-atlas-0"><span class="x_itemIcon"></span></button>'
    const unknown = mount([{ mentionKind: 'file', value: 'a.ts' }])
    expect(unknown.host.querySelectorAll('.dsh_atlas_menuIcon')).toHaveLength(0)
    expect(document.querySelector('[class*="itemIcon"]')!.hasAttribute(HOST_ATTRIBUTE)).toBe(false)
  })
})

describe('MenuIcons: a group that has not delivered its rows yet', () => {
  it('draws nothing while the group is still pending', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    liveRoots.add(root)
    const state = menuState([{ key: 'a', label: 'a', icon: 'file', value: 'a' }], true, 'pending')
    const useMenu = (select: (snapshot: MenuState) => unknown): unknown => select(state)
    flushSync(() => { root.render(<MenuIcons {...({ useMenu } as unknown as MenuIconsProps)} />) })
    flushSync(() => {})
    expect(container.querySelector(`[${HOST_ATTRIBUTE}]`)).toBeNull()
  })
})
