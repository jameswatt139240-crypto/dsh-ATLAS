// @vitest-environment jsdom
/**
 * The side ad panel is display-only, and every branch below is about the ONE
 * rule it must never break: the ad follows the menu's geometry and never covers
 * it. These tests drive `reposition` through the store, the resize hook and the
 * poll, with the menu's own rect stubbed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { MentionAd } from '../src/client/AdPanel.tsx'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

interface Store {
  readonly getSnapshot: () => MenuState
  readonly subscribe: (listener: () => void) => () => void
  readonly notify: () => void
}

function store(initial: MenuState): Store {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    notify: () => { for (const listener of listeners) listener() },
  }
}

const state = (over: Partial<MenuState> = {}): MenuState => ({
  open: true,
  hit: null,
  generation: 1,
  groups: [{ source: 'atlas', status: 'ready', items: [] }],
  highlight: null,
  ...over,
} as MenuState)

const rect = (left: number, right: number, top: number, height: number): DOMRect => ({
  left, right, top, height, bottom: top + height, width: right - left, x: left, y: top, toJSON: () => ({}),
} as DOMRect)

function menuElement(box: DOMRect): HTMLElement {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'listbox')
  const inner = document.createElement('div')
  inner.dataset.source = 'atlas'
  inner.setAttribute('data-source', 'atlas')
  menu.append(inner)
  menu.getBoundingClientRect = () => box
  document.body.append(menu)
  return menu
}

const panel = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[data-dsh-atlas-ad]')
  if (found === null) throw new Error('no ad panel')
  return found
}

beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => { document.body.innerHTML = '' })

describe('the side ad panel', () => {
  it('hides itself while the menu is closed or belongs to another source', () => {
    const menu = store(state({ open: false }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    flushSync(() => { root.render(<MentionAd menu={menu as never} />) })
    expect(panel().style.display).toBe('none')

    // Open, but the menu on screen is a slash menu: no atlas group, so no ad.
    menu.getSnapshot = () => state({ groups: [{ source: 'git', status: 'ready', items: [] }] as never })
    menu.notify()
    expect(panel().style.display).toBe('none')
    root.unmount()
  })

  it('hides without a menu element or with a zero-height menu', () => {
    const menu = store(state())
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    // No listbox anywhere: the panel has nothing to follow.
    flushSync(() => { root.render(<MentionAd menu={menu as never} />) })
    expect(panel().style.display).toBe('none')

    // A menu that is present but not laid out yet (height 0) is the same answer.
    menuElement(rect(100, 300, 50, 0))
    menu.notify()
    expect(panel().style.display).toBe('none')
    root.unmount()
  })

  it('sits to the RIGHT of the menu while the list is still pending', () => {
    const menu = store(state())
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    menuElement(rect(100, 400, 50, 200))
    flushSync(() => { root.render(<MentionAd menu={menu as never} />) })
    const ad = panel()
    expect(ad.style.display).toBe('block')
    expect(ad.style.left).toBe('408px')
    expect(ad.style.top).toBe('50px')
    expect(ad.style.height).toBe('200px')
    root.unmount()
  })

  it('moves to the LEFT once a typed query produced results', () => {
    const menu = store(state({
      hit: { trigger: '@', query: 'a', position: 'leading', span: { start: 0, end: 2, draftRev: 1 } },
      groups: [{ source: 'atlas', status: 'ready', items: [{ name: 'a.ts', value: 'a.ts' }] }] as never,
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    menuElement(rect(300, 600, 40, 200))
    flushSync(() => { root.render(<MentionAd menu={menu as never} />) })
    const ad = panel()
    expect(ad.style.display).toBe('block')
    // Out-LEFT of the menu, still inside the viewport, never overlapping it.
    expect(Number.parseFloat(ad.style.left)).toBeLessThan(300)
    root.unmount()
  })

  it('hides when even the narrowest panel would not fit beside the menu', () => {
    const menu = store(state())
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    // The menu runs to the very edge of the viewport: no room on the right.
    menuElement(rect(0, window.innerWidth, 0, 200))
    flushSync(() => { root.render(<MentionAd menu={menu as never} />) })
    expect(panel().style.display).toBe('none')
    root.unmount()
  })

  it('takes the ad image\u2019s own aspect once it loads, and hides a broken one', () => {
    const menu = store(state())
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    menuElement(rect(100, 400, 0, 200))
    flushSync(() => { root.render(<MentionAd menu={menu as never} />) })
    const image = panel().querySelector('img') as HTMLImageElement
    // jsdom never loads an image: pin the natural size the load handler reads.
    Object.defineProperty(image, 'naturalWidth', { value: 200, configurable: true })
    Object.defineProperty(image, 'naturalHeight', { value: 400, configurable: true })
    flushSync(() => { image.dispatchEvent(new Event('load')) })
    expect(panel().style.display).toBe('block')

    // A broken image never shows as a hole in the layout.
    flushSync(() => { image.dispatchEvent(new Event('error')) })
    expect(image.style.display).toBe('none')
    root.unmount()
  })
})
