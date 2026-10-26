// @vitest-environment jsdom
/**
 * The folder tab: one directory, one level, walked in place. The tab exists
 * because a directory has nowhere else to go in the sidebar — the file viewers
 * answer it with `"…" is a directory`, and the built-in files tab claims no
 * address — so these cases pin what a folder click actually shows.
 */
import { describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { DirectoryListing } from '../src/contract.ts'
import { childOf, FolderTab, folderTabDefinition, type FolderTabProps } from '../src/client/FolderTab.tsx'
import { folderAddress, folderPathOf } from '../src/client/reference-links.ts'
import { fmt, zh } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

const t = (key: string, params?: Record<string, string>): string => fmt(zh[key] ?? key, params)

/** Mount the tab over one injected listing, with the tab address it was opened at. */
function mountTab(options: {
  path: string
  listing: (path: string, include?: string) => DirectoryListing
  openFile?: (path: string) => void
  openNative?: (path: string) => void
  /** The object the second click asked for, delivered as tab navigation params. */
  select?: string
  /** Where to mount, for the one case that needs a scrollable ancestor. */
  host?: HTMLElement
}): {
  container: HTMLElement
  root: Root
  /** Every path the tab listed. */
  asked: string[]
  /** Every `include` the tab named, in step with {@link mountTab}'s `asked`. */
  includes: (string | undefined)[]
  /** The live tab params, so a test can re-point the SAME tab at another object. */
  state: { select?: string }
  /** Re-render with the current state, the way the shell reveals the same tab. */
  rerender: () => void
} {
  const asked: string[] = []
  const includes: (string | undefined)[] = []
  const state: { select?: string } = { select: options.select }
  const container = document.createElement('div')
  ;(options.host ?? document.body).appendChild(container)
  const root = createRoot(container)
  const stub = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'right' },
      tab: {
        id: 't1',
        kind: 'atlas-folder',
        contentId: folderAddress(options.path),
        navigation: {
          address: folderAddress(options.path),
          params: state.select === undefined ? undefined : { select: state.select },
          revision: 0,
        },
        visible: true,
        signal: new AbortController().signal,
        actions: { openResource: () => {}, openTab: () => {}, close: () => {} },
      },
    }),
    list: async (path: string, _signal: AbortSignal, include?: string) => {
      asked.push(path)
      includes.push(include)
      return options.listing(path, include)
    },
    openFile: options.openFile ?? (() => {}),
    openNative: options.openNative ?? (() => {}),
    t,
    session: {},
  }
  const render = (): void => {
    flushSync(() => {
      root.render(<FolderTab {...(stub as unknown as FolderTabProps)} />)
    })
  }
  render()
  return { container, root, asked, includes, state, rerender: render }
}

/** Let the listing promise settle and the re-render commit. */
async function settle(): Promise<void> {
  // Passive effects are scheduled, not synchronous: yield a MACROtask (as the dock
  // spec does) and flush the commit that each answer produces.
  for (let round = 0; round < 3; round += 1) {
    await new Promise(resolve => { setTimeout(resolve, 0) })
    flushSync(() => {})
  }
}

const listing = (path: string, entries: DirectoryListing['entries'], extra: Partial<DirectoryListing> = {}): DirectoryListing => ({
  path,
  parent: 'E:/root',
  entries,
  ...extra,
})

/**
 * jsdom has no layout, so the one scroll assertion needs a fake: a host that is
 * exactly 100px tall holding a 20px row at a known offset, whose reported
 * position FOLLOWS the host's `scrollTop` (otherwise the second pass would
 * scroll a row that the first pass already brought into sight).
 */
function fakeLayout(rowTop: number, rowHeight = 20): {
  host: HTMLElement
  intoView: ReturnType<typeof vi.fn>
  restore: () => void
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: 100, configurable: true })
  const rect = (top: number, bottom: number): DOMRect => ({
    top, bottom, left: 0, right: 0, height: bottom - top, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect
  const proto = Element.prototype as unknown as { getBoundingClientRect: () => DOMRect; scrollIntoView?: unknown }
  const original = proto.getBoundingClientRect
  const originalInto = proto.scrollIntoView
  const intoView = vi.fn()
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    if (this === host) return rect(0, 100)
    // The component keeps a ref on the `li` that holds the row button (the ref is
    // what a real browser measures too), so the stub has to answer for that node.
    if (this.firstElementChild?.classList.contains('dsh_atlas_folderRow') === true) {
      return rect(rowTop - host.scrollTop, rowTop - host.scrollTop + rowHeight)
    }
    return rect(0, 0)
  }
  // `scrollIntoView` is the thing that must NOT be used, so it has to exist to be
  // watched: jsdom does not implement it, and the tab must not add it either.
  proto.scrollIntoView = intoView
  return {
    host,
    intoView,
    restore: () => { proto.getBoundingClientRect = original; proto.scrollIntoView = originalInto },
  }
}

