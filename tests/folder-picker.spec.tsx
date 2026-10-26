// @vitest-environment jsdom
/**
 * The folder chooser is a two-group tree rather than a flat list: the frequent
 * folders are their own group (collapsed until it is opened or filtered), the
 * current folder is a group that is open by default, and a folder inside it
 * expands IN PLACE. These tests pin the contract that makes that usable:
 *
 * - which Enter adopts and which Enter expands (m01028 2.4.a / 2.4.b),
 * - that a "selection" shortcut really writes the reference (m01272),
 * - that expanding never moves the current row — only Up/Down does (m01272),
 * - that walking past the last visible row turns the page instead of stopping
 *   (m01272),
 * - and that the needle from the path line and the characters typed in the list
 *   filter BOTH groups at once (m01028 2.2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { FolderPicker } from '../src/client/FolderPicker.tsx'
import type { FolderPickerProps, PickerListing, PickerPreset } from '../src/client/FolderPicker.tsx'
import { fmt, zh } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

beforeEach(() => {
  // The dialog is portaled to <body>, so a leftover one would be found by the
  // next test's queries: the cleanup has to clear the whole of it, not just a slot.
  document.body.innerHTML = ''
})

const realRect = Element.prototype.getBoundingClientRect
const realScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect
  if (realScrollTop !== undefined) Object.defineProperty(Element.prototype, 'scrollTop', realScrollTop)
})

const t = (key: string, params?: Record<string, string>): string => fmt(zh[key] ?? key, params)

/** One folder of a fixture level. `hasChildren` is omitted to mean "the Host did not say". */
const entry = (name: string, path: string, hidden = false, hasChildren?: boolean): PickerListing['entries'][number] =>
  ({ name, path, hidden, ...(hasChildren === undefined ? {} : { hasChildren }) })

const crumbs = (...paths: readonly string[]): PickerListing['crumbs'] =>
  paths.map((path) => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    return entry(name === '' ? path : name, path)
  })

const LEVELS: Record<string, PickerListing> = {
  'E:/': {
    path: 'E:/',
    home: '',
    crumbs: [],
    truncated: false,
    drives: ['C:/', 'D:/', 'E:/'],
    entries: [
      entry('Rust', 'E:/Rust', false, true),
      entry('Games', 'E:/Games', false, false),
      entry('Probe', 'E:/Probe'),
      entry('Empty', 'E:/Empty'),
    ],
  },
  'E:/Rust': {
    path: 'E:/Rust',
    home: '',
    crumbs: crumbs('E:/Rust'),
    truncated: false,
    parent: 'E:/',
    entries: [entry('DSH', 'E:/Rust/DSH', false, true), entry('.cache', 'E:/Rust/.cache', true, true)],
  },
  'E:/Rust/DSH': {
    path: 'E:/Rust/DSH',
    home: '',
    crumbs: crumbs('E:/Rust', 'E:/Rust/DSH'),
    truncated: false,
    parent: 'E:/Rust',
    entries: [entry('dsh-atlas', 'E:/Rust/DSH/dsh-atlas', false, false)],
  },
  'E:/Probe': {
    path: 'E:/Probe',
    home: '',
    crumbs: crumbs('E:/Probe'),
    truncated: false,
    parent: 'E:/',
    entries: [entry('Inside', 'E:/Probe/Inside', false, false)],
  },
  '/home/ubuntu': {
    path: '/home/ubuntu',
    home: '',
    crumbs: crumbs('/home/ubuntu'),
    truncated: false,
    parent: '/home',
    entries: [],
  },
  'E:/Empty': {
    path: 'E:/Empty',
    home: '',
    crumbs: crumbs('E:/Empty'),
    truncated: false,
    parent: 'E:/',
    entries: [],
  },
  'E:/New': {
    path: 'E:/New',
    home: '',
    crumbs: crumbs('E:/New'),
    truncated: false,
    parent: 'E:/',
    entries: [],
  },
}

const levelOf = (path: string): PickerListing => {
  const found = LEVELS[path]
  if (found === undefined) throw new Error(`the fixture has no level for ${path}`)
  return found
}

/** A level with `count` leaf folders: enough rows to overflow a 100px list. */
const crowdedLevel = (count: number): PickerListing => ({
  ...levelOf('E:/'),
  entries: Array.from({ length: count }, (_unused, index) =>
    entry(`Folder${String(index + 1)}`, `E:/Folder${String(index + 1)}`, false, false)),
})

const preset = (name: string, path: string): PickerPreset => ({ name, path, reason: 'recent' })

const PRESETS: readonly PickerPreset[] = [preset('Work', 'D:/Work'), preset('Other', 'E:/Other')]

interface MountOptions {
  readonly browse?: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>
  readonly list?: (path: string, signal: AbortSignal) => Promise<PickerListing>
  readonly recent?: (signal: AbortSignal) => Promise<readonly PickerPreset[]>
  readonly create?: (path: string, name: string) => Promise<string>
  /** Whether the shell closes the dialog the way it really does when a pick lands. */
  readonly closesOnConfirm?: boolean
}

interface Harness {
  readonly container: HTMLElement
  readonly slot: HTMLElement
  readonly browse: ReturnType<typeof vi.fn>
  readonly list: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
  readonly confirm: ReturnType<typeof vi.fn>
  readonly close: ReturnType<typeof vi.fn>
  readonly unmount: () => void
}

