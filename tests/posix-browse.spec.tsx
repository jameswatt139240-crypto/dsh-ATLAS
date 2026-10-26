// @vitest-environment jsdom
/**
 * The browse surfaces on POSIX.
 *
 * Every other browse fixture in this suite is Windows-shaped: levels keyed
 * `'E:/'`, crumb expectations spelled `'E:/Rust'`, and a default level reached by
 * asking the backend for nothing at all. On Windows that is the whole story,
 * because a drive root IS the natural entry point — a drive root's listing
 * carries `drives` and that list is how the user leaves the workspace.
 *
 * On Linux there is no drive list. The filesystem has ONE root and no drive
 * concept, so three things that were invisible on Windows become defects:
 *
 * - the ROOT is reachable only if a crumb points at it. `/home` splits to
 *   `['', 'home']`, and a loop written for `['E:', 'a']` skips that empty first
 *   segment — so `/` never appeared in the strip and could not be clicked.
 * - the DEFAULT level must be the root, not the workspace. Resolving an empty
 *   request against the session's cwd lands on the workspace itself, which looks
 *   fine on Windows (the dialog already opens at a drive root) but on POSIX opens
 *   the chooser ON the folder the user is already in, with no way up to `/`.
 * - the INDEX failing must be visible. Every file row comes from the index, so a
 *   swallowed failure renders "nothing matches" for a workspace that was never
 *   read — the user types letters after `@` and sees an empty menu with no error.
 *
 * The first two live in the HOST (the crumb strip is built by `crumbsOf`, the
 * default level by `browseRoot`), so they are asserted directly rather than
 * through the dialog: a component test can only see the `crumbs` a fixture hands
 * it, which would make the assertion a restatement of the fixture.
 *
 * Descending a level is also a HOST-visible act: the dialog only ever asks for a
 * path, and the tree it renders in place (expanding a folder does not change the
 * level the strip describes) comes from what the Host answers for that path.
 * These cases therefore reach a level the two ways a user does — by typing it and
 * by clicking a crumb — and then assert the strip the Host would have sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { FolderPicker, type FolderPickerProps, type PickerListing } from '../src/client/FolderPicker.tsx'
import { crumbsOf } from '../src/client/index.ts'
import { fmt, zh } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

// The dialog is portaled to <body>, so the document itself is the DOM these
// tests read: a dialog a failing test left behind would answer the next test's
// queries for it. Start each case from an empty document.
beforeEach(() => { document.body.innerHTML = '' })

const t = (key: string, params?: Record<string, string>): string => fmt(zh[key] ?? key, params)

const entry = (name: string, path: string, hidden = false) => ({ name, path, hidden })

describe('crumbsOf on POSIX', () => {
  it('puts the filesystem root first, as a crumb that goes back to `/`', () => {
    // The reported defect. `/home` splits to `['', 'home']`; the Windows-shaped
    // loop started at index 1 and skipped empty segments, so the leading empty
    // segment — which IS the root — never became a crumb. Descending left the
    // user with no way back up.
    expect(crumbsOf('/home')).toEqual([
      { name: '/', path: '/', hidden: false },
      { name: 'home', path: '/home', hidden: false },
    ])
  })

  it('names the root the way the path line spells it', () => {
    // "ONE location behind two views": a crumb labelled anything else would name
    // a place `/home/omarchy` never shows. The label is the `/` itself.
    const [first] = crumbsOf('/home/omarchy')
    expect(first).toEqual({ name: '/', path: '/', hidden: false })
  })

  it('offers every ancestor of a real workspace in order', () => {
    expect(crumbsOf('/home/omarchy/Projects')).toEqual([
      { name: '/', path: '/', hidden: false },
      { name: 'home', path: '/home', hidden: false },
      { name: 'omarchy', path: '/home/omarchy', hidden: false },
      { name: 'Projects', path: '/home/omarchy/Projects', hidden: false },
    ])
  })

  it('reaches the root from a mount path the user actually has open', () => {
    // The guest's own share mount, as reported: every crumb below `/` used to be
    // present and `/` was not, so the path was walkable downward only.
    const crumbs = crumbsOf('/mnt/EShare/Eason/Rust/DSH')
    expect(crumbs[0]).toEqual({ name: '/', path: '/', hidden: false })
    expect(crumbs.map(crumb => crumb.path)).toEqual([
      '/',
      '/mnt',
      '/mnt/EShare',
      '/mnt/EShare/Eason',
      '/mnt/EShare/Eason/Rust',
      '/mnt/EShare/Eason/Rust/DSH',
    ])
  })

  it('leaves the root with no crumbs of its own, exactly like a drive root', () => {
    // Nothing sits above `/`. An empty strip is right; a `/` crumb here would be
    // a row that navigates to where the user already is.
    expect(crumbsOf('/')).toEqual([])
  })

  it('ignores a trailing slash, so a level and a level/ describe one place', () => {
    expect(crumbsOf('/home/')).toEqual(crumbsOf('/home'))
  })

  it('still reads a Windows path as drive-plus-segments', () => {
    // The fix must not have bought POSIX at the cost of Windows: `E:/a/b` keeps the
    // ancestor list it always had (`a`, `b`, each with its full prefix) and gains
    // no `/` crumb, because `parts[0]` is `'E:'`, not the empty string. The drive
    // itself gets no crumb on either platform — on Windows the drive list is what
    // navigates out of it, and on POSIX `/` is the top.
    expect(crumbsOf('E:/Eason/Rust')).toEqual([
      { name: 'Eason', path: 'E:/Eason', hidden: false },
      { name: 'Rust', path: 'E:/Eason/Rust', hidden: false },
    ])
  })

  it('leaves a drive root bare, so the drive list stays the only way out', () => {
    expect(crumbsOf('E:/')).toEqual([])
  })
})

/**
 * One POSIX level per path, spelled the way the Host spells them, with the crumbs
 * `crumbsOf` produces for that path — so the dialog renders what the Host would
 * really have sent, not what a test wished it sent.
 */