describe('the folder tab', () => {
  it('lists one level with directories first and files openable', async () => {
    const openFile = vi.fn()
    const { container, root } = mountTab({
      path: 'E:/root/ws',
      listing: path => listing(path, [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }]),
      openFile,
    })
    await settle()
    const rows = [...container.querySelectorAll('.dsh_atlas_folderRow')]
    expect(rows.map(row => row.textContent)).toEqual(['src/', 'README.md'])
    // A directory row descends IN THIS TAB (the same listing is asked again for the
    // child), a file row opens the file through the shared reference action.
    ;(rows[0] as HTMLElement).click()
    await settle()
    expect(container.querySelector('.dsh_atlas_folderPath')?.textContent).toBe('E:/root/ws/src')
    const childRows = [...container.querySelectorAll('.dsh_atlas_folderRow')]
    ;(childRows[1] as HTMLElement).click()
    expect(openFile).toHaveBeenCalledWith('E:/root/ws/src/README.md')
    root.unmount()
  })

  it('walks back up and hands the folder to the OS opener', async () => {
    const openNative = vi.fn()
    const { container, root } = mountTab({
      path: 'E:/root/ws',
      listing: path => listing(path, [], { parent: 'E:/root' }),
      openNative,
    })
    await settle()
    const up = container.querySelector('.dsh_atlas_folderUp') as HTMLButtonElement
    expect(up.disabled).toBe(false)
    up.click()
    await settle()
    expect(container.querySelector('.dsh_atlas_folderPath')?.textContent).toBe('E:/root')
    ;(container.querySelector('.dsh_atlas_folderOpen') as HTMLElement).click()
    expect(openNative).toHaveBeenCalledWith('E:/root')
    root.unmount()
  })

  it('offers the other drives at a drive root, where there is no parent', async () => {
    const { container, root } = mountTab({
      path: 'E:/',
      listing: path => ({ path, entries: [], drives: ['C:/', 'E:/'] }),
    })
    await settle()
    expect((container.querySelector('.dsh_atlas_folderUp') as HTMLButtonElement).disabled).toBe(true)
    expect([...container.querySelectorAll('.dsh_atlas_folderRow')].map(row => row.textContent)).toEqual(['C:/', 'E:/'])
    root.unmount()
  })

  it('shows no other-drives section at a POSIX top level, where there are none', async () => {
    // The Host answers `/` with `drives: []` on Linux. Keyed on `drives !== undefined`,
    // the tab rendered an empty "其他盘符" list there — a heading with nothing under
    // it, in the menu that was reported as showing no options.
    const { container, root } = mountTab({
      path: '/',
      listing: path => ({ path, entries: [{ name: 'home', kind: 'dir' }], drives: [] }),
    })
    await settle()
    expect(container.querySelector(`[aria-label="${zh['folder.drives']}"]`)).toBeNull()
    expect([...container.querySelectorAll('.dsh_atlas_folderRow')].map(row => row.textContent)).toEqual(['home/'])
    root.unmount()
  })

  it('still calls a POSIX top level empty when it has neither drives nor children', async () => {
    // An empty `drives` list must not be mistaken for "this level has something to
    // show": the empty notice is suppressed only by a REAL drive list.
    const { container, root } = mountTab({
      path: '/',
      listing: path => ({ path, entries: [], drives: [] }),
    })
    await settle()
    expect(container.querySelector('.dsh_atlas_folderNote')?.textContent).toBe(zh['folder.empty'])
    root.unmount()
  })

  it('marks the row the second click asked for, and only that row', async () => {
    const { container, root } = mountTab({
      path: 'E:/root/ws',
      listing: path => listing(path, [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }]),
      select: 'README.md',
    })
    await settle()
    const marked = [...container.querySelectorAll('.dsh_atlas_folderRowSelected')]
    expect(marked.map(row => row.textContent)).toEqual(['README.md'])
    // Marked for the eyes (class), for an end-to-end check (data), and for a
    // screen reader (aria-current) — and the other row carries none of it.
    expect(marked[0].getAttribute('data-atlas-selected')).toBe('')
    expect(marked[0].getAttribute('aria-current')).toBe('true')
    expect(container.querySelectorAll('[data-atlas-selected]').length).toBe(1)
    expect(container.querySelectorAll('[aria-current]').length).toBe(1)
    root.unmount()
  })

  it('marks nothing when the tab was opened without a selection', async () => {
    const { container, root } = mountTab({
      path: 'E:/root/ws',
      listing: path => listing(path, [{ name: 'README.md', kind: 'file' }]),
    })
    await settle()
    expect(container.querySelector('.dsh_atlas_folderRowSelected')).toBeNull()
    expect(container.querySelector('[data-atlas-selected]')).toBeNull()
    expect(container.querySelector('[aria-current]')).toBeNull()
    root.unmount()
  })

  it('marks nothing when the selection names something this folder does not hold', async () => {
    // The selection must be honoured by identity, not by nearest match: the folder
    // actually shown is not the one that was asked for, so highlighting any row in
    // it would point at the wrong object.
    const { container, root } = mountTab({
      path: 'E:/root/ws',
      listing: path => listing(path, [{ name: 'src', kind: 'dir' }]),
      select: 'README.md',
    })
    await settle()
    expect(container.querySelector('.dsh_atlas_folderRowSelected')).toBeNull()
    root.unmount()
  })

  it('names the selected row so a capped page can put it back', async () => {
    // The Host applies the entry cap BEFORE it sorts, so on a huge folder the page
    // can simply not contain the object the second click asked for — measured on a
    // real 2093-entry share, which answered 200 rows holding neither that file nor
    // ten of its siblings. The tab therefore NAMES the one entry it needs, and the
    // Host re-checks that single path and puts the row first; without the name the
    // folder would open with nothing marked at all.
    const { container, root, includes } = mountTab({
      path: 'E:/huge',
      listing: (path, include) => listing(
        path,
        include === 'late.txt'
          ? [{ name: 'late.txt', kind: 'file', pinned: true }, { name: 'a.txt', kind: 'file' }]
          : [{ name: 'a.txt', kind: 'file' }],
        { truncated: true },
      ),
      select: 'late.txt',
    })
    await settle()
    // Exactly the selection is named, once, on the first and only listing.
    expect(includes).toEqual(['late.txt'])
    const marked = container.querySelector('.dsh_atlas_folderRowSelected')
    expect(marked?.textContent).toBe('late.txt')
    expect(marked?.getAttribute('data-atlas-selected')).toBe('')
    // The put-back row is labelled as such, so an end-to-end check can tell it from
    // a row that merely happened to fall inside the cap.
    expect(marked?.getAttribute('data-atlas-pinned')).toBe('')
    expect(container.querySelectorAll('[data-atlas-pinned]').length).toBe(1)
    // Completing the page does not claim the folder was fully listed.
    expect(container.querySelector('.dsh_atlas_folderNote')?.textContent).toBe(zh['folder.truncated'])
    root.unmount()
  })

  it('names nothing when the tab was opened without a selection', async () => {
    // No selection means no extra filesystem check on the Host: the shell turns the
    // missing name into the empty-string sentinel, and the tab must not invent one.
    const { container, root, includes } = mountTab({
      path: 'E:/root/ws',
      listing: path => listing(path, [{ name: 'a.ts', kind: 'file' }]),
    })
    await settle()
    expect(includes).toEqual([undefined])
    expect(container.querySelector('[data-atlas-pinned]')).toBeNull()
    root.unmount()
  })

  it('follows new params when the same tab is pointed at another object', async () => {
    // Re-opening an address reveals the tab that already holds it — that is what
    // makes the address the tab's identity — so a second click on a sibling arrives
    // as new params on an already-listed tab. The listing must follow the SELECTION,
    // not just the path, or the folder would keep the previous row marked.
    const { container, root, asked, includes, state, rerender } = mountTab({
      path: 'E:/root/ws',
      listing: (path, include) => listing(path, [
        { name: 'src', kind: 'dir' },
        { name: 'README.md', kind: 'file' },
      ].map(entry => (include === entry.name ? { ...entry, pinned: true as const } : entry))),
      select: 'README.md',
    })
    await settle()
    expect(container.querySelector('.dsh_atlas_folderRowSelected')?.textContent).toBe('README.md')
    state.select = 'src'
    rerender()
    await settle()
    // Asked again, with the new name — one more listing, not a second tab.
    expect(asked).toEqual(['E:/root/ws', 'E:/root/ws'])
    expect(includes).toEqual(['README.md', 'src'])
    const marked = [...container.querySelectorAll('.dsh_atlas_folderRowSelected')]
    expect(marked.map(row => row.textContent)).toEqual(['src/'])
    root.unmount()
  })

  it('scrolls the one scrolling ancestor to reach the selected row, never the page', async () => {
    const layout = fakeLayout(500)
    try {
      const { root } = mountTab({
        path: 'E:/root/ws',
        listing: path => listing(path, [{ name: 'a.ts', kind: 'file' }]),
        select: 'a.ts',
        host: layout.host,
      })
      await settle()
      // Only the pixels the row is out of sight, applied to the nearest scrollable
      // ancestor. `scrollIntoView` would also scroll the Sidebar's own viewport and
      // the chat behind it — the picker's `3abd603` regression, which must not
      // return here.
      expect(layout.host.scrollTop).toBe(420)
      expect(layout.intoView).not.toHaveBeenCalled()
      root.unmount()
    } finally {
      layout.restore()
    }
  })

  it('leaves the scroll alone when the selected row is already in sight', async () => {
    const layout = fakeLayout(40)
    try {
      const { root } = mountTab({
        path: 'E:/root/ws',
        listing: path => listing(path, [{ name: 'a.ts', kind: 'file' }]),
        select: 'a.ts',
        host: layout.host,
      })
      await settle()
      expect(layout.host.scrollTop).toBe(0)
      expect(layout.intoView).not.toHaveBeenCalled()
      root.unmount()
    } finally {
      layout.restore()
    }
  })

  it('says why a folder cannot be listed instead of showing it empty', async () => {
    const { container, root } = mountTab({
      path: 'E:/outside',
      listing: path => ({ path, entries: [], error: 'outside' }),
    })
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(zh['folder.error.outside'])
    expect(container.querySelector('.dsh_atlas_folderRow')).toBeNull()
    root.unmount()
  })

  it('reports a failed listing rather than an empty folder', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const stub = {
      useTabInfo: () => ({ tab: { contentId: folderAddress('E:/x'), navigation: { address: folderAddress('E:/x') } } }),
      list: async () => { throw new Error('host down') },
      openFile: () => {}, openNative: () => {}, t, session: {},
    }
    flushSync(() => { root.render(<FolderTab {...(stub as unknown as FolderTabProps)} />) })
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('host down')
    root.unmount()
  })
})