function mount(options: MountOptions = {}): Harness {
  const container = document.body
  const slot = document.createElement('div')
  container.append(slot)
  const root = createRoot(slot)
  let open = true
  const browse = vi.fn(options.browse ?? ((path: string | undefined) => Promise.resolve(path === undefined ? levelOf('E:/') : levelOf(path))))
  const list = vi.fn(options.list ?? ((path: string) => Promise.resolve(levelOf(path))))
  const recent = vi.fn(options.recent ?? (() => Promise.resolve([] as readonly PickerPreset[])))
  const create = vi.fn(options.create ?? ((_path: string, name: string) => Promise.resolve(`E:/${name}`)))
  const confirm = vi.fn((_path: string) => {
    // A real shell closes the overlay on a pick; several tests need that to be
    // observable, and the rest assert the call without it.
    if (options.closesOnConfirm === true) { open = false; draw() }
  })
  const close = vi.fn(() => { open = false; draw() })
  const props = {
    // The overlay seat's hook, standing in for the shell's observable: the dialog
    // only ever asks whether a pick is pending.
    useFolderPicker: (selector: (snapshot: { readonly value: unknown | null }) => unknown): unknown =>
      selector({ value: open ? { kind: 'folder' } : null }),
    browse: (path: string | undefined, signal: AbortSignal) => browse(path, signal),
    list: (path: string | undefined, signal: AbortSignal) => list(path, signal),
    create: (path: string, name: string) => create(path, name),
    recent: (signal: AbortSignal) => recent(signal),
    confirm: (path: string) => { confirm(path) },
    close: () => { close() },
    t,
    hooks: {},
  } as unknown as FolderPickerProps
  // `draw` is a declaration so `confirm`/`close` above may call it while the props
  // they close over are still being built.
  function draw(): void {
    flushSync(() => { root.render(<FolderPicker {...props} />) })
  }
  draw()
  return { container, slot, browse, list, create, confirm, close, unmount: () => { root.unmount() } }
}

// ---------------------------------------------------------------------------
// Reading the screen
// ---------------------------------------------------------------------------

const dialog = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('[data-atlas-folder-picker]')
  if (found === null) throw new Error('no dialog on screen')
  return found
}
const onScreen = (container: HTMLElement): boolean => container.querySelector('[data-atlas-folder-picker]') !== null
const pathInput = (container: HTMLElement): HTMLInputElement => {
  const found = dialog(container).querySelector<HTMLInputElement>('.dsh_atlas_pickerInput')
  if (found === null) throw new Error('no path line on screen')
  return found
}
const listBox = (container: HTMLElement): HTMLElement => {
  const found = dialog(container).querySelector<HTMLElement>('.dsh_atlas_pickerList')
  if (found === null) throw new Error('no list on screen')
  return found
}
const nameOf = (row: HTMLElement): string => row.querySelector('.dsh_atlas_pickerName')?.textContent ?? ''
const rows = (container: HTMLElement): readonly HTMLElement[] =>
  [...dialog(container).querySelectorAll<HTMLElement>('.dsh_atlas_pickerRow')]
const rowNames = (container: HTMLElement): readonly string[] => rows(container).map(nameOf)
const rowNamed = (container: HTMLElement, name: string): HTMLElement => {
  const found = rows(container).find(row => nameOf(row) === name)
  if (found === undefined) throw new Error(`no row named ${name}; the rows are ${rowNames(container).join(', ')}`)
  return found
}
/** The current row, read from the aria state rather than the highlight class: the class only exists while the list holds focus. */
const currentRow = (container: HTMLElement): HTMLElement | undefined =>
  rows(container).find(row => row.getAttribute('aria-selected') === 'true')
const currentName = (container: HTMLElement): string => {
  const found = currentRow(container)
  return found === undefined ? '' : nameOf(found)
}
const notes = (container: HTMLElement): readonly string[] =>
  [...dialog(container).querySelectorAll<HTMLElement>('.dsh_atlas_pickerNote')].map(note => note.textContent ?? '')
const crumbNames = (container: HTMLElement): readonly string[] =>
  [...dialog(container).querySelectorAll<HTMLElement>('.dsh_atlas_pickerCrumb')].map(crumb => crumb.textContent ?? '')
const expandedOf = (container: HTMLElement, name: string): string | null =>
  rowNamed(container, name).getAttribute('aria-expanded')
const levelOfRow = (container: HTMLElement, name: string): string | null =>
  rowNamed(container, name).getAttribute('aria-level')
const buttonWith = (container: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...dialog(container).querySelectorAll<HTMLButtonElement>('button')]
    .find(button => (button.textContent ?? '').includes(text))
  if (found === undefined) throw new Error(`no button containing ${text}`)
  return found
}

// ---------------------------------------------------------------------------
// Driving it
// ---------------------------------------------------------------------------

/** Two flushes: the first runs the update, the second the passive effects it scheduled (paging included). */
const flushed = (work: () => void): void => {
  flushSync(work)
  flushSync(() => {})
}

function press(container: HTMLElement, key: string, init: KeyboardEventInit = {}, zone: 'path' | 'list' = 'list'): void {
  const target: HTMLElement = zone === 'path' ? pathInput(container) : listBox(container)
  flushed(() => { target.focus() })
  flushed(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

const click = (element: HTMLElement): void => {
  flushed(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
/** Where the simulated pointer is; every hover moves it, the way a real one would. */
const pointer = { x: 0, y: 0 }
/** Dispatch a hover at exactly this position. */
const hoverAt = (element: HTMLElement, clientX: number, clientY: number): void => {
  flushed(() => {
    // A real pointer sends both; jsdom delivers neither unless we dispatch them.
    element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX, clientY }))
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX, clientY }))
  })
}
const hover = (element: HTMLElement): void => {
  pointer.x += 17
  pointer.y += 17
  hoverAt(element, pointer.x, pointer.y)
}

/** Set a controlled input the way a browser does: the native setter, then the event React listens for. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  flushed(() => {
    input.focus()
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const typePath = (container: HTMLElement, value: string): void => { typeInto(pathInput(container), value) }

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise(resolve => { setTimeout(resolve, 0) })
    flushSync(() => {})
  }
}

/** The path line browses after a pause; only that timer is faked, so the promise chain still resolves for real. */
async function typePathAndSettle(container: HTMLElement, value: string): Promise<void> {
  vi.useFakeTimers()
  try {
    typePath(container, value)
    await vi.advanceTimersByTimeAsync(300)
  } finally {
    vi.useRealTimers()
  }
  await settle()
}

