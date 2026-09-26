// @vitest-environment jsdom
/**
 * The @ menu overlay bridge: group folding (click and Enter), category rows kept
 * in the menu, and the smart default highlight. The composer here is a plain
 * element on purpose — the bridge reads menu state, never the input element, and
 * a handler that needed a textarea would silently never run in the product.
 */
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  MentionNavigator,
  isPlainEnter,
  highlightedGroup,
  groupAt,
  defaultHighlightIndex,
  firstLeafIndex,
  isHeaderRow,
  PAGE_ROWS,
  pageStep,
  type MentionNavigationInput,
  type MentionNavigatorProps,
} from '../src/client/MentionNavigator.tsx'
import { CATEGORIES, completionTarget } from '../src/client/source.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

const INPUT: MentionNavigationInput = { draft: '@p', draftRev: 4, phase: 'plain' }
const EMPTY_INPUT: MentionNavigationInput = { draft: '@', draftRev: 4, phase: 'plain' }

function menu(query = 'p', items?: { name: string; value: string; mentionKind: string }[]): MenuState {
  const rows = items ?? [
    { name: 'C-plugin', value: 'plugin:', mentionKind: 'category' },
    { name: 'dsh-atlas', value: 'dsh-atlas', mentionKind: 'plugin' },
  ]
  return {
    open: true,
    hit: { trigger: '@', query, position: 'leading', span: { start: 0, end: query.length + 1, draftRev: 4 } },
    generation: 1,
    groups: [{ source: 'atlas', status: 'ready', items: rows }],
    highlight: { source: 'atlas', index: 0 },
  }
}

/** Mount the overlay with an explicit input state and a stub controller. */
function mount(initialInput: MentionNavigationInput, currentMenu = menu(), toggleGroup?: (key: string) => void, rebuildRows?: (sessionId: string, query: string) => unknown): {
  root: Root
  composer: HTMLElement
  track: ReturnType<typeof vi.fn>
  setDraft: ReturnType<typeof vi.fn>
  toggleGroup: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const track = vi.fn()
  const setDraft = vi.fn()
  const toggleGroupSpy = toggleGroup ?? vi.fn()
  const update = vi.fn()
  // The real store fans out to every subscriber; the plugin has more than one
  // (the smart highlight and the scroll anchor), so this stub must too.
  const menuSubscribers = new Set<() => void>()
  const controller = {
    menu: {
      getSnapshot: () => currentMenu,
      subscribe: (fn: () => void) => {
        menuSubscribers.add(fn)
        return () => { menuSubscribers.delete(fn) }
      },
      update,
    },
    track,
    dismiss: vi.fn(),
  }
  function Harness() {
    const [input, setInput] = useState(initialInput)
    const props = {
      controller,
      useInput: (selector: (state: MentionNavigationInput) => unknown) => selector(input),
      inputActions: {
        setDraft: (draft: string) => {
          setDraft(draft)
          setInput(previous => ({ ...previous, draft, draftRev: previous.draftRev + 1 }))
        },
      },
      toggleGroup: toggleGroupSpy,
      sessionId: 's1',
      rebuildRows: rebuildRows ?? (() => undefined),
    } as unknown as MentionNavigatorProps
    return (
      <>
        <div data-dsh-atlas-composer />
        <MentionNavigator {...props} />
      </>
    )
  }
  flushSync(() => { root.render(<Harness />) })
  const composer = container.querySelector('[data-dsh-atlas-composer]') as HTMLTextAreaElement
  return {
    root,
    composer,
    track,
    setDraft,
    toggleGroup: toggleGroupSpy,
    update,
    notifyMenu: () => { for (const notify of [...menuSubscribers]) notify() },
  }
}