describe('the folder address', () => {
  it('round-trips a path, drive colon and spaces included', () => {
    expect(folderAddress('E:\\outsidedir\\Rust\\DSH')).toBe('dsh-resource://folder/E:/outsidedir/Rust/DSH')
    expect(folderPathOf('dsh-resource://folder/E:/outsidedir/Rust/DSH')).toBe('E:/outsidedir/Rust/DSH')
    expect(folderPathOf(folderAddress('E:/a b/c#d'))).toBe('E:/a b/c#d')
    // Not ours, empty, or malformed: no folder is guessed.
    expect(folderPathOf('dsh-resource://file/session/s/README.md')).toBeUndefined()
    expect(folderPathOf('dsh-resource://folder/')).toBeUndefined()
    expect(folderPathOf(undefined)).toBeUndefined()
    expect(folderPathOf('dsh-resource://folder/%E0%A4%A')).toBeUndefined()
  })

  it('joins a child under a drive root without doubling the separator', () => {
    expect(childOf('E:/', 'ws')).toBe('E:/ws')
    expect(childOf('E:/root/ws', 'src')).toBe('E:/root/ws/src')
    expect(folderTabDefinition(t).patterns).toEqual(['dsh-resource://folder/**'])
    expect(folderTabDefinition(t).title('dsh-resource://folder/E:/root/ws')).toBe('ws')
    expect(folderTabDefinition(t).title('dsh-resource://nope')).toBe(zh['folder.title'])
  })
})