function step(container: HTMLElement, count: number, key = 'ArrowDown'): void {
  for (let index = 0; index < count; index += 1) press(container, key)
}

/** Walk the cursor onto a row that is BELOW the current one. */
function moveTo(container: HTMLElement, name: string): void {
  for (let tries = 0; tries < 80; tries += 1) {
    if (currentName(container) === name) return
    press(container, 'ArrowDown')
  }
  throw new Error(`moveTo: never reached ${name}; the rows are ${rowNames(container).join(', ')}`)
}

/** Walk the cursor onto a row that is ABOVE the current one. */
function moveBackTo(container: HTMLElement, name: string): void {
  for (let tries = 0; tries < 80; tries += 1) {
    if (currentName(container) === name) return
    press(container, 'ArrowUp')
  }
  throw new Error(`moveBackTo: never reached ${name}; the rows are ${rowNames(container).join(', ')}`)
}

interface ListScroll { readonly scrollTop: () => number }

/**
 * Give the list a real shape: 100px tall, rows 20px each, already scrolled by
 * `initial`. jsdom reports zeros for every box — and has no layout for `scrollTop`
 * either — and the dialog correctly does nothing with a list that has not been laid
 * out, so the paging rule is only observable once the geometry exists.
 *
 * The dialog scrolls the list itself rather than calling `scrollIntoView` on the
 * row: that one scrolls every scrollable ancestor, which would drag the shell along.
 * So the observable is the list's own `scrollTop`.
 */
function stubGeometry(initial = 0): ListScroll {
  const visible = { top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: 0 }
  const boxed = (shape: Partial<DOMRect>): DOMRect => ({ ...visible, ...shape } as DOMRect)
  let scrolled = initial
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.classList.contains('dsh_atlas_pickerList')) return boxed({})
    const parent = this.parentElement
    if (parent === null || !parent.classList.contains('dsh_atlas_pickerList')) return boxed({ top: 0, bottom: 0, height: 0 })
    const index = [...parent.children].indexOf(this)
    const top = index * 20 - scrolled
    return boxed({ top, bottom: top + 20, height: 20 })
  }
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element): number { return this.classList.contains('dsh_atlas_pickerList') ? scrolled : 0 },
    set(this: Element, value: number): void {
      if (this.classList.contains('dsh_atlas_pickerList')) scrolled = Math.max(0, value)
    },
  })
  return { scrollTop: () => scrolled }
}

/** Open the frequent group with Enter and wait for its rows. */
async function openPresets(harness: Harness): Promise<void> {
  press(harness.container, 'Enter')
  await settle()
}

// ---------------------------------------------------------------------------
// 1.1 / 1.2 — two groups, one of them collapsed to start with
// ---------------------------------------------------------------------------

describe('the chooser opens as two groups', () => {
  it('shows the frequent folders as their own group, closed, above the current folder', async () => {
    const harness = mount({ recent: () => Promise.resolve(PRESETS) })
    await settle()
    expect(rowNames(harness.container)).toEqual([
      t('picker.group.presets'),
      t('picker.group.current'),
      'C:/', 'D:/', 'E:/',
      'Rust', 'Games', 'Probe', 'Empty',
    ])
    expect(expandedOf(harness.container, t('picker.group.presets'))).toBe('false')
    expect(expandedOf(harness.container, t('picker.group.current'))).toBe('true')
  })

  it('keeps the frequent folders out of the tree until the group is opened', async () => {
    const harness = mount({ recent: () => Promise.resolve(PRESETS) })
    await settle()
    expect(rowNames(harness.container)).not.toContain('Work')
  })

  it('opens the frequent group on Enter and shows its folders one level in, without moving the cursor', async () => {
    const harness = mount({ recent: () => Promise.resolve(PRESETS) })
    await settle()
    expect(currentName(harness.container)).toBe(t('picker.group.presets'))
    await openPresets(harness)
    expect(rowNames(harness.container).slice(0, 4)).toEqual([
      t('picker.group.presets'), 'Work', 'Other', t('picker.group.current'),
    ])
    expect(currentName(harness.container)).toBe(t('picker.group.presets'))
    expect(expandedOf(harness.container, t('picker.group.presets'))).toBe('true')
  })

  it('marks a frequent folder as a preset and shows where it is', async () => {
    const harness = mount({ recent: () => Promise.resolve(PRESETS) })
    await settle()
    await openPresets(harness)
    const row = rowNamed(harness.container, 'Work')
    expect(row.querySelector('.dsh_atlas_pickerTag')).not.toBeNull()
    expect(row.textContent).toContain('D:/Work')
  })

  it('says so when there is nothing frequent to offer', async () => {
    const harness = mount()
    await settle()
    await openPresets(harness)
    expect(notes(harness.container)).toContain(t('picker.group.none'))
    expect(rows(harness.container).some(row => nameOf(row) === t('picker.group.none'))).toBe(false)
  })

  it('shows no drive crumb where the Host offers no drives', async () => {
    const harness = mount({
      browse: () => Promise.resolve({ ...levelOf('E:/Rust'), drives: undefined, parent: undefined, entries: [entry('DSH', 'E:/Rust/DSH', false, true)] }),
    })
    await settle()
    expect(crumbNames(harness.container)).toEqual(['Rust'])
  })
})

// ---------------------------------------------------------------------------
// 2.4 — Enter adopts or expands, and never does both
// ---------------------------------------------------------------------------