function press(composer: HTMLElement, key: string): boolean {
  return composer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('coexisting @ sources', () => {
  const OUR_ROWS = [
    { name: 'C-file', value: 'file:', mentionKind: 'category' },
    { name: 'row', value: '', mentionKind: 'section-header' },
    { name: 'a.ts', value: 'a.ts', mentionKind: 'file' },
  ]
  const FOREIGN_ROWS = [
    { name: 'x', value: 'x', mentionKind: 'leaf' },
    { name: 'y', value: 'y', mentionKind: 'leaf' },
    { name: 'z', value: 'z', mentionKind: 'leaf' },
  ]

  /** A menu where another plugin's `@` source sits beside ours. */
  const coexisting = (highlight: MenuState['highlight'], query = 'p'): MenuState => ({
    open: true,
    hit: { trigger: '@', query, position: 'leading', span: { start: 0, end: query.length + 1, draftRev: 4 } },
    generation: 1,
    groups: [
      { source: 'atlas', status: 'ready', items: OUR_ROWS },
      { source: 'other-plugin', status: 'ready', items: FOREIGN_ROWS },
    ],
    highlight,
  })

  it('resolves a group header only when our own source owns it', () => {
    expect(highlightedGroup(coexisting({ source: 'atlas', index: 0 }))).toBeUndefined()
    // The same index inside a foreign group must never resolve to our rows.
    expect(highlightedGroup(coexisting({ source: 'other-plugin', index: 1 }))).toBeUndefined()
    expect(highlightedGroup(coexisting(null))).toBeUndefined()
    // A pending foreign group is not ours either.
    expect(highlightedGroup({
      ...coexisting({ source: 'other-plugin', index: 0 }),
      groups: [{ source: 'other-plugin', status: 'pending', items: [] }],
    })).toBeUndefined()
  })

  it('never folds while another @ source owns the highlight', () => {
    // The foreign group's highlight must not be read as one of our group rows:
    // folding would cancel the foreign pick.
    const foreign = mount(INPUT, coexisting({ source: 'other-plugin', index: 1 }))
    expect(press(foreign.composer, 'Enter')).toBe(true)
    expect(foreign.toggleGroup).not.toHaveBeenCalled()
    foreign.root.unmount()
    document.body.innerHTML = ''

    // Our own divider is not a group header either, so Enter still passes.
    const ours = mount(INPUT, coexisting({ source: 'atlas', index: 1 }))
    expect(press(ours.composer, 'Enter')).toBe(true)
    expect(ours.toggleGroup).not.toHaveBeenCalled()
    ours.root.unmount()
    document.body.innerHTML = ''
  })
})

describe('isPlainEnter', () => {
  it('recognizes a plain Enter only', () => {
    const plain = { key: 'Enter', keyCode: 13, defaultPrevented: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    expect(isPlainEnter(plain)).toBe(true)
    expect(isPlainEnter({ ...plain, key: 'Tab', keyCode: 9 })).toBe(false)
    expect(isPlainEnter({ ...plain, key: 'a', keyCode: 65 })).toBe(false)
    // IME ownership, modifiers, and an already-handled event all pass through.
    expect(isPlainEnter({ ...plain, isComposing: true })).toBe(false)
    expect(isPlainEnter({ ...plain, keyCode: 229 })).toBe(false)
    expect(isPlainEnter({ ...plain, ctrlKey: true })).toBe(false)
    expect(isPlainEnter({ ...plain, shiftKey: true })).toBe(false)
    expect(isPlainEnter({ ...plain, defaultPrevented: true })).toBe(false)
  })
})

describe('overlay bridge', () => {
  it('leaves Tab and an ordinary Enter to the framework', () => {
    const { root, composer, setDraft, track, toggleGroup } = mount(INPUT, menu('p'))
    // Tab completion and the plain pick belong to the framework's keymap; the
    // overlay only owns the group-header gesture.
    expect(press(composer, 'Tab')).toBe(true)
    expect(press(composer, 'Enter')).toBe(true)
    expect(setDraft).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalled()
    expect(toggleGroup).not.toHaveBeenCalled()
    root.unmount()
  })

  it('folds a highlighted group header on Enter, from a plain element', () => {
    const groupMenu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'chat:', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' },
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    const { root, composer, toggleGroup } = mount(INPUT, groupMenu)
    expect(press(composer, 'Enter')).toBe(false)
    expect(toggleGroup).toHaveBeenCalledWith('chat:ws')
    root.unmount()
  })

  it('keeps every category reachable from the menu row list', () => {
    expect(CATEGORIES.map(category => category.shortcut)).toEqual(['F', 'D', 'S', 'C', 'P'])
  })
})

describe('group row helpers', () => {
  const groupMenu = (kind: 'chat-group' | 'skill-group', key: string): MenuState => ({
    open: true,
    hit: { trigger: '@', query: 'chat:', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
    generation: 1,
    groups: [{ source: 'atlas', status: 'ready', items: [
      { name: 'row', value: '', mentionKind: kind, groupKey: key },
      { name: 'a session', value: 'sess-a', mentionKind: 'chat', chatUri: 'dsh-session:YQ' },
    ] }],
    highlight: { source: 'atlas', index: 0 },
  })

  it('resolves the highlighted group row', () => {
    expect(highlightedGroup(groupMenu('chat-group', 'chat:ws'))).toEqual({ key: 'chat:ws', index: 0 })
    expect(highlightedGroup({ ...groupMenu('chat-group', 'chat:ws'), highlight: { source: 'atlas', index: 1 } })).toBeUndefined()
    expect(highlightedGroup(menu())).toBeUndefined()
  })

  it('resolves a group row by menu index', () => {
    expect(groupAt(groupMenu('skill-group', 'skill:custom'), 0)).toEqual({ key: 'skill:custom' })
    expect(groupAt(groupMenu('chat-group', 'chat:ws'), 1)).toBeUndefined()
  })

  it('folds the folder category groups through the same gesture', () => {
    // The folder category has two groups of its own; folding them is the SAME
    // gesture the plugin already owns, not a third one, so they resolve here too.
    expect(highlightedGroup(groupMenu('dir-group', 'folder:outside'))).toEqual({ key: 'folder:outside', index: 0 })
    expect(groupAt(groupMenu('dir-group', 'folder:workspace'), 0)).toEqual({ key: 'folder:workspace' })
    expect(isHeaderRow({ mentionKind: 'dir-group' })).toBe(true)
    // A note is prose the user cannot pick, not a header: the default highlight
    // may land on it only if it is the first leaf, which is why it is a leaf.
    expect(isHeaderRow({ mentionKind: 'browse-note' })).toBe(false)
    expect(isHeaderRow({ mentionKind: 'folder-choose' })).toBe(false)
  })
})

describe('smart default highlight', () => {
  const leaf = (name: string, kind = 'file') => ({ name, value: name, mentionKind: kind })

  it('skips section headers when finding the first leaf', () => {
    const menu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'view', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'C-file', value: 'file:', mentionKind: 'category' },
        { name: 'back', value: 'back', mentionKind: 'back' },
        { name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' },
        leaf('a.ts'),
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    expect(isHeaderRow(menu.groups[0]!.items[0])).toBe(true)
    expect(isHeaderRow(menu.groups[0]!.items[3])).toBe(false)
    expect(firstLeafIndex(menu)).toBe(3)
  })

  it('highlights the first match after a new query settles', () => {
    const items = [
      { name: 'C-file', value: 'file:', mentionKind: 'category' },
      { name: 'C-folder', value: 'folder:', mentionKind: 'category' },
      { name: 'C-skill', value: 'skill:', mentionKind: 'category' },
      { name: 'C-chat', value: 'chat:', mentionKind: 'category' },
      { name: 'C-plugin', value: 'plugin:', mentionKind: 'category' },
      leaf('view.ts'),
    ]
    const menu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'view', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items }],
      highlight: { source: 'atlas', index: 0 },
    }
    const input: MentionNavigationInput = { draft: '@view', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menu)
    notifyMenu()
    expect(update).toHaveBeenCalledTimes(1)
    const draft = JSON.parse(JSON.stringify(menu)) as MenuState
    update.mock.calls[0]![0](draft)
    expect(draft.highlight).toEqual({ source: 'atlas', index: 5 })
    // The same query does not re-snap (manual navigation stays untouched).
    notifyMenu()
    expect(update).toHaveBeenCalledTimes(1)
    root.unmount()
  })

  it('snaps only after the rows become ready, not on the pending hit', () => {
    const leaf = (name: string) => ({ name, value: name, mentionKind: 'file' })
    const menuState: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'view', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'pending', items: [] }],
      highlight: null,
    }
    const input: MentionNavigationInput = { draft: '@view', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menuState)
    // The 'hit' notification arrives while the group is still pending.
    notifyMenu()
    expect(update).not.toHaveBeenCalled()
    // Rows settle: the group becomes ready with categories + one match.
    menuState.groups = [{ source: 'atlas', status: 'ready', items: [
      { name: 'C-file', value: 'file:', mentionKind: 'category' },
      leaf('view.ts'),
    ] }]
    menuState.highlight = { source: 'atlas', index: 0 }
    notifyMenu()
    expect(update).toHaveBeenCalledTimes(1)
    const draft = JSON.parse(JSON.stringify(menuState)) as MenuState
    update.mock.calls[0]![0](draft)
    expect(draft.highlight).toEqual({ source: 'atlas', index: 1 })
    root.unmount()
  })

  it('does not override a manual highlight on an unchanged query', () => {
    const menu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'view', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [leaf('a.ts'), leaf('b.ts')] }],
      highlight: { source: 'atlas', index: 1 },
    }
    const input: MentionNavigationInput = { draft: '@view', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menu)
    notifyMenu()
    expect(update).not.toHaveBeenCalled()
    root.unmount()
  })

  /** The rows a shortcut query produces: the gray hint row, the categories, then matches. */
  const shortcutRows = () => [
    { name: 'C-skill', value: 'skill:', mentionKind: 'category' },
    { name: 'C-file', value: 'file:', mentionKind: 'category' },
    { name: 'row', value: '', mentionKind: 'section-header' },
    leaf('docs/skill.md'),
  ]

  const shortcutMenu = (highlight: MenuState['highlight']): MenuState => ({
    open: true,
    hit: { trigger: '@', query: 's', position: 'leading', span: { start: 0, end: 2, draftRev: 4 } },
    generation: 1,
    groups: [{ source: 'atlas', status: 'ready', items: shortcutRows() }],
    highlight,
  })

  it('defaults a shortcut query onto the category it names, not the first match', () => {
    // The gray hint row the source pins on top is the category's own row: the
    // first result leaf (index 3) is what a best-match default would pick.
    expect(defaultHighlightIndex(shortcutMenu({ source: 'atlas', index: 0 }))).toBe(0)
    expect(firstLeafIndex(shortcutMenu(null))).toBe(3)
  })

  it('falls back to the first leaf when the query names no category, or no row exists yet', () => {
    const base: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'view', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'C-file', value: 'file:', mentionKind: 'category' },
        leaf('view.ts'),
      ] }],
      highlight: null,
    }
    expect(defaultHighlightIndex(base)).toBe(1)
    // A shortcut with no category row to land on still resolves to a leaf.
    expect(defaultHighlightIndex({ ...base, hit: { ...base.hit!, query: 's' } })).toBe(1)
    // Pending rows have nothing to highlight yet; a hitless shell has no query.
    expect(defaultHighlightIndex({ ...base, groups: [{ source: 'atlas', status: 'pending', items: [] }] })).toBe(-1)
    expect(defaultHighlightIndex({ ...base, hit: null })).toBe(1)
  })

  it('moves the highlight onto the named category even from a most-used row', () => {
    const menuState = shortcutMenu({ source: 'atlas', index: 3 })
    const input: MentionNavigationInput = { draft: '@s', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menuState)
    notifyMenu()
    expect(update).toHaveBeenCalledTimes(1)
    const draft = JSON.parse(JSON.stringify(menuState)) as MenuState
    update.mock.calls[0]![0](draft)
    expect(draft.highlight).toEqual({ source: 'atlas', index: 0 })
    root.unmount()
  })

  it('never takes the highlight from another @ source', () => {
    const menuState = shortcutMenu({ source: 'other-plugin', index: 0 })
    const input: MentionNavigationInput = { draft: '@s', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menuState)
    notifyMenu()
    expect(update).not.toHaveBeenCalled()
    root.unmount()
  })

  it('leaves the highlight alone when it is already on the target row', () => {
    const menuState = shortcutMenu({ source: 'atlas', index: 0 })
    const input: MentionNavigationInput = { draft: '@s', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menuState)
    notifyMenu()
    expect(update).not.toHaveBeenCalled()
    root.unmount()
  })

  it('keeps the highlight when a query matched nothing but the categories', () => {
    const menuState: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'zzz', position: 'leading', span: { start: 0, end: 4, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'C-file', value: 'file:', mentionKind: 'category' },
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    const input: MentionNavigationInput = { draft: '@zzz', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menuState)
    notifyMenu()
    expect(update).not.toHaveBeenCalled()
    root.unmount()
  })

  it('re-checks ownership and emptiness inside the update callback', () => {
    const menuState: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'view', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'C-file', value: 'file:', mentionKind: 'category' },
        leaf('view.ts'),
      ] }],
      highlight: null,
    }
    const input: MentionNavigationInput = { draft: '@view', draftRev: 4, phase: 'plain' }
    const { root, notifyMenu, update } = mount(input, menuState)
    notifyMenu()
    expect(update).toHaveBeenCalledTimes(1)
    const apply = update.mock.calls[0]![0] as (draft: MenuState) => void
    // The highlight moved to another source between snapshot and update.
    const foreign = JSON.parse(JSON.stringify(menuState)) as MenuState
    foreign.highlight = { source: 'other-plugin', index: 0 }
    apply(foreign)
    expect(foreign.highlight).toEqual({ source: 'other-plugin', index: 0 })
    // A cleared highlight is claimed by us.
    const cleared = JSON.parse(JSON.stringify(menuState)) as MenuState
    apply(cleared)
    expect(cleared.highlight).toEqual({ source: 'atlas', index: 1 })
    root.unmount()
  })
})

