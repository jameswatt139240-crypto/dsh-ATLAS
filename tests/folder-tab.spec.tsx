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
  listing: (path: string) => DirectoryListing
  openFile?: (path: string) => void
  openNative?: (path: string) => void
}): { container: HTMLElement; root: Root; asked: string[] } {
  const asked: string[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const stub = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'right' },
      tab: {
        id: 't1',
        kind: 'atlas-folder',
        contentId: folderAddress(options.path),
        navigation: { address: folderAddress(options.path), params: undefined, revision: 0 },
        visible: true,
        signal: new AbortController().signal,
        actions: { openResource: () => {}, openTab: () => {}, close: () => {} },
      },
    }),
    list: async (path: string) => { asked.push(path); return options.listing(path) },
    openFile: options.openFile ?? (() => {}),
    openNative: options.openNative ?? (() => {}),
    t,
    session: {},
  }
  flushSync(() => {
    root.render(<FolderTab {...(stub as unknown as FolderTabProps)} />)
  })
  return { container, root, asked }
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