describe('Enter adopts or expands', () => {
  it('adopts a frequent folder — the row that used to only walk away', async () => {
    const harness = mount({ recent: () => Promise.resolve(PRESETS), closesOnConfirm: true })
    await settle()
    await openPresets(harness)
    moveTo(harness.container, 'Work')
    press(harness.container, 'Enter')
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('D:/Work')
    expect(onScreen(harness.container)).toBe(false)
  })

  it('adopts the folder the current row NAMES on Ctrl+Enter, not the level it is displayed in', async () => {
    const harness = mount({ recent: () => Promise.resolve(PRESETS) })
    await settle()
    await openPresets(harness)
    moveTo(harness.container, 'Work')
    press(harness.container, 'Enter', { ctrlKey: true })
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('D:/Work')
  })

  it('expands a folder that has children in place, and leaves the cursor on that row', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Rust')
    press(harness.container, 'Enter')
    await settle()
    expect(rowNames(harness.container)).toContain('DSH')
    expect(currentName(harness.container)).toBe('Rust')
    expect(expandedOf(harness.container, 'Rust')).toBe('true')
    expect(levelOfRow(harness.container, 'DSH')).toBe('3')
  })

  it('collapses it with the same Enter, again without moving the cursor', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Rust')
    press(harness.container, 'Enter')
    await settle()
    press(harness.container, 'Enter')
    await settle()
    expect(rowNames(harness.container)).not.toContain('DSH')
    expect(currentName(harness.container)).toBe('Rust')
    expect(expandedOf(harness.container, 'Rust')).toBe('false')
  })

  it('adopts a folder with no children instead of expanding it', async () => {
    const harness = mount({ closesOnConfirm: true })
    await settle()
    moveTo(harness.container, 'Games')
    press(harness.container, 'Enter')
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/Games')
    expect(harness.list).not.toHaveBeenCalledWith('E:/Games', expect.anything())
    expect(onScreen(harness.container)).toBe(false)
  })

  it('looks before it decides when the Host did not answer hasChildren, then expands', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Probe')
    press(harness.container, 'Enter')
    await settle()
    expect(harness.list).toHaveBeenCalledWith('E:/Probe', expect.anything())
    expect(rowNames(harness.container)).toContain('Inside')
    expect(currentName(harness.container)).toBe('Probe')
  })

  it('collapses a folder it had to look at first, on the second Enter (m05904)', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Probe')
    press(harness.container, 'Enter')
    await settle()
    expect(rowNames(harness.container)).toContain('Inside')
    // The row is open now, so Enter is the collapse verb even though the Host never
    // answered `hasChildren` for it: asking again could only ever expand it a second
    // time, which is what made Enter on an open folder look broken.
    press(harness.container, 'Enter')
    await settle()
    expect(rowNames(harness.container)).not.toContain('Inside')
    expect(expandedOf(harness.container, 'Probe')).toBe('false')
    expect(currentName(harness.container)).toBe('Probe')
    expect(harness.list).toHaveBeenCalledTimes(1)
  })

  it('adopts an unanswered folder that turns out to be empty', async () => {
    const harness = mount({ closesOnConfirm: true })
    await settle()
    moveTo(harness.container, 'Empty')
    press(harness.container, 'Enter')
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/Empty')
    expect(onScreen(harness.container)).toBe(false)
  })

  it('adopts an expandable folder on Ctrl+Enter rather than expanding it', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Rust')
    press(harness.container, 'Enter', { ctrlKey: true })
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/Rust')
    expect(rowNames(harness.container)).not.toContain('DSH')
  })

  it('adopts the level you are already in when Ctrl+Enter is pressed on the group header', async () => {
    const harness = mount()
    await settle()
    expect(currentName(harness.container)).toBe(t('picker.group.presets'))
    press(harness.container, 'Enter', { ctrlKey: true })
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/')
  })

  it('offers the way up inside the current group, and adopts that root on Ctrl+Enter', async () => {
    const harness = mount()
    await settle()
    await typePathAndSettle(harness.container, 'E:/Rust')
    expect(rowNames(harness.container)).toContain(t('picker.up'))
    moveTo(harness.container, t('picker.up'))
    press(harness.container, 'Enter', { ctrlKey: true })
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/')
  })

  it('changes the level with Enter on the way up instead of adopting it', async () => {
    const harness = mount()
    await settle()
    await typePathAndSettle(harness.container, 'E:/Rust')
    moveTo(harness.container, t('picker.up'))
    press(harness.container, 'Enter')
    await settle()
    expect(harness.confirm).not.toHaveBeenCalled()
    expect(pathInput(harness.container).value).toBe('E:/')
  })
})

// ---------------------------------------------------------------------------
// m01272 — the current row only changes when the user moves it
// ---------------------------------------------------------------------------