describe('bottom band anchoring', () => {
  /** The scrolled row ids, in order, with the options each call passed. */
  const scrolled: string[] = []
  const scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
    scrolled.push(`${this.id} ${JSON.stringify(options ?? null)}`)
  })

  beforeAll(() => {
    // jsdom implements no layout and no scrolling API at all.
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
  })
  afterAll(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })
  beforeEach(() => {
    scrolled.length = 0
    scrollIntoView.mockClear()
  })

  const bandMenu = (query = '', items?: { name: string; value: string; mentionKind: string }[]): MenuState => menu(query, items ?? [
    { name: '文件 F', value: 'file:', mentionKind: 'category' },
    { name: '文件夹 D', value: 'folder:', mentionKind: 'category' },
    { name: 'Skill S', value: 'skill:', mentionKind: 'category' },
    { name: '聊天 C', value: 'chat:', mentionKind: 'category' },
    { name: '插件 P', value: 'plugin:', mentionKind: 'category' },
  ])

  /** The framework's own option rows, addressed by the ids the anchor looks up. */
  const optionRows = (count: number): HTMLElement[] => Array.from({ length: count }, (_unused, index) => {
    const row = document.createElement('button')
    row.id = `dsh-slash-option-atlas-${index}`
    document.body.appendChild(row)
    return row
  })

  /** Let one animation frame elapse: the anchor coalesces its work into one. */
  const nextFrame = (): Promise<void> => new Promise(resolve => { requestAnimationFrame(() => { resolve() }) })
  /** Let the anchor's post-change HOLD window expire (it re-asserts for a few frames). */
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) await nextFrame()
  }

  it('anchors the whole band to the bottom edge while the band is the content', async () => {
    const rows = optionRows(5)
    const state = bandMenu()
    const { root, notifyMenu } = mount(EMPTY_INPUT, state)
    await nextFrame()
    // The LAST row is the anchor, not the highlighted first one: `block: 'end'`
    // then leaves every row of the band above it in view, which is the whole
    // point — anchoring the highlighted row with 'nearest' is what hid them.
    expect(scrolled[0]).toBe('dsh-slash-option-atlas-4 {"block":"end"}')
    // A content change keeps re-asserting for a few frames, so a framework scroll
    // that lands a frame LATER (its own scroll is a passive effect) cannot leave
    // the band pushed out — the live regression this replaced.
    await settle()
    const settled = scrollIntoView.mock.calls.length
    expect(settled).toBeGreaterThan(1)
    expect(new Set(scrolled)).toEqual(new Set(['dsh-slash-option-atlas-4 {"block":"end"}']))
    // Nothing about the content changes after that, so nothing is scrolled: a
    // hover moves the highlight, and yanking the list back would fight the user.
    notifyMenu()
    notifyMenu()
    await settle()
    expect(scrollIntoView).toHaveBeenCalledTimes(settled)
    // A real content change does re-anchor — the stock source's late rows are
    // exactly the case that slides the band down, and they land as a new group.
    state.groups = [
      state.groups[0]!,
      { source: 'dsh-client-ui-reference', status: 'ready', items: [{ name: 'x', value: 'x', mentionKind: 'leaf' }] },
    ]
    notifyMenu()
    await settle()
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(settled)
    for (const row of rows) row.remove()
    root.unmount()
  })

  it('anchors again after the menu closes and reopens on identical rows', async () => {
    const rows = optionRows(5)
    const state = bandMenu()
    const { root, notifyMenu } = mount(EMPTY_INPUT, state)
    await settle()
    const first = scrollIntoView.mock.calls.length
    expect(first).toBeGreaterThan(0)
    // Closing forgets the anchor: the next `@` re-anchors even though the rows
    // are byte-identical, so a reopened menu never inherits an old offset.
    state.open = false
    notifyMenu()
    await nextFrame()
    const closed = scrollIntoView.mock.calls.length
    state.open = true
    notifyMenu()
    await nextFrame()
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(closed)
    for (const row of rows) row.remove()
    root.unmount()
  })

  it('keeps the FOCUS visible once there are results, without yanking a visible list', async () => {
    const rows = optionRows(3)
    const withResults = bandMenu('view', [
      { name: '文件 F', value: 'file:', mentionKind: 'category' },
      { name: 'row', value: '', mentionKind: 'section-header' },
      { name: 'view.ts', value: 'view.ts', mentionKind: 'file' },
    ])
    // The default highlight for an ordinary query is the first result leaf, which is
    // also the topmost priority row; a content change re-asserts it with 'nearest'
    // (a no-op in a real browser while it is already on screen), never with 'end'.
    withResults.highlight = { source: 'atlas', index: 2 }
    const { root, notifyMenu } = mount(EMPTY_INPUT, withResults)
    notifyMenu()
    await settle()
    expect(scrollIntoView).toHaveBeenCalled()
    expect(new Set(scrolled)).toEqual(new Set(['dsh-slash-option-atlas-2 {"block":"nearest"}']))
    // A hover moves the highlight; the offset is the framework's business then.
    const settledCalls = scrollIntoView.mock.calls.length
    withResults.highlight = { source: 'atlas', index: 1 }
    notifyMenu()
    notifyMenu()
    await settle()
    expect(scrollIntoView).toHaveBeenCalledTimes(settledCalls)
    // A highlight that is NOT ours still parks the FIRST leaf — the priority row —
    // in view rather than the stock source's row above us.
    scrolled.length = 0
    withResults.highlight = { source: 'dsh-client-ui-reference', index: 0 }
    withResults.groups = [
      withResults.groups[0]!,
      { source: 'dsh-client-ui-reference', status: 'ready', items: [{ name: 'x', value: 'x', mentionKind: 'leaf' }] },
    ]
    notifyMenu()
    await settle()
    expect(scrolled).toContain('dsh-slash-option-atlas-2 {"block":"nearest"}')
    for (const row of rows) row.remove()
    root.unmount()
  })

  it('stays out of the way while the menu is closed, pending, or empty', async () => {
    const rows = optionRows(2)
    const pending: MenuState = {
      ...bandMenu(),
      groups: [{ source: 'atlas', status: 'pending', items: [] }],
    }
    const first = mount(EMPTY_INPUT, { ...bandMenu(), open: false })
    first.notifyMenu()
    await nextFrame()
    expect(scrollIntoView).not.toHaveBeenCalled()
    first.root.unmount()

    const second = mount(EMPTY_INPUT, pending)
    second.notifyMenu()
    await nextFrame()
    expect(scrollIntoView).not.toHaveBeenCalled()
    second.root.unmount()

    const third = mount(EMPTY_INPUT, { ...bandMenu(), groups: [{ source: 'atlas', status: 'ready', items: [] }] })
    third.notifyMenu()
    await nextFrame()
    expect(scrollIntoView).not.toHaveBeenCalled()
    third.root.unmount()
    for (const row of rows) row.remove()
  })

  it('cancels a scheduled anchor when the overlay unmounts first', async () => {
    const rows = optionRows(1)
    const { root, notifyMenu } = mount(EMPTY_INPUT, bandMenu())
    notifyMenu()
    root.unmount()
    await nextFrame()
    expect(scrollIntoView).not.toHaveBeenCalled()
    for (const row of rows) row.remove()
  })
})