const LEVELS: Record<string, PickerListing> = {
  '/': {
    path: '/',
    home: '',
    crumbs: crumbsOf('/'),
    truncated: false,
    // `drives` is COLLECTED-but-empty at a POSIX top level, not absent: the Host
    // really answers this shape on Linux (verified against the shipped bundle on the
    // Omarchy guest). A fixture that simply omitted the field would hide the point —
    // drive affordances keyed on `drives !== undefined` would never render, so the
    // dialog would look correct while a Linux user got an empty "other drives"
    // section and a drive-letter crumb with nothing behind it.
    drives: [],
    entries: [entry('home', '/home'), entry('mnt', '/mnt'), entry('usr', '/usr')],
  },
  '/home': {
    path: '/home',
    home: '',
    crumbs: crumbsOf('/home'),
    truncated: false,
    parent: '/',
    entries: [entry('omarchy', '/home/omarchy')],
  },
  '/home/omarchy': {
    path: '/home/omarchy',
    home: '',
    crumbs: crumbsOf('/home/omarchy'),
    truncated: false,
    parent: '/home',
    entries: [entry('Projects', '/home/omarchy/Projects')],
  },
  '/home/omarchy/Projects': {
    path: '/home/omarchy/Projects',
    home: '',
    crumbs: crumbsOf('/home/omarchy/Projects'),
    truncated: false,
    parent: '/home/omarchy',
    entries: [entry('dsh-atlas', '/home/omarchy/Projects/dsh-atlas')],
  },
}

function mount(overrides: {
  browse?: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>
} = {}) {
  // React mounts into this slot, but the DIALOG is portaled to <body> (see the
  // picker: the shell's sidebar resize handle outranks anything reachable from
  // inside the plugin's slot). The dialog is a SIBLING of the slot, not a
  // descendant, so `container` names the scope these queries read — the document.
  const slot = document.createElement('div')
  document.body.appendChild(slot)
  const root: Root = createRoot(slot)
  const reader = async (path?: string) => {
    const level = LEVELS[path ?? '/']
    if (level === undefined) throw new Error(`no fixture level for ${String(path)}`)
    return level
  }
  const browse = vi.fn(overrides.browse ?? reader)
  const list = vi.fn(reader)
  const stub = {
    useFolderPicker: (select: (snapshot: { value: unknown }) => unknown) => select({ value: { span: {} } }),
    browse,
    list,
    create: async () => '',
    recent: async () => [],
    confirm: () => {},
    close: () => {},
    t,
    session: {},
  }
  flushSync(() => { root.render(<FolderPicker {...(stub as unknown as FolderPickerProps)} />) })
  return { container: document.body, root, browse, list }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise(resolve => { setTimeout(resolve, 0) })
    flushSync(() => {})
  }
}