describe('the current row moves only on Up and Down', () => {
  it('stays put across expand, collapse and a look-before-deciding probe', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Rust')
    press(harness.container, 'Enter')
    await settle()
    expect(currentName(harness.container)).toBe('Rust')
    press(harness.container, 'Enter')
    await settle()
    expect(currentName(harness.container)).toBe('Rust')
    moveTo(harness.container, 'Probe')
    press(harness.container, 'Enter')
    await settle()
    expect(currentName(harness.container)).toBe('Probe')
  })

  it('clamps at both ends instead of wrapping around', async () => {
    const harness = mount()
    await settle()
    expect(currentName(harness.container)).toBe(t('picker.group.presets'))
    press(harness.container, 'ArrowUp')
    expect(currentName(harness.container)).toBe(t('picker.group.presets'))
    press(harness.container, 'End')
    expect(currentName(harness.container)).toBe('Empty')
    press(harness.container, 'ArrowDown')
    expect(currentName(harness.container)).toBe('Empty')
  })

  it('reaches the first and last row with Home and End', async () => {
    const harness = mount()
    await settle()
    press(harness.container, 'End')
    expect(currentName(harness.container)).toBe('Empty')
    press(harness.container, 'Home')
    expect(currentName(harness.container)).toBe(t('picker.group.presets'))
  })

  it('follows the row by identity, so a list that grows under it does not drift', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Games')
    // Expanding Rust inserts a row above nothing and below the cursor's row: a
    // positional cursor would land on the inserted child instead of the next row.
    click(rowNamed(harness.container, 'Rust'))
    await settle()
    expect(currentName(harness.container)).toBe('Rust')
    press(harness.container, 'ArrowDown')
    expect(currentName(harness.container)).toBe('DSH')
  })

  it('lets the pointer choose the row', async () => {
    const harness = mount()
    await settle()
    hover(rowNamed(harness.container, 'Games'))
    // A pointer move is a continuous-priority event, so React schedules the state
    // update rather than running it inside the dispatch: let the browser turn come.
    await settle()
    expect(currentName(harness.container)).toBe('Games')
    hover(rowNamed(harness.container, 'Rust'))
    await settle()
    expect(currentName(harness.container)).toBe('Rust')
  })

  it('ignores a hover that the scroll re-targeted under a pointer that never moved', async () => {
    const harness = mount()
    await settle()
    hover(rowNamed(harness.container, 'Games'))
    await settle()
    expect(currentName(harness.container)).toBe('Games')
    // Turning the page slides another row under a still pointer and the browser
    // reports that as the new row's `mouseover` — carrying the SAME coordinates.
    // Believed, it hands the current row to whatever landed under the mouse, which
    // is how a walk to the last row used to be hijacked by the row at the top.
    hoverAt(rowNamed(harness.container, 'Rust'), pointer.x, pointer.y)
    await settle()
    expect(currentName(harness.container)).toBe('Games')
  })

  it('runs the row\u2019s own verb on a click', async () => {
    const harness = mount({ closesOnConfirm: true })
    await settle()
    click(rowNamed(harness.container, 'Games'))
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/Games')
    expect(onScreen(harness.container)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// m01272 — walking past the last visible row turns the page
// ---------------------------------------------------------------------------

describe('walking past the viewport turns the page', () => {
  /** The rows the list actually shows, read from the stubbed geometry. */
  const shown = (container: HTMLElement): readonly string[] => {
    const box = listBox(container).getBoundingClientRect()
    return rows(container)
      .filter(row => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > box.top && rect.top < box.bottom
      })
      .map(nameOf)
  }

  it('keeps the row that was last on the page as the first row of the next', async () => {
    const scroll = stubGeometry()
    const harness = mount({ browse: () => Promise.resolve(crowdedLevel(8)) })
    await settle()
    step(harness.container, 5)
    expect(currentName(harness.container)).toBe('Folder1')
    // A whole page would have hidden E:/ — the row the cursor came from. Stopping one
    // row short keeps it on the first line and puts the cursor on the second, so the
    // two pages visibly meet and the user can read where they are (m05904).
    expect(scroll.scrollTop()).toBe(80)
    expect(shown(harness.container)).toEqual(['E:/', 'Folder1', 'Folder2', 'Folder3', 'Folder4'])
  })

  it('mirrors that rule walking up, with the row it left ending the page above', async () => {
    const scroll = stubGeometry()
    const harness = mount({ browse: () => Promise.resolve(crowdedLevel(8)) })
    await settle()
    press(harness.container, 'End')
    expect(currentName(harness.container)).toBe('Folder8')
    // The same one-row-short page as going down: Folder7, the last row of the page we
    // left, holds the first line and the cursor takes the second.
    expect(scroll.scrollTop()).toBe(220)
    expect(shown(harness.container)).toEqual(['Folder7', 'Folder8'])
    press(harness.container, 'ArrowUp')
    expect(currentName(harness.container)).toBe('Folder7')
    expect(scroll.scrollTop()).toBe(220)
    press(harness.container, 'ArrowUp')
    expect(currentName(harness.container)).toBe('Folder6')
    // Mirror image: Folder7 — the row the cursor just left — is the last line of the
    // page above and the cursor sits on the line before it, so the row above the
    // viewport is on screen and the two pages meet going up as well.
    expect(scroll.scrollTop()).toBe(140)
    expect(shown(harness.container)).toEqual(['Folder3', 'Folder4', 'Folder5', 'Folder6', 'Folder7'])
  })

  it('leaves a row that is already on screen alone', async () => {
    const scroll = stubGeometry()
    const harness = mount({ browse: () => Promise.resolve(crowdedLevel(8)) })
    await settle()
    step(harness.container, 3)
    expect(scroll.scrollTop()).toBe(0)
  })

  it('does nothing about paging while the list has no layout', async () => {
    const harness = mount()
    await settle()
    expect(() => { press(harness.container, 'ArrowDown') }).not.toThrow()
    expect(currentName(harness.container)).toBe(t('picker.group.current'))
  })
})

// ---------------------------------------------------------------------------
// 2.1 / 2.2 / 2.3 — the path line and the filter
// ---------------------------------------------------------------------------

describe('the path line browses what was typed', () => {
  /** The Host answers the longest valid prefix, and says what was actually asked for. */
  const partial = (path: string | undefined): Promise<PickerListing> => {
    if (path === undefined) return Promise.resolve(levelOf('E:/'))
    const exact = LEVELS[path]
    if (exact !== undefined) return Promise.resolve(exact)
    return Promise.resolve({ ...levelOf(path.slice(0, path.lastIndexOf('/') + 1)), requested: path })
  }

  it('converges on the level it could list when Enter is pressed in the line', async () => {
    const harness = mount({ browse: partial })
    await settle()
    await typePathAndSettle(harness.container, 'E:/Ru')
    expect(harness.browse).toHaveBeenCalledWith('E:/Ru', expect.anything())
    expect(pathInput(harness.container).value).toBe('E:/Ru')
    expect(notes(harness.container).some(note => note.includes('Ru'))).toBe(true)
    press(harness.container, 'Enter', {}, 'path')
    await settle()
    expect(pathInput(harness.container).value).toBe('E:/')
    expect(rowNames(harness.container)).toContain('Games')
  })

  it('keeps the typed text in the line even though the Host answered a shorter path', async () => {
    const harness = mount({ browse: partial })
    await settle()
    await typePathAndSettle(harness.container, 'E:/Ru')
    expect(pathInput(harness.container).value).toBe('E:/Ru')
  })

  it('takes the needle from the Host\u2019s answer rather than re-parsing the line', async () => {
    const harness = mount({
      browse: () => Promise.resolve({ ...levelOf('E:/Rust'), requested: 'E:/Rust/DS' }),
    })
    await settle()
    await typePathAndSettle(harness.container, 'E:/Rust/DS')
    expect(harness.browse).toHaveBeenCalledWith('E:/Rust/DS', expect.anything())
    expect(rowNames(harness.container)).toContain('DSH')
    expect(rowNames(harness.container)).not.toContain('Games')
    expect(notes(harness.container).some(note => note.includes('DS'))).toBe(true)
  })

  it('filters BOTH groups at once and forces the closed one open', async () => {
    const harness = mount({
      recent: () => Promise.resolve([preset('Rust Tools', 'D:/RustTools'), preset('Docs', 'D:/Docs')]),
      browse: (path: string | undefined) => Promise.resolve(path === undefined ? levelOf('E:/') : ({ ...levelOf('E:/'), requested: 'E:/r' })),
    })
    await settle()
    await typePathAndSettle(harness.container, 'E:/r')
    expect(expandedOf(harness.container, t('picker.group.presets'))).toBe('true')
    expect(rowNames(harness.container)).toContain('Rust Tools')
    expect(rowNames(harness.container)).not.toContain('Docs')
    expect(rowNames(harness.container)).toContain('Rust')
    expect(rowNames(harness.container)).not.toContain('Games')
  })

  it('moves the keyboard into the list with the arrow keys', async () => {
    const harness = mount()
    await settle()
    press(harness.container, 'ArrowDown', {}, 'path')
    expect(currentName(harness.container)).toBe(t('picker.group.presets'))
    press(harness.container, 'ArrowUp', {}, 'path')
    expect(currentName(harness.container)).toBe('Empty')
  })

  it('filters on a keystroke in the list without any I/O', async () => {
    const harness = mount()
    await settle()
    const before = harness.browse.mock.calls.length
    press(harness.container, 'G')
    expect(harness.browse.mock.calls.length).toBe(before)
    expect(rowNames(harness.container)).toContain('Games')
    expect(rowNames(harness.container)).not.toContain('Rust')
  })

  it('deletes a filter character before it leaves the level', async () => {
    const harness = mount()
    await settle()
    await typePathAndSettle(harness.container, 'E:/Rust')
    expect(pathInput(harness.container).value).toBe('E:/Rust')
    press(harness.container, 'D')
    expect(rowNames(harness.container)).toContain('DSH')
    expect(rowNames(harness.container)).not.toContain(t('picker.up'))
    press(harness.container, 'Backspace')
    expect(rowNames(harness.container)).toContain(t('picker.up'))
  })

  it('leaves the level with Backspace once the filter is empty', async () => {
    const harness = mount()
    await settle()
    await typePathAndSettle(harness.container, 'E:/Rust')
    press(harness.container, 'Backspace')
    await settle()
    expect(pathInput(harness.container).value).toBe('E:/')
    expect(harness.browse).toHaveBeenCalledWith('E:/', expect.anything())
  })

  it('hides hidden folders until the checkbox is on', async () => {
    const harness = mount()
    await settle()
    await typePathAndSettle(harness.container, 'E:/Rust')
    expect(rowNames(harness.container)).not.toContain('.cache')
    const checkbox = dialog(harness.container).querySelector<HTMLInputElement>('.dsh_atlas_pickerToggle input')
    if (checkbox === null) throw new Error('no show-hidden checkbox')
    flushed(() => { checkbox.click() })
    expect(rowNames(harness.container)).toContain('.cache')
  })
})

// ---------------------------------------------------------------------------
// The layer Escape unwinds, and the rest of the small gestures
// ---------------------------------------------------------------------------

/** Submit the new-folder form the way the browser does, through its own event. */
function submit(where: HTMLElement): void {
  const form = where.querySelector('.dsh_atlas_pickerNewRow') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

describe('the note under a filtered list', () => {
  it('says the filter matched nothing, in place of the rows', async () => {
    const full = mount()
    await settle()
    // Two keystrokes build a filter that no folder matches; the list says so
    // instead of going blank.
    press(full.container, 'z')
    press(full.container, 'z')
    await settle()
    expect(dialog(full.container).textContent).toContain(t('picker.noMatch'))
  })
})

describe('the crumbs that jump', () => {
  it('walks to the home folder when the Host names one and offers no drives', async () => {
    const harness = mount({
      browse: ((path: string | undefined) => Promise.resolve({
        ...levelOf(path ?? 'E:/'),
        home: '/home/ubuntu',
        drives: undefined,
      })) as MountOptions['browse'],
    })
    await settle()
    const home = buttonWith(harness.container, t('picker.home'))
    expect(home).not.toBeNull()
    click(home)
    await settle()
    const levels = [...harness.browse.mock.calls, ...harness.list.mock.calls].map(call => call[0])
    expect(levels).toContain('/home/ubuntu')
  })

  it('offers the drive list only where the Host names drives, and it re-walks that level', async () => {
    const harness = mount({
      browse: ((path: string | undefined) => Promise.resolve({
        ...levelOf(path ?? 'E:/'),
        home: '',
        drives: ['C:/', 'E:/'],
      })) as MountOptions['browse'],
    })
    await settle()
    const drives = buttonWith(harness.container, t('picker.drives'))
    expect(drives).not.toBeNull()
    const before = harness.browse.mock.calls.length
    click(drives)
    await settle()
    // The crumb re-walks the level it is on (a POSIX top level answers `drives: []`,
    // and this crumb used to appear there labelled with letters that did nothing).
    expect(harness.browse.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('the keyboard stays inside the dialog', () => {
  it('cycles focus with Tab and Shift+Tab instead of leaving the modal', async () => {
    const harness = mount()
    await settle()
    const frame = dialog(harness.container)
    const focusable = [...frame.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.hasAttribute('disabled'))
    expect(focusable.length).toBeGreaterThan(1)
    // Land on the last one, then Tab must wrap to the first rather than escaping.
    const last = focusable[focusable.length - 1] as HTMLElement
    flushed(() => { last.focus() })
    press(harness.container, 'Tab')
    const wrapped = document.activeElement as HTMLElement
    // Focus stayed inside the modal, and moved off the last element rather than
    // leaving the dialog for the page behind it.
    expect(frame.contains(wrapped)).toBe(true)
    expect(wrapped).not.toBe(last)
    // Shift+Tab steps back to a different element, still inside the modal.
    press(harness.container, 'Tab', { shiftKey: true })
    const back = document.activeElement as HTMLElement
    expect(frame.contains(back)).toBe(true)
    expect(back).not.toBe(wrapped)
  })

})

describe('creating a folder', () => {
  /** Open the new-folder form and type a name into it. */
  async function typeName(harness: Harness, name: string): Promise<HTMLInputElement> {
    click(buttonWith(harness.container, t('picker.newFolder')))
    await settle()
    const form = dialog(harness.container).querySelector('.dsh_atlas_pickerNewRow') as HTMLElement
    const input = form.querySelector('input') as HTMLInputElement
    typeInto(input, name)
    await settle()
    return input
  }

  it('creates the typed folder and walks into it', async () => {
    const harness = mount({ create: ((_path: string, name: string) => Promise.resolve(`E:/${name}`)) as MountOptions['create'] })
    await settle()
    await typeName(harness, 'New')
    submit(dialog(harness.container))
    await settle()
    // The path the level was showing is the parent it creates in.
    expect(harness.create).toHaveBeenCalledWith('E:/', 'New')
    // The form closes and the picker lands on the folder it just made.
    expect(dialog(harness.container).querySelector('.dsh_atlas_pickerNewRow')).toBeNull()
    const levels = [...harness.list.mock.calls, ...harness.browse.mock.calls].map(call => call[0])
    expect(levels).toContain('E:/New')
  })

  it('shows the reason when the Host refuses to create it, and keeps the form', async () => {
    const harness = mount({ create: (() => Promise.reject(new Error('read-only parent'))) as MountOptions['create'] })
    await settle()
    await typeName(harness, 'New')
    submit(dialog(harness.container))
    await settle()
    expect(dialog(harness.container).querySelector('.dsh_atlas_pickerNewRow')).not.toBeNull()
    expect(dialog(harness.container).textContent).toContain('read-only parent')
  })

  it('says nothing about an empty name, and creates nothing', async () => {
    const harness = mount()
    await settle()
    await typeName(harness, '   ')
    submit(dialog(harness.container))
    await settle()
    expect(harness.create).not.toHaveBeenCalled()
    expect(dialog(harness.container).querySelector('.dsh_atlas_pickerNewRow')).not.toBeNull()
  })
})

describe('Escape unwinds one layer at a time', () => {
  it('closes the new-folder form first', async () => {
    const harness = mount()
    await settle()
    click(buttonWith(harness.container, t('picker.newFolder')))
    const form = dialog(harness.container).querySelector('.dsh_atlas_pickerNewRow')
    expect(form).not.toBeNull()
    press(harness.container, 'Escape')
    expect(dialog(harness.container).querySelector('.dsh_atlas_pickerNewRow')).toBeNull()
    expect(onScreen(harness.container)).toBe(true)
  })

  it('clears the filter next', async () => {
    const harness = mount()
    await settle()
    press(harness.container, 'G')
    expect(rowNames(harness.container)).not.toContain('Rust')
    press(harness.container, 'Escape')
    expect(rowNames(harness.container)).toContain('Rust')
    expect(onScreen(harness.container)).toBe(true)
  })

  it('closes the dialog when nothing else is left — expansion is not a layer', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Rust')
    press(harness.container, 'Enter')
    await settle()
    expect(rowNames(harness.container)).toContain('DSH')
    press(harness.container, 'Escape')
    await settle()
    expect(harness.close).toHaveBeenCalled()
    expect(onScreen(harness.container)).toBe(false)
  })

  it('closes without adopting anything when there was nothing to unwind', async () => {
    const harness = mount()
    await settle()
    press(harness.container, 'Escape')
    await settle()
    expect(harness.confirm).not.toHaveBeenCalled()
    expect(onScreen(harness.container)).toBe(false)
  })

  it('ignores keys while an IME is composing', async () => {
    const harness = mount()
    await settle()
    moveTo(harness.container, 'Games')
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    flushed(() => { listBox(harness.container).dispatchEvent(event) })
    await settle()
    expect(harness.confirm).not.toHaveBeenCalled()
    expect(onScreen(harness.container)).toBe(true)
  })
})

describe('the dialog behaves like a modal', () => {
  it('lives on <body> rather than inside the shell\u2019s slot', async () => {
    const harness = mount()
    await settle()
    expect(harness.slot.contains(dialog(harness.container))).toBe(false)
    expect(harness.container.contains(dialog(harness.container))).toBe(true)
  })

  it('disappears completely when it is dismissed', async () => {
    const harness = mount()
    await settle()
    press(harness.container, 'Escape')
    await settle()
    expect(harness.container.querySelector('[data-atlas-folder-picker]')).toBeNull()
  })

  it('closes on a click on the scrim itself', async () => {
    const harness = mount()
    await settle()
    // The dialog closes on mouse-down, not on click, so that a drag that ends
    // outside the dialog does not close it.
    const scrim = dialog(harness.container).parentElement as HTMLElement
    flushed(() => { scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    await settle()
    expect(harness.close).toHaveBeenCalled()
  })

  it('traps Tab inside the dialog', async () => {
    const harness = mount()
    await settle()
    const input = pathInput(harness.container)
    flushed(() => { input.focus() })
    press(harness.container, 'Tab', {}, 'path')
    expect(document.activeElement).not.toBe(input)
    flushed(() => { input.focus() })
    press(harness.container, 'Tab', { shiftKey: true }, 'path')
    expect((document.activeElement?.textContent ?? '')).toContain(t('picker.open'))
  })

  it('takes the keyboard back when the shell hands it to the composer while it is open', async () => {
    const harness = mount()
    await settle()
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', 'true')
    composer.tabIndex = 0
    document.body.append(composer)
    // The shell re-focuses the composer right as the dialog comes up, and the two
    // race: on the real device the dialog was on screen and keyboard-deaf, every
    // keydown landing on the composer instead. The dialog is `aria-modal`, so it has
    // to win that race — and keep winning it, not only at mount.
    flushed(() => { composer.focus() })
    expect(document.activeElement).toBe(pathInput(harness.container))
    composer.remove()
  })

  it('stands down once a pick hands the focus back to the composer, even with the dialog still up', async () => {
    const harness = mount()
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', 'true')
    composer.tabIndex = 0
    document.body.append(composer)
    await settle()
    click(buttonWith(harness.container, t('picker.open')))
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/')
    // Adopting a path is the one exit that MEANS to leave: a guard that kept
    // demanding the focus back would trap the caret in a dialog that is on its way
    // out, and the shell cannot close us before it has the value.
    expect(document.activeElement).toBe(composer)
    expect(onScreen(harness.container)).toBe(true)
    flushed(() => { composer.focus() })
    expect(document.activeElement).toBe(composer)
    composer.remove()
  })
})

describe('the gestures that write something', () => {
  it('creates a folder and follows into it', async () => {
    const harness = mount()
    await settle()
    click(buttonWith(harness.container, t('picker.newFolder')))
    const field = dialog(harness.container).querySelector<HTMLInputElement>('.dsh_atlas_pickerNewRow input')
    if (field === null) throw new Error('no folder-name field')
    typeInto(field, 'New')
    const form = dialog(harness.container).querySelector('form')
    if (form === null) throw new Error('no new-folder form')
    flushed(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await settle()
    expect(harness.create).toHaveBeenCalledWith('E:/', 'New')
    expect(pathInput(harness.container).value).toBe('E:/New')
    expect(harness.confirm).not.toHaveBeenCalled()
  })

  it('opens the folder the path line shows when the primary button is pressed', async () => {
    const harness = mount()
    await settle()
    click(buttonWith(harness.container, t('picker.open')))
    await settle()
    expect(harness.confirm).toHaveBeenCalledWith('E:/')
  })

  it('reports a failed browse instead of showing an empty tree', async () => {
    const harness = mount({ browse: () => Promise.reject(new Error('the walk gave up')) })
    await settle()
    expect(notes(harness.container).some(note => note.includes('the walk gave up'))).toBe(true)
    // The two group headers are always there; a failure must not fill them.
    expect(rowNames(harness.container)).toEqual([t('picker.group.presets'), t('picker.group.current')])
  })

  it('stays quiet about a browse that finishes after the dialog is gone', async () => {
    // The fetch effect aborts on unmount; a late answer (or a late failure) must
    // not touch state on a component that no longer exists.
    let fail: ((error: Error) => void) | undefined
    const harness = mount({
      browse: () => new Promise<PickerListing>((_resolve, reject) => { fail = reject }),
    })
    await settle()
    harness.unmount()
    fail?.(new Error('too late to matter'))
    await settle()
    // Nothing to assert on screen (the dialog is gone) — the point is that the
    // rejection handler short-circuits on the aborted signal instead of setting state.
    expect(onScreen(harness.container)).toBe(false)
  })

  it('notes a failed expansion and keeps the level usable', async () => {
    const harness = mount({
      list: (path) => (path === 'E:/Rust' ? Promise.reject(new Error('no permission there')) : Promise.resolve(levelOf(path))),
    })
    await settle()
    flushed(() => { rowNamed(harness.container, 'Rust').click() })
    await settle()
    flushed(() => { press(harness.container, 'Enter', {}, 'list') })
    await settle()
    expect(notes(harness.container).some(note => note.includes('no permission there'))).toBe(true)
    // The failed folder is still a row the user can try again from.
    expect(rowNames(harness.container)).toContain('Rust')
  })

  it('does not move the cursor on a level with nothing focusable', async () => {
    const harness = mount({ browse: () => Promise.resolve(levelOf('E:/Empty')) })
    await settle()
    // No folder rows: the arrows have nothing to reach, and the dialog does not throw.
    flushed(() => { press(harness.container, 'ArrowDown', {}, 'list') })
    flushed(() => { press(harness.container, 'End', {}, 'list') })
    expect(onScreen(harness.container)).toBe(true)
    // The only focusable thing left is the way up, so that is where the cursor sits.
    expect(currentName(harness.container)).toBe(t('picker.up'))
  })

  it('shows the refusal the Host reported', async () => {
    const harness = mount({ browse: () => Promise.resolve({ ...levelOf('E:/'), error: 'outside' }) })
    await settle()
    expect(notes(harness.container)).toContain(t('picker.refusal.outside'))
  })

  it('notes a truncated listing', async () => {
    const harness = mount({ browse: () => Promise.resolve({ ...levelOf('E:/'), truncated: true }) })
    await settle()
    expect(notes(harness.container)).toContain(t('picker.truncated'))
  })

  it('opens anyway when the frequent-folder lookup fails', async () => {
    const harness = mount({ recent: () => Promise.reject(new Error('no presets today')) })
    await settle()
    expect(onScreen(harness.container)).toBe(true)
    expect(rowNames(harness.container)).toContain('Rust')
    await openPresets(harness)
    expect(notes(harness.container)).toContain(t('picker.group.none'))
  })

  it('does not adopt on Enter in the path line before anything could be listed', async () => {
    const harness = mount({ browse: () => new Promise(() => {}) })
    await settle()
    typePath(harness.container, 'E:/Ru')
    press(harness.container, 'Enter', {}, 'path')
    await settle()
    expect(harness.confirm).not.toHaveBeenCalled()
  })
})