describe('page keys', () => {
  /** A long list of OUR rows: the case paging exists for. */
  const manyRows = (count: number): { name: string; value: string; mentionKind: string }[] =>
    Array.from({ length: count }, (_, index) => ({ name: `row-${String(index)}.ts`, value: `row-${String(index)}.ts`, mentionKind: 'file' }))

  /** One `keydown` on the document, exactly as the browser delivers it. */
  const press = (key: string, options: KeyboardEventInit = {}): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
  }

  /** Apply the updater the bridge handed the store to a plain draft. */
  const draftAfter = (update: ReturnType<typeof vi.fn>, start: number): number => {
    const draft = { highlight: { source: 'atlas', index: start }, groups: [] as unknown[] }
    const updater = update.mock.calls.at(-1)?.[0] as ((draft: unknown) => void) | undefined
    updater?.(draft)
    return draft.highlight.index
  }

  it('moves the highlight one page per key and clamps at both ends', () => {
    const state = menu('view', manyRows(30))
    state.highlight = { source: 'atlas', index: 0 }
    const { root, update } = mount(EMPTY_INPUT, state)
    /** Press one page key from a given highlight and report where it lands. */
    const pressFrom = (index: number, key: string): number => {
      state.highlight = { source: 'atlas', index }
      update.mockClear()
      press(key)
      return draftAfter(update, index)
    }
    // jsdom has no layout, so the page falls back to PAGE_ROWS rows.
    expect(pressFrom(0, 'PageDown')).toBe(PAGE_ROWS)
    expect(pressFrom(PAGE_ROWS, 'PageUp')).toBe(0)
    // A page that would run past either end stops on the last/first row instead of
    // off the list.
    expect(pressFrom(20, 'PageDown')).toBe(28)
    expect(pressFrom(3, 'PageUp')).toBe(0)
    // Modified keys and a closed menu are not ours: no highlight change at all.
    update.mockClear()
    press('PageDown', { shiftKey: true })
    press('PageDown', { ctrlKey: true })
    state.open = false
    press('PageDown')
    expect(update).not.toHaveBeenCalled()
    root.unmount()
  })

  it('scrolls the list itself while the highlight is not ours', () => {
    const box = document.createElement('div')
    box.setAttribute('role', 'listbox')
    let scrollTop = 0
    Object.defineProperty(box, 'clientHeight', { value: 320, configurable: true })
    Object.defineProperty(box, 'scrollTop', { get: () => scrollTop, set: (value: number) => { scrollTop = value }, configurable: true })
    document.body.appendChild(box)
    const state = menu('view', manyRows(30))
    state.highlight = { source: 'dsh-client-ui-reference', index: 0 }
    const { root, update } = mount(EMPTY_INPUT, state)
    expect(document.querySelector('[role="listbox"]')).toBe(box)
    // Another source owns the highlight, so the plugin pages the VIEWPORT rather
    // than stealing their selection.
    press('PageDown')
    expect(scrollTop).toBe(320)
    press('PageUp')
    expect(scrollTop).toBe(0)
    expect(update).not.toHaveBeenCalled()
    root.unmount()
    box.remove()
  })

  it('measures a page from the live list when it has a layout', () => {
    const box = document.createElement('div')
    box.setAttribute('role', 'listbox')
    const row = document.createElement('button')
    row.getBoundingClientRect = (): DOMRect => ({ height: 32, width: 240, top: 0, bottom: 32, left: 0, right: 240, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    box.appendChild(row)
    Object.defineProperty(box, 'clientHeight', { value: 320, configurable: true })
    // Ten rows fit, but the last one is the "there is more" hint: a page is nine.
    expect(pageStep(box)).toBe(9)
    // No list, or no layout at all (jsdom): the fallback page.
    expect(pageStep(null)).toBe(PAGE_ROWS)
    expect(pageStep(document.createElement('div'))).toBe(PAGE_ROWS)
    box.remove()
  })
})

describe('menu height budget', () => {
  /** Lay out the composer card so the effect has a real top edge to measure. */
  function composerCard(top: number): HTMLElement {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.getBoundingClientRect = (): DOMRect => ({
      top, bottom: top + 120, left: 0, right: 720, width: 720, height: 120, x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect
    document.body.appendChild(card)
    return card
  }
  const published = (): string => document.documentElement.style.getPropertyValue('--dsh-atlas-menu-max')

  it('publishes the card top edge as the menu cap, and clears it when the card goes away', () => {
    const card = composerCard(512)
    const { root, notifyMenu } = mount(EMPTY_INPUT, menu())
    // The cap the stylesheet reads: the space above the composer, minus a margin.
    expect(published()).toBe('496px')
    // A short window floors it at 160px rather than collapsing the list.
    card.getBoundingClientRect = (): DOMRect => ({
      top: 100, bottom: 220, left: 0, right: 720, width: 720, height: 120, x: 0, y: 100, toJSON: () => ({}),
    }) as DOMRect
    notifyMenu()
    expect(published()).toBe('160px')
    // No card (another view, or a composer that is not mounted): the variable is
    // removed so the stylesheet's own viewport fallback applies.
    card.remove()
    notifyMenu()
    expect(published()).toBe('')
    root.unmount()
  })

  it('clears its variable on unmount', () => {
    const card = composerCard(400)
    const { root } = mount(EMPTY_INPUT, menu())
    expect(published()).toBe('384px')
    root.unmount()
    expect(published()).toBe('')
    card.remove()
  })
})

describe('back and category row interception', () => {
  const backMenu: MenuState = {
    open: true,
    hit: { trigger: '@', query: 'chat:', position: 'leading', span: { start: 0, end: 6, draftRev: 4 } },
    generation: 1,
    groups: [{ source: 'atlas', status: 'ready', items: [
      { name: 'back', value: 'back', mentionKind: 'back' },
      { name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' },
    ] }],
    highlight: { source: 'atlas', index: 0 },
  }

  it('clicking the back row returns to the category menu without closing it', () => {
    const input: MentionNavigationInput = { draft: '@chat:', draftRev: 4, phase: 'plain' }
    const { root, composer, setDraft, track } = mount(input, backMenu)
    const row = document.createElement('button')
    row.id = 'dsh-slash-option-atlas-0'
    document.body.appendChild(row)
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(setDraft).toHaveBeenCalledWith('@')
    flushSync(() => {})
    expect(track).toHaveBeenCalledWith('@', 1, { tier: 'plain' }, 5)
    row.remove()
    root.unmount()
  })

  it('clicking a category row enters the category without closing the menu', () => {
    const categoryMenu: MenuState = {
      open: true,
      hit: { trigger: '@', query: '', position: 'leading', span: { start: 0, end: 1, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'C-plugin', value: 'plugin:', mentionKind: 'category' },
        { name: 'C-file', value: 'file:', mentionKind: 'category' },
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    const input: MentionNavigationInput = { draft: '@', draftRev: 4, phase: 'plain' }
    const { root, composer, setDraft, track } = mount(input, categoryMenu)
    const row = document.createElement('button')
    row.id = 'dsh-slash-option-atlas-0'
    document.body.appendChild(row)
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(setDraft).toHaveBeenCalledWith('@plugin:')
    flushSync(() => {})
    expect(track).toHaveBeenCalledWith('@plugin:', 8, { tier: 'plain' }, 5)
    row.remove()
    root.unmount()
  })

  it('result rows still pick normally (no interception)', () => {
    const resultMenu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'plugin:', position: 'leading', span: { start: 0, end: 8, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'back', value: 'back', mentionKind: 'back' },
        { name: 'dsh-atlas', value: 'dsh-atlas', mentionKind: 'plugin' },
      ] }],
      highlight: { source: 'atlas', index: 1 },
    }
    const input: MentionNavigationInput = { draft: '@plugin:', draftRev: 4, phase: 'plain' }
    const { root, setDraft } = mount(input, resultMenu)
    const row = document.createElement('button')
    row.id = 'dsh-slash-option-atlas-1'
    document.body.appendChild(row)
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(setDraft).not.toHaveBeenCalled()
    row.remove()
    root.unmount()
  })
})

describe('MentionNavigator group toggle', () => {
  it('applies collapse instantly through the menu store when rows rebuild', () => {
    const groupMenu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'chat:', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' },
        { name: 'a session', value: 'sess-a', mentionKind: 'chat', chatUri: 'dsh-session:YQ' },
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    const input: MentionNavigationInput = { draft: '@chat:', draftRev: 4, phase: 'plain' }
    const rebuilt = [{ name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' }]
    const { root, composer, toggleGroup, update } = mount(input, groupMenu, undefined, () => rebuilt)
    press(composer, 'Enter')
    expect(toggleGroup).toHaveBeenCalledWith('chat:ws')
    expect(update).toHaveBeenCalled()
    expect(update.mock.calls[0]![0]).toBeTypeOf('function')
    root.unmount()
  })

  it('falls back to dismiss + track when the cache is not settled', () => {
    const groupMenu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'chat:', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' },
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    const input: MentionNavigationInput = { draft: '@chat:', draftRev: 4, phase: 'plain' }
    const { root, composer, toggleGroup, update, track } = mount(input, groupMenu, undefined, () => undefined)
    press(composer, 'Enter')
    expect(toggleGroup).toHaveBeenCalledWith('chat:ws')
    expect(update).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalled()
    root.unmount()
  })

  it('toggles a highlighted group on Enter and keeps the menu tracked', () => {
    const input0 = () => { void 0 }
    const groupMenu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'chat:', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' },
        { name: 'a session', value: 'sess-a', mentionKind: 'chat', chatUri: 'dsh-session:YQ' },
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    const input: MentionNavigationInput = { draft: '@chat:', draftRev: 4, phase: 'plain' }
    const { root, composer, toggleGroup, track } = mount(input, groupMenu)
    press(composer, 'Enter')
    expect(toggleGroup).toHaveBeenCalledWith('chat:ws')
    expect(track).toHaveBeenCalled()
    root.unmount()
  })

  it('toggles a group row on mousedown and prevents the pick', () => {
    const groupMenu: MenuState = {
      open: true,
      hit: { trigger: '@', query: 'chat:', position: 'leading', span: { start: 0, end: 5, draftRev: 4 } },
      generation: 1,
      groups: [{ source: 'atlas', status: 'ready', items: [
        { name: 'row', value: '', mentionKind: 'chat-group', groupKey: 'chat:ws' },
      ] }],
      highlight: { source: 'atlas', index: 0 },
    }
    const input: MentionNavigationInput = { draft: '@chat:', draftRev: 4, phase: 'plain' }
    const { root, toggleGroup, track } = mount(input, groupMenu)
    const row = document.createElement('button')
    row.id = 'dsh-slash-option-atlas-0'
    document.body.appendChild(row)
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(toggleGroup).toHaveBeenCalledWith('chat:ws')
    expect(track).toHaveBeenCalled()
    row.remove()
    root.unmount()
  })
})