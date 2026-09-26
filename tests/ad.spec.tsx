// @vitest-environment jsdom
/** Display-only side ad panel that flanks the @ menu: as tall as the menu;
 *  the male/pending ad sits on the menu's RIGHT (inside the plugin UI), the
 *  female/ready ad on the menu's LEFT (outside). Both images stay in the panel
 *  with visibility toggled (one at a time); width follows the ad's aspect at
 *  the menu's height; the panel shrinks to the available room or hides rather
 *  than ever overlapping the menu. */
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MentionAd } from '../src/client/AdPanel.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

function menuWith(status: 'pending' | 'ready'): MenuState {
  return {
    open: true,
    hit: { trigger: '@', query: 'view', position: 'leading', span: { start: 0, end: 5, draftRev: 1 } },
    generation: 1,
    groups: [{ source: 'atlas', status, items: status === 'ready' ? [{ name: 'a.ts', mentionKind: 'file' }] : [] }],
    highlight: null,
  }
}

function storeOf(state: () => MenuState): { store: ReturnType<typeof fakeStore>; notify: () => void } {
  let subscriber: (() => void) | undefined
  const store = fakeStore()
  const real = {
    ...store,
    getSnapshot: state,
    subscribe: (fn: () => void) => { subscriber = fn; return () => { subscriber = undefined } },
  }
  return { store: real, notify: () => subscriber?.() }
}

function fakeStore() {
  return { update: vi.fn(), set: vi.fn() }
}

function menuElement(rect?: { left?: number; right?: number; top?: number; height?: number }): HTMLElement {
  const listbox = document.createElement('div')
  listbox.setAttribute('role', 'listbox')
  // The real menu renders the group title / loading row with data-source, so
  // the ad matches the listbox in BOTH states (option rows exist only once ready).
  const groupTitle = document.createElement('div')
  groupTitle.setAttribute('data-source', 'atlas')
  listbox.appendChild(groupTitle)
  const row = document.createElement('button')
  row.id = 'dsh-slash-option-atlas-0'
  listbox.appendChild(row)
  document.body.appendChild(listbox)
  const left = rect?.left ?? 300
  const right = rect?.right ?? 700
  const top = rect?.top ?? 50
  const height = rect?.height ?? 200
  Object.defineProperty(listbox, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, right, top, bottom: top + height, width: right - left, height, x: left, y: top, toJSON: () => ({}) }),
  })
  return listbox
}

function renderAd(store: ReturnType<typeof storeOf>['store']): { root: ReturnType<typeof createRoot>; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => { root.render(<MentionAd menu={store as never} />) })
  return { root, container }
}

function imgs(container: HTMLElement): { panel: HTMLElement; pending: HTMLImageElement; ready: HTMLImageElement } {
  const panel = container.querySelector('[data-dsh-atlas-ad]') as HTMLElement
  return {
    panel,
    pending: panel.querySelector('img[data-state="false"]') as HTMLImageElement,
    ready: panel.querySelector('img[data-state="true"]') as HTMLImageElement,
  }
}

