// @vitest-environment jsdom
/**
 * Attached-files dock presentation behavior: rows render for the @path
 * tokens parsed from the draft, the path button opens the file on the host,
 * the × removes exactly one token, and the settings switch hides the strip.
 */
import { describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import {
  draftMentions,
  FilesDock,
  formatTokenCount,
  referenceCost,
  withoutToken,
  type AtFileDockProps,
} from '../src/client/FilesDock.tsx'
import type { ReferenceInfo } from '../src/contract.ts'
import { fmt, zh } from '../src/client/locales.ts'
import { protectPastedMentions } from '../src/paste.ts'

// jsdom + React 18 without the act harness: flushSync commits renders, and
// plain clicks dispatch real handlers.
globalThis.IS_REACT_ACT_ENVIRONMENT = false

const t = (key: string, params?: Record<string, string>): string => fmt(zh[key] ?? key, params)

/** Minimal runtime stub cast onto the derived dock props. */
function props(over: {
  draft?: string
  onOpen?: (relative: string) => void
  setDraft?: (text: string) => void
  enabled?: boolean
  requestInspect?: (targets: readonly string[]) => void
  referenceInfo?: readonly ReferenceInfo[]
} = {}): AtFileDockProps {
  const stub = {
    session: {},
    input: {
      draft: over.draft ?? 'fix @src/client/view.ts please',
      imageIds: [],
      draftRev: 0,
      phase: 'plain',
      occurrences: [],
      queue: [],
    },
    inputActions: {
      setDraft: over.setDraft ?? (() => {}),
      addImages: () => false,
      removeImage: () => {},
      pruneImages: () => {},
      submit: () => {},
    },
    onOpen: over.onOpen ?? (() => {}),
    requestInspect: over.requestInspect ?? (() => {}),
    useScope: (selector: (snapshot: { value?: { enabled?: boolean } }) => boolean) =>
      selector(over.enabled === undefined ? {} : { value: { enabled: over.enabled } }),
    useReferenceInfo: (selector: (snapshot: { value: readonly ReferenceInfo[] }) => unknown) =>
      selector({ value: over.referenceInfo ?? [] }),
    t,
  }
  return stub as unknown as AtFileDockProps
}

function mount(element: ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return { root, container }
}

function click(element: Element | null): void {
  expect(element).not.toBeNull()
  element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('draftMentions', () => {
  it('parses @path tokens with their spans, stripping the directory slash', () => {
    expect(draftMentions('a @x.ts and @dir/ end')).toEqual([
      { kind: 'file', key: 2, label: 'x.ts', relative: 'x.ts', link: { kind: 'file', path: 'x.ts' }, start: 2, end: 7 },
      { kind: 'dir', key: 12, label: 'dir', relative: 'dir', link: { kind: 'folder', path: 'dir' }, start: 12, end: 17 },
    ])
  })

  it('deduplicates repeated tokens', () => {
    expect(draftMentions('@a.ts @a.ts')).toEqual([
      { kind: 'file', key: 0, label: 'a.ts', relative: 'a.ts', link: { kind: 'file', path: 'a.ts' }, start: 0, end: 5 },
    ])
  })

  it('parses skill, plugin, provider, and chat mentions alongside paths', () => {
    const mentions = draftMentions('@a.ts @skill:blender-modeling @plugin:dsh-atlas @atlas:git/src/a.ts @[Payment rates](dsh-session:YQ)')
    expect(mentions.map(mention => mention.kind)).toEqual(['file', 'skill', 'plugin', 'provider', 'chat'])
    expect(mentions[1]).toMatchObject({ kind: 'skill', label: 'blender-modeling' })
    expect(mentions[2]).toMatchObject({ kind: 'plugin', label: 'dsh-atlas' })
    // A provider item is not a workspace path: the handle stays visible, and the
    // row carries the provider mention for the seam to open.
    expect(mentions[3]).toEqual({
      kind: 'provider',
      key: 48,
      label: 'git/src/a.ts',
      link: { kind: 'atlas', provider: 'git', item: 'src/a.ts' },
      start: 48,
      end: 67,
    })
    expect(mentions[4]).toMatchObject({ kind: 'chat', label: 'Payment rates' })
  })

  it('ignores category prefixes in the dock', () => {
    expect(draftMentions('@file:src/a.ts')).toEqual([])
  })

  it('keeps a line range in the label while the open target stays the bare path', () => {
    expect(draftMentions('@src/a.ts:12-40')).toEqual([
      {
        kind: 'file',
        key: 0,
        label: 'src/a.ts:12-40',
        relative: 'src/a.ts',
        link: { kind: 'file', path: 'src/a.ts' },
        start: 0,
        end: 15,
      },
    ])
  })

  it('drops a line range from the directory chip form', () => {
    expect(draftMentions('@src/:1-2')).toEqual([
      {
        kind: 'dir',
        key: 0,
        label: 'src',
        relative: 'src',
        link: { kind: 'folder', path: 'src' },
        start: 0,
        end: 9,
      },
    ])
  })

  it('computes the token-free draft', () => {
    expect(withoutToken('@a.ts rest', 0, 5)).toBe(' rest')
  })
})

describe('FilesDock', () => {
  it('renders one row per @path token in the draft', () => {
    const { root, container } = mount(<FilesDock {...props({ draft: '@a.ts and @src/b.ts' })} />)
    expect(container.querySelectorAll('[data-atlas-row]')).toHaveLength(2)
    expect(container.textContent).toContain('a.ts')
    expect(container.textContent).toContain('src/b.ts')
    root.unmount()
  })

  it('renders nothing when the draft has no @path tokens', () => {
    const { root, container } = mount(<FilesDock {...props({ draft: 'plain text' })} />)
    expect(container.querySelectorAll('[data-atlas-row]')).toHaveLength(0)
    root.unmount()
  })

  it('does not render protected pasted tokens', () => {
    const { root, container } = mount(<FilesDock {...props({ draft: protectPastedMentions('@a.ts') })} />)
    expect(container.querySelectorAll('[data-atlas-row]')).toHaveLength(0)
    root.unmount()
  })

  it('hides the strip while the settings switch is off', () => {
    const { root, container } = mount(<FilesDock {...props({ draft: '@a.ts', enabled: false })} />)
    expect(container.querySelectorAll('[data-atlas-row]')).toHaveLength(0)
    root.unmount()
  })

  it('defaults to enabled before the first settings read', () => {
    const { root, container } = mount(<FilesDock {...props({ draft: '@a.ts', enabled: undefined })} />)
    expect(container.querySelectorAll('[data-atlas-row]')).toHaveLength(1)
    root.unmount()
  })

  it('opens the file through the shared action when the path is clicked', () => {
    const onOpen = vi.fn()
    const { root, container } = mount(<FilesDock {...props({ onOpen })} />)
    click(container.querySelector('[data-atlas-row] button'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith({ kind: 'file', path: 'src/client/view.ts' })
    root.unmount()
  })

  it('opens a provider row through the provider mention, not as a path', async () => {
    const onOpen = vi.fn()
    const requestInspect = vi.fn()
    const { root, container } = mount(<FilesDock {...props({
      draft: '@atlas:git/.dsh-atlas-git-smoke.md',
      onOpen,
      requestInspect,
    })} />)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    // The provider handle never becomes a path, so it is never inspected as one.
    expect(requestInspect).toHaveBeenCalledWith([])
    const row = container.querySelector('[data-atlas-row]') as HTMLElement
    expect(row.textContent).toContain('git/.dsh-atlas-git-smoke.md')
    click(row.querySelector('button') as Element)
    expect(onOpen).toHaveBeenCalledWith({ kind: 'atlas', provider: 'git', item: '.dsh-atlas-git-smoke.md' })
    root.unmount()
  })

  it('leaves a mention with no action inert', () => {
    const onOpen = vi.fn()
    const { root, container } = mount(<FilesDock {...props({ draft: '@skill:review', onOpen })} />)
    const row = container.querySelector('[data-atlas-row]') as HTMLElement
    // A skill row has no open button; only its remove button is interactive.
    expect(row.querySelector('.dsh_atFile_path')?.tagName).toBe('SPAN')
    expect(onOpen).not.toHaveBeenCalled()
    root.unmount()
  })

  it('removes exactly one token from the draft', () => {
    const setDraft = vi.fn()
    const { root, container } = mount(<FilesDock {...props({ draft: '@a.ts @b.ts', setDraft })} />)
    const rows = container.querySelectorAll('[data-atlas-row]')
    click(rows[1]!.querySelectorAll('button')[1]!)
    expect(setDraft).toHaveBeenCalledWith('@a.ts ')
    root.unmount()
  })

  it('asks the host to inspect the draft paths, deduplicated and sorted', async () => {
    const requestInspect = vi.fn()
    const { root } = mount(<FilesDock {...props({ draft: '@b.ts and @a.ts and @b.ts', requestInspect })} />)
    // Passive effects flush after the commit; yield one macrotask.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(requestInspect).toHaveBeenCalledWith(['a.ts', 'b.ts'])
    root.unmount()
  })

  it('renders the cost badge for a priced file', () => {
    const { root, container } = mount(<FilesDock {...props({
      draft: '@a.ts',
      referenceInfo: [{ relative: 'a.ts', exists: true, kind: 'file', size: 400 }],
    })} />)
    expect(container.querySelector('[data-atlas-cost]')?.textContent).toBe('≈100 tokens')
    root.unmount()
  })

  it('marks a heavy reference', () => {
    const { root, container } = mount(<FilesDock {...props({
      draft: '@big.ts',
      referenceInfo: [{ relative: 'big.ts', exists: true, kind: 'file', size: 40000 }],
    })} />)
    expect(container.querySelector('[data-atlas-cost]')?.className).toContain('dsh_atFile_cost_warn')
    expect(container.querySelector('[data-atlas-cost]')?.textContent).toBe('≈10k tokens')
    root.unmount()
  })

  it('flags a reference that no longer resolves', () => {
    const { root, container } = mount(<FilesDock {...props({
      draft: '@gone.ts',
      referenceInfo: [{ relative: 'gone.ts', exists: false }],
    })} />)
    expect(container.querySelector('[data-atlas-missing]')?.textContent).toBe('已失效')
    expect(container.querySelector('[data-atlas-cost]')).toBeNull()
    root.unmount()
  })

  it('prices an out-of-workspace path the draft spelled with backslashes', () => {
    // The Host answers that path in its canonical spelling (forward slashes); the
    // row keys its verdicts through `referenceKey`, so the badge lands either way.
    const { root, container } = mount(<FilesDock {...props({
      draft: '@E:\\outsidedir\\AI.md',
      referenceInfo: [{ relative: 'E:/outsidedir/AI.md', exists: true, kind: 'file', size: 400, outside: true }],
    })} />)
    expect(container.querySelector('[data-atlas-cost]')?.textContent).toBe('≈100 tokens')
    root.unmount()
  })

  it('offers no open action for a reference that no longer resolves', () => {
    const onOpen = vi.fn()
    const { root, container } = mount(<FilesDock {...props({
      draft: '@gone.ts',
      onOpen,
      referenceInfo: [{ relative: 'gone.ts', exists: false }],
    })} />)
    const row = container.querySelector('[data-atlas-row]') as HTMLElement
    // The row keeps its 已失效 badge, but it is no longer a button: handing a
    // vanished path to a viewer is what makes a Sidebar throw its own 400.
    expect(row.querySelector('.dsh_atFile_path')?.tagName).toBe('SPAN')
    expect(row.querySelector('[data-atlas-missing]')?.textContent).toBe('已失效')
    expect(onOpen).not.toHaveBeenCalled()
    root.unmount()
  })

  it('opens a hand-typed directory as the folder the Host says it is', () => {
    const onOpen = vi.fn()
    const { root, container } = mount(<FilesDock {...props({
      draft: '@outsidedir',
      onOpen,
      referenceInfo: [{ relative: 'outsidedir', exists: true, kind: 'dir' }],
    })} />)
    const row = container.querySelector('[data-atlas-row]') as HTMLElement
    // The token has no trailing separator, so the dock's own parse calls it a file;
    // the Host's verdict for that exact path says directory. Row and draft token must
    // agree — and the row must open the folder, not hand a directory to a viewer.
    expect(row.querySelector('svg')?.getAttribute('class')).toContain('tabler-icon-folder')
    ;(row.querySelector('.dsh_atFile_path') as HTMLElement).click()
    expect(onOpen).toHaveBeenCalledWith({ kind: 'folder', path: 'outsidedir' })
    root.unmount()
  })
})

describe('reference cost helpers', () => {
  it('formats token counts compactly', () => {
    expect(formatTokenCount(820)).toBe('820')
    expect(formatTokenCount(1000)).toBe('1.0k')
    expect(formatTokenCount(12345)).toBe('12k')
  })

  it('prices existing files only', () => {
    expect(referenceCost(undefined)).toBeUndefined()
    expect(referenceCost({ relative: 'd', exists: true, kind: 'dir' })).toBeUndefined()
    expect(referenceCost({ relative: 'g', exists: false })).toBeUndefined()
    expect(referenceCost({ relative: 'f', exists: true, kind: 'file', size: 40 })).toEqual({ tokens: 10, warn: false })
    expect(referenceCost({ relative: 'big', exists: true, kind: 'file', size: 40000 }))
      .toEqual({ tokens: 10000, warn: true })
  })
})