/** Type a path into the path line the way a browser does, then let both the
 *  debounce and the request it triggers land. */
async function typePath(container: HTMLElement, value: string): Promise<void> {
  const field = input(container)
  vi.useFakeTimers()
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    flushSync(() => {
      field.focus()
      setter?.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.advanceTimersByTimeAsync(300)
  } finally {
    vi.useRealTimers()
  }
  await settle()
}

const rows = (container: HTMLElement) => [...container.querySelectorAll('.dsh_atlas_pickerRow')]
const rowNames = (container: HTMLElement) => rows(container).map(row => (row.textContent || '').trim())
const input = (container: HTMLElement) => container.querySelector('.dsh_atlas_pickerInput') as HTMLInputElement
const crumbNodes = (container: HTMLElement) => [...container.querySelectorAll('.dsh_atlas_pickerCrumb')] as HTMLElement[]
const crumbNames = (container: HTMLElement) => crumbNodes(container).map(node => (node.textContent || '').trim())

describe('the level the dialog walks', () => {
  it('renders the root as the first crumb of every level below it', async () => {
    const { container, root } = mount()
    await settle()
    await typePath(container, '/home')
    expect(crumbNames(container)).toEqual(['/', 'home'])
    root.unmount()
  })

  it('clicks back to the root from three levels down', async () => {
    const { container, root, browse } = mount()
    await settle()
    await typePath(container, '/home/omarchy/Projects')
    expect(input(container).value).toBe('/home/omarchy/Projects')
    // The root is still one click away, and that click asks the backend for `/` —
    // the crumb's own path, not a re-derivation of it.
    flushSync(() => { crumbNodes(container)[0]!.click() })
    await settle()
    expect(browse).toHaveBeenLastCalledWith('/', expect.anything())
    expect(input(container).value).toBe('/')
    root.unmount()
  })

  it('shows no crumbs at the root itself', async () => {
    const { container, root } = mount()
    await settle()
    expect(crumbNames(container)).toEqual([])
    root.unmount()
  })

  it('asks the backend for an unspecified level and shows whatever it answers', async () => {
    const { container, root, browse } = mount()
    await settle()
    // The dialog asks for NOTHING (no path yet). Deciding that "nothing" means
    // `/` is the HOST's job (`browseRoot`), not the dialog's — the dialog must not
    // invent a level of its own, or the two would drift apart.
    expect(browse).toHaveBeenCalledWith(undefined, expect.anything())
    expect(input(container).value).toBe('/')
    root.unmount()
  })

  it('renders the root\u2019s own folders rather than an empty list', async () => {
    const { container, root } = mount()
    await settle()
    // A POSIX root has no sibling drives; its children ARE the destinations.
    // Rendering only drives here is what left the reported dialog with no options.
    const names = rowNames(container)
    expect(names.some(name => name.includes('home'))).toBe(true)
    expect(names.some(name => name.includes('mnt'))).toBe(true)
    expect(names.some(name => name.includes('usr'))).toBe(true)
    root.unmount()
  })

  it('offers no drive affordance at a POSIX top level', async () => {
    const { container, root } = mount()
    await settle()
    // `/` arrives with `drives: []`, and the picker keyed its drive crumb on
    // `drives !== undefined` — so Linux rendered a "盘符" crumb, a Windows-shaped
    // control whose click only re-walked the level the user was already on.
    expect(crumbNames(container)).toEqual([])
    expect(container.textContent).not.toContain(zh['picker.drives'])
    root.unmount()
  })
})