describe('MentionAd', () => {
  it('puts the male/pending ad on the RIGHT of the menu, as tall as the menu', () => {
    const { store, notify } = storeOf(() => menuWith('pending'))
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    const { panel, pending, ready } = imgs(container)
    expect(panel!.style.display).toBe('block')
    expect(pending!.style.display).toBe('block')
    expect(ready!.style.display).toBe('none')
    // menu right = 700 -> ad at 708; height = menu height 200; portrait width
    expect(panel!.style.height).toBe('200px')
    expect(panel!.style.width).toBe('133px')
    expect(panel!.style.left).toBe('708px')
    expect(panel!.style.top).toBe('50px')
    expect(pending!.src.startsWith('data:image/webp')).toBe(true)
    root.unmount()
    document.body.innerHTML = ''
  })

  it('puts the female/ready ad on the LEFT of the menu, as tall as the menu', () => {
    const { store, notify } = storeOf(() => menuWith('ready'))
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    const { panel, pending, ready } = imgs(container)
    expect(pending!.style.display).toBe('none')
    expect(ready!.style.display).toBe('block')
    expect(panel!.style.height).toBe('200px')
    // landscape ready ad: width = 200 x 16:9 = 356 -> capped 280; menu left =
    // 300 -> ad left = 300 - 8 - 280 = 12
    expect(panel!.style.width).toBe('280px')
    expect(panel!.style.left).toBe('12px')
    expect(panel!.style.top).toBe('50px')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('keeps the male/pending ad for the empty @ even when the group is ready', () => {
    // The pinned categories alone are not a "match list": the male/pending ad
    // stays until the user actually types a query.
    const empty: MenuState = { ...menuWith('ready'), hit: { ...menuWith('ready').hit, query: '' } }
    const { store, notify } = storeOf(() => empty)
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    const { pending, ready } = imgs(container)
    expect(pending!.style.display).toBe('block')
    expect(ready!.style.display).toBe('none')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('keeps the female ad while a new search loads (no flicker)', () => {
    let state: MenuState = menuWith('ready')
    const { store, notify } = storeOf(() => state)
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    let { pending, ready } = imgs(container)
    expect(ready!.style.display).toBe('block')
    // The group resets to pending on every keystroke; the female ad must stay.
    state = { ...menuWith('ready'), groups: [{ source: 'atlas', status: 'pending', items: [] }] }
    notify()
    flushSync(() => {})
    ;({ pending, ready } = imgs(container))
    expect(ready!.style.display).toBe('block')
    expect(pending!.style.display).toBe('none')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('switches to the female ad only when the list becomes ready', () => {
    let state: MenuState = menuWith('pending')
    const { store, notify } = storeOf(() => state)
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    let { pending, ready } = imgs(container)
    expect(pending!.style.display).toBe('block')
    // Loading -> ready: the ad switches once, to the female image.
    state = menuWith('ready')
    notify()
    flushSync(() => {})
    ;({ pending, ready } = imgs(container))
    expect(pending!.style.display).toBe('none')
    expect(ready!.style.display).toBe('block')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('switches back to the male ad when the query is cleared', () => {
    let state: MenuState = menuWith('ready')
    const { store, notify } = storeOf(() => state)
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    let { pending, ready } = imgs(container)
    expect(ready!.style.display).toBe('block')
    // Clearing the query returns to the empty @ (categories only): male again.
    state = { ...menuWith('ready'), hit: { ...menuWith('ready').hit, query: '' } }
    notify()
    flushSync(() => {})
    ;({ pending, ready } = imgs(container))
    expect(pending!.style.display).toBe('block')
    expect(ready!.style.display).toBe('none')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('shrinks the male ad to the room right of the menu', () => {
    const { store, notify } = storeOf(() => menuWith('pending'))
    menuElement({ left: 300, right: 940, top: 50, height: 200 })
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    const { panel } = imgs(container)
    // right room = 1024 - 16 - 940 = 68 < 133 -> shrink to 68
    expect(panel!.style.left).toBe('948px')
    expect(panel!.style.width).toBe('68px')
    expect(panel!.style.display).toBe('block')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('shrinks the female ad to the room left of the menu', () => {
    const { store, notify } = storeOf(() => menuWith('ready'))
    menuElement({ left: 100, right: 700, top: 50, height: 200 })
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    const { panel } = imgs(container)
    // left room = 100 - 16 = 84 < 280 -> shrink to 84, ad left = 100 - 8 - 84 = 8
    expect(panel!.style.left).toBe('8px')
    expect(panel!.style.width).toBe('84px')
    expect(panel!.style.display).toBe('block')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('hides when there is no room on the chosen side', () => {
    const { store, notify } = storeOf(() => menuWith('pending'))
    menuElement({ left: 300, right: 1020, top: 50, height: 200 })
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    const { panel } = imgs(container)
    // right room = 1024 - 16 - 1020 = -12 < 64 -> no room: hide
    expect(panel!.style.display).toBe('none')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('hides when the menu closes', () => {
    let state: MenuState = menuWith('ready')
    const { store, notify } = storeOf(() => state)
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    state = { ...state, open: false }
    notify()
    flushSync(() => {})
    const { panel } = imgs(container)
    expect(panel!.style.display).toBe('none')
    root.unmount()
    document.body.innerHTML = ''
  })

  it('hides when the @ trigger is not the active menu group', () => {
    const other: MenuState = { ...menuWith('ready'), groups: [{ source: 'slash', status: 'ready', items: [] }] }
    const { store, notify } = storeOf(() => other)
    menuElement()
    const { root, container } = renderAd(store)
    notify()
    flushSync(() => {})
    const { panel } = imgs(container)
    expect(panel!.style.display).toBe('none')
    root.unmount()
    document.body.innerHTML = ''
  })
})
