// @vitest-environment jsdom
/**
 * Sent-message reference click-through: the chip decode, the file address the
 * bridge opens, and the delegated click/hover behavior over real chip DOM  -- the
 * chips the installed client renders inert (`<span data-ref-chip title="@path">`).
 */
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { absoluteFileAddress as absoluteFileAddressOfHarness, fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import {
  chipLink,
  composerChipLink,
  draftPathForLabel,
  LINK_ATTRIBUTE,
  MISSING_ATTRIBUTE,
  ReferenceLinks,
  type ReferenceLinksProps,
} from '../src/client/ReferenceLinks.tsx'
import { decodeDraftReference, decodeReferenceLink, absoluteFileAddress, sessionFileAddress } from '../src/client/reference-links.ts'
import { cssText } from '../src/client/styles.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

/**
 * Mounted bridges still alive. The bridge observes document.body by design, so a
 * bridge that outlives its test  -- including one left behind when a test throws
 * before its own unmount  -- would let the NEXT test's chip be marked by the old
 * face. The file therefore unmounts every leftover after each test.
 */
const liveRoots = new Set<Root>()

/** Unmount one bridge; idempotent, so a test may tear down explicitly. */
function unmountBridge(root: Root): void {
  if (!liveRoots.delete(root)) return
  root.unmount()
}

afterEach(() => {
  for (const root of [...liveRoots]) unmountBridge(root)
  document.body.innerHTML = ''
})

/**
 * Mount the bridge with one piece of chip DOM beside it.
 * @param html - the markup the bridge must act on.
 * @param openable - whether the injected face claims an action for the chip.
 * @param resolveLabel - the injected label resolver for composer chips.
 * @param draft - the composer's draft text, for the label fallback.
 * @returns the root, the first chip, its container, and the action spy.
 */
function mountBridge(
  html: string,
  openable = true,
  resolveLabel: (label: string) => string | undefined = label => label,
  draft = '',
): {
  root: Root
  host: HTMLElement
  chip: HTMLElement
  opened: ReturnType<typeof vi.fn>
  actionFor: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  const root = createRoot(container)
  liveRoots.add(root)
  const opened = vi.fn()
  const actionFor = vi.fn((_link: unknown) => (openable ? () => { opened(_link) } : undefined))
  const useInput = (select: (state: { draft: string }) => unknown): unknown => select({ draft })
  flushSync(() => {
    root.render(<ReferenceLinks {...({ actionFor, resolveLabel, useInput } as unknown as ReferenceLinksProps)} />)
  })
  // Flush the passive effects (the mark sweep, the observer, the listeners) now,
  // so a test that unmounts in the same tick tears them down instead of leaving
  // the observer for a later microtask to install after the cleanup ran.
  flushSync(() => {})
  return { root, host, chip: host.firstElementChild as HTMLElement, opened, actionFor }
}

/** Re-render the bridge with a different injected face. */
function rerenderBridge(root: Root, actionFor: unknown): void {
  flushSync(() => {
    root.render(<ReferenceLinks {...({
      actionFor,
      resolveLabel: (label: string) => label,
      useInput: (select: (state: { draft: string }) => unknown) => select({ draft: '' }),
    } as unknown as ReferenceLinksProps)} />)
  })
  flushSync(() => {})
}

/** A click as a browser delivers it outside a selection. */
const click = (target: Element): MouseEvent => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
  target.dispatchEvent(event)
  return event
}

const FILE_CHIP = '<span data-ref-chip="file" title="@outsidedir/关于源代码许可的分析.md"><svg></svg>分析.md</span>'

describe('decodeReferenceLink', () => {
  it('decodes the mention forms that name something openable', () => {
    expect(decodeReferenceLink('@outsidedir/关于源代码许可的分析.md'))
      .toEqual({ kind: 'file', path: 'outsidedir/关于源代码许可的分析.md' })
    expect(decodeReferenceLink('@"docs/a b.md"')).toEqual({ kind: 'file', path: 'docs/a b.md' })
    expect(decodeReferenceLink('@skill:blender-modeling')).toEqual({ kind: 'skill', name: 'blender-modeling' })
    // A provider handle keeps both halves: the provider owns the item.
    expect(decodeReferenceLink('@atlas:git/.dsh-atlas-git-smoke.md'))
      .toEqual({ kind: 'atlas', provider: 'git', item: '.dsh-atlas-git-smoke.md' })
    expect(decodeReferenceLink('@atlas:git/diff:src/a.ts'))
      .toEqual({ kind: 'atlas', provider: 'git', item: 'diff:src/a.ts' })
  })

  it('decodes an out-of-workspace absolute path as a file', () => {
    // The drive letter is a PATH, not a handle: these are ordinary file
    // references now that external paths exist, in either separator spelling.
    expect(decodeReferenceLink('@E:\\outsidedir\\Rust\\DSH\\outsidedir\\notes.md'))
      .toEqual({ kind: 'file', path: 'E:\\outsidedir\\Rust\\DSH\\outsidedir\\notes.md' })
    expect(decodeReferenceLink('@E:/outsidedir/Rust/DSH/outsidedir/notes.md'))
      .toEqual({ kind: 'file', path: 'E:/outsidedir/Rust/DSH/outsidedir/notes.md' })
    expect(decodeReferenceLink('@C:/x.ts')).toEqual({ kind: 'file', path: 'C:/x.ts' })
    // A drive-RELATIVE spelling names nothing stable and stays inert, and our
    // own `file:`-style category prefixes are not paths either.
    expect(decodeReferenceLink('@E:notes.md')).toBeUndefined()
    expect(decodeReferenceLink('@file:src/a.ts')).toBeUndefined()
    // The folder form of an absolute path, through the draft decoder.
    expect(decodeDraftReference('@E:\\outsidedir\\')).toEqual({ kind: 'folder', path: 'E:\\outsidedir' })
    expect(decodeDraftReference('@E:/outsidedir/')).toEqual({ kind: 'folder', path: 'E:/outsidedir' })
  })

  it('rejects the forms that only render as a chip', () => {
    // A plugin handle is a label, not a resource.
    expect(decodeReferenceLink('@plugin:dsh-atlas')).toBeUndefined()
    // A folder mention is its own chip kind (a bare separator is not a file).
    expect(decodeReferenceLink('@docs/')).toBeUndefined()
    expect(decodeReferenceLink('@docs\\')).toBeUndefined()
    expect(decodeReferenceLink('@[label](dsh-session:abc)')).toBeUndefined()
  })

  it('rejects empty and malformed labels', () => {
    expect(decodeReferenceLink('@')).toBeUndefined()
    expect(decodeReferenceLink('@skill:')).toBeUndefined()
    expect(decodeReferenceLink('@atlas:')).toBeUndefined()
    expect(decodeReferenceLink('@atlas:git')).toBeUndefined()
    expect(decodeReferenceLink('@atlas:/item')).toBeUndefined()
    expect(decodeReferenceLink('@atlas:git/')).toBeUndefined()
    expect(decodeReferenceLink('@"unclosed')).toBeUndefined()
    expect(decodeReferenceLink('@"')).toBeUndefined()
    expect(decodeReferenceLink('plain text')).toBeUndefined()
    expect(decodeReferenceLink('')).toBeUndefined()
    expect(decodeReferenceLink(null)).toBeUndefined()
    expect(decodeReferenceLink(undefined)).toBeUndefined()
  })
})

describe('decodeDraftReference', () => {
  it('adds the folder form the editor decorates by syntax', () => {
    expect(decodeDraftReference('@src/')).toEqual({ kind: 'folder', path: 'src' })
    expect(decodeDraftReference('@src\\')).toEqual({ kind: 'folder', path: 'src' })
    // Everything the chip decoder knows still decodes the same way.
    expect(decodeDraftReference('@a.ts')).toEqual({ kind: 'file', path: 'a.ts' })
    expect(decodeDraftReference('@atlas:git/x.ts')).toEqual({ kind: 'atlas', provider: 'git', item: 'x.ts' })
  })

  it('refuses a slash mention, a bare trigger and an empty folder', () => {
    expect(decodeDraftReference('/review')).toBeUndefined()
    expect(decodeDraftReference('@')).toBeUndefined()
    expect(decodeDraftReference('@/')).toBeUndefined()
    expect(decodeDraftReference('@plugin:x')).toBeUndefined()
  })
})

describe('sessionFileAddress', () => {
  const PATHS: readonly string[] = [
    'a.ts',
    'docs/a b.md',
    'outsidedir/关于源代码许可的分析.md',
    './src/x.ts',
    'src\\x.ts',
    'a#b?c.ts',
    'C:/x.ts',
    '/abs/x.ts',
  ]

  it('spells exactly what the Harness spells', () => {
    // The grammar lives in the Harness (`dsh-util-workspace-path`); this port
    // must stay byte-identical, and the test fails the moment it does not.
    for (const path of PATHS) {
      expect(sessionFileAddress('s1', path)).toBe(fileAddressFor('s1', undefined, path))
    }
  })

  it('encodes every segment and keeps a drive colon literal', () => {
    const cjk = encodeURIComponent('关于源代码许可的分析.md')
    expect(sessionFileAddress('s1', 'outsidedir/关于源代码许可的分析.md'))
      .toBe(`dsh-resource://file/session/s1/outsidedir/${cjk}`)
    expect(sessionFileAddress('s1', 'docs/a b.md')).toBe('dsh-resource://file/session/s1/docs/a%20b.md')
    // Backslashes normalize and a leading `./` is dropped, as the Harness does.
    expect(sessionFileAddress('s1', '.\\src\\x.ts')).toBe('dsh-resource://file/session/s1/src/x.ts')
    expect(sessionFileAddress('a b', 'x.ts')).toBe('dsh-resource://file/session/a%20b/x.ts')
  })
})

describe('absoluteFileAddress', () => {
  it('spells exactly what the Harness spells for the absolute scope', () => {
    // Same pin as the session form: the grammar belongs to the Harness, and this
    // port must stay byte-identical for out-of-workspace references.
    for (const path of ['E:/outside/x.ts', 'E:\\outside\\notes.md', '/home/ys/a b.md']) {
      expect(absoluteFileAddress(path)).toBe(absoluteFileAddressOfHarness(path))
    }
    expect(absoluteFileAddress('E:\\outsidedir\\Rust\\DSH\\deepseek-harness'))
      .toBe('dsh-resource://file/absolute/E:/outsidedir/Rust/DSH/deepseek-harness')
    expect(absoluteFileAddress('/home/ys/a b.md')).toBe('dsh-resource://file/absolute/home/ys/a%20b.md')
  })
})

describe('chipLink', () => {
  /** One chip element with the given attributes. */
  const chipOf = (tag: 'span' | 'button', kind: string, title: string): Element => {
    const element = document.createElement(tag)
    element.setAttribute('data-ref-chip', kind)
    element.setAttribute('title', title)
    return element
  }

  it('reads the link of an inert chip', () => {
    expect(chipLink(chipOf('span', 'file', '@a.ts'))).toEqual({ kind: 'file', path: 'a.ts' })
  })

  it('refuses a chip the framework already wired, and every other kind', () => {
    expect(chipLink(chipOf('button', 'file', '@a.ts'))).toBeUndefined()
    expect(chipLink(chipOf('span', 'session', '@a.ts'))).toBeUndefined()
    expect(chipLink(chipOf('span', 'file', '@plugin:x'))).toBeUndefined()
  })
})

/** One composer chip exactly as the framework mounts it: host element plus body. */
function composerChip(label: string, body = true): string {
  return '<span data-composer-chip="sidebar" contenteditable="false">'
    + (body
      ? `<span class="chipBody" title="${label}"><span class="marker" aria-hidden="true">@</span>`
        + `<span class="label">${label}</span></span>`
      : '')
    + '</span>'
}

describe('composerChipLink', () => {
  /** Mount the markup and hand back the composer chip's host element. */
  const hostOf = (html: string): Element => {
    const holder = document.createElement('div')
    holder.innerHTML = html
    return holder.firstElementChild as Element
  }

  it('reads the label the chip body carries, which the editor draws without its `@`', () => {
    // The framework renders the visible `@` as a marker span next to the label,
    // so the label itself is the bare path (or the full spelling, for a source
    // that keeps it).
    expect(composerChipLink(hostOf(composerChip('CHANGELOG.md'))))
      .toEqual({ kind: 'file', path: 'CHANGELOG.md' })
    expect(composerChipLink(hostOf(composerChip('@AGENTS.md'))))
      .toEqual({ kind: 'file', path: 'AGENTS.md' })
    // An icon-only chip carries the label in the title and no `@` text at all.
    expect(composerChipLink(hostOf('<span data-composer-chip="sidebar"><span title="outsidedir/"></span></span>')))
      .toEqual({ kind: 'folder', path: 'outsidedir' })
  })

  it('falls back to the host text before the body has rendered', () => {
    expect(composerChipLink(hostOf('<span data-composer-chip="sidebar">AGENTS.md</span>')))
      .toEqual({ kind: 'file', path: 'AGENTS.md' })
  })

  it('refuses a chip that names no reference of ours', () => {
    expect(composerChipLink(hostOf(composerChip('/review')))).toBeUndefined()
    expect(composerChipLink(hostOf(composerChip('')))).toBeUndefined()
    expect(composerChipLink(hostOf(composerChip('plugin:dsh-atlas')))).toBeUndefined()
    expect(composerChipLink(hostOf('<span data-composer-chip="sidebar"></span>'))).toBeUndefined()
  })

  it('stays inert while the label cannot name one file', () => {
    // Two indexed paths answer to this basename: the label alone cannot say
    // which one is meant, so nothing is offered to the pointer.
    expect(composerChipLink(hostOf(composerChip('index.ts')), () => undefined)).toBeUndefined()
  })
})

describe('draftPathForLabel', () => {
  it('reads the one draft token a bare label names', () => {
    // The chip shows `@index.ts` while the draft keeps the mention the source
    // serializes, which is the only place the full path survives.
    expect(draftPathForLabel('看 @src/client/index.ts 和别的', 'index.ts')).toBe('src/client/index.ts')
    // A range spelling and a directory form still compare by their path.
    expect(draftPathForLabel('@src/a.ts:12-40', 'a.ts')).toBe('src/a.ts')
    expect(draftPathForLabel('@docs/', 'docs')).toBe('docs')
    expect(draftPathForLabel('@AGENTS.md', 'CHANGELOG.md')).toBeUndefined()
    expect(draftPathForLabel('', 'a.ts')).toBeUndefined()
  })

  it('refuses the label when the draft itself is ambiguous, or quoted', () => {
    expect(draftPathForLabel('@src/index.ts @tests/index.ts', 'index.ts')).toBeUndefined()
    // A quoted mention holds whitespace, so it cannot be read as one token here.
    expect(draftPathForLabel('@"a b/index.ts"', 'index.ts')).toBeUndefined()
  })
})

describe('ReferenceLinks bridge', () => {
  it('opens the file a sent-message chip names, from a click on its icon', () => {
    const { root, chip, opened } = mountBridge(FILE_CHIP)
    const event = click(chip.querySelector('svg') as SVGElement)
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'outsidedir/关于源代码许可的分析.md' })
    expect(event.defaultPrevented).toBe(true)
    unmountBridge(root)
  })

  it('routes a skill mention to the skill action', () => {
    const { root, chip, opened } = mountBridge('<span data-ref-chip="file" title="@skill:blender-modeling">blender-modeling</span>')
    click(chip)
    expect(opened).toHaveBeenCalledWith({ kind: 'skill', name: 'blender-modeling' })
    unmountBridge(root)
  })

  it('routes a provider mention to its own action', () => {
    const { root, chip, opened } = mountBridge('<span data-ref-chip="file" title="@atlas:git/src/a.ts">a.ts</span>')
    click(chip)
    expect(opened).toHaveBeenCalledWith({ kind: 'atlas', provider: 'git', item: 'src/a.ts' })
    unmountBridge(root)
  })

  it('leaves a chip the framework already wired to the framework', () => {
    const { root, chip, actionFor, opened } = mountBridge('<button data-ref-chip="file" title="@a.ts">a.ts</button>')
    click(chip)
    expect(actionFor).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    unmountBridge(root)
  })

  it('ignores every chip kind that is not ours to open', () => {
    const HTML = [
      '<span data-ref-chip="folder" title="@docs/">docs</span>',
      '<span data-ref-chip="session" title="Research notes">Research notes</span>',
      '<span data-ref-chip="skill" title="/review">/review</span>',
      '<span data-ref-chip="command" title="/goal">/goal</span>',
      '<span data-ref-chip="file" title="@plugin:dsh-atlas">dsh-atlas</span>',
    ]
    for (const html of HTML) {
      const { root, chip, opened } = mountBridge(html)
      click(chip)
      expect(opened).not.toHaveBeenCalled()
      unmountBridge(root)
    }
  })

  it('leaves a mention the face has no action for inert, and unmarked', () => {
    const { root, chip, opened } = mountBridge(FILE_CHIP, false)
    const event = click(chip)
    expect(opened).not.toHaveBeenCalled()
    // Nothing happened, so the click stays the page's to handle.
    expect(event.defaultPrevented).toBe(false)
    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(chip.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    unmountBridge(root)
  })

  it('ignores double clicks and clicks that end inside a selection', () => {
    const { root, chip, opened } = mountBridge(FILE_CHIP)
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }))
    expect(opened).not.toHaveBeenCalled()
    // A drag-select that finishes on the chip must not open it.
    const range = document.createRange()
    range.selectNodeContents(chip)
    const selection = document.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)
    click(chip)
    expect(opened).not.toHaveBeenCalled()
    selection.removeAllRanges()
    // detail 0 is a synthetic (keyboard) click: no selection gesture to protect.
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
    expect(opened).toHaveBeenCalledTimes(1)
    unmountBridge(root)
  })

  it('ignores clicks that land on no chip and events with no element target', () => {
    const { root, host, opened } = mountBridge(`<div>plain text</div>${FILE_CHIP}`)
    click(host.firstElementChild as HTMLElement)
    document.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    // A pointer event on something that is not a chip at all, and one with no
    // element target: neither may run an action.
    ;(host.firstElementChild as HTMLElement).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(opened).not.toHaveBeenCalled()
    unmountBridge(root)
  })

  it('marks only the chips it can open, and does so as soon as they render', () => {
    const { root, host, chip } = mountBridge([
      FILE_CHIP,
      '<span data-ref-chip="file" title="@plugin:dsh-atlas">dsh-atlas</span>',
      '<button data-ref-chip="file" title="@a.ts">a.ts</button>',
    ].join(''))
    // Marked at rest: the link look must not wait for the pointer.
    expect(chip.getAttribute(LINK_ATTRIBUTE)).toBe('')
    // A second pass over an already-marked chip is a no-op, not a rewrite.
    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(chip.getAttribute(LINK_ATTRIBUTE)).toBe('')
    for (const other of [...host.querySelectorAll('[data-ref-chip]')].slice(1)) {
      other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      expect(other.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    }
    unmountBridge(root)
  })

  it('marks a chip the transcript renders later, without a hover', async () => {
    const { root, host } = mountBridge('<div>host</div>')
    const chip = document.createElement('span')
    chip.setAttribute('data-ref-chip', 'file')
    chip.setAttribute('title', '@a.ts')
    host.appendChild(chip)
    // A non-element addition (streamed text) must not disturb the pass.
    host.appendChild(document.createTextNode(' and text'))
    // A MutationObserver callback runs as a microtask.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(chip.hasAttribute(LINK_ATTRIBUTE)).toBe(true)
    unmountBridge(root)
  })

  it('marks on hover a chip whose action only became available later', () => {
    const { root, chip } = mountBridge(FILE_CHIP, false)
    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(chip.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    // A provider registering after its mention was rendered adds no DOM, so the
    // pointer pass is what publishes the affordance for it.
    rerenderBridge(root, vi.fn(() => () => {}))
    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(chip.hasAttribute(LINK_ATTRIBUTE)).toBe(true)
    unmountBridge(root)
  })

  it('stops listening once the overlay goes away', () => {
    const { root, chip, opened } = mountBridge(FILE_CHIP)
    unmountBridge(root)
    click(chip)
    expect(opened).not.toHaveBeenCalled()
  })

  it('publishes the framework link language for the marked chip alone', () => {
    expect(cssText).toContain(`[${LINK_ATTRIBUTE}] {`)
    expect(cssText).toContain(`[${LINK_ATTRIBUTE}]:hover,`)
    // The same tokens the framework gives its own wired chips.
    expect(cssText).toContain('color: var(--dsw-alias-link)')
    expect(cssText).toContain('underline dotted var(--dsw-alias-link)')
    // A stale chip stops reading as a link.
    expect(cssText).toContain(`[${MISSING_ATTRIBUTE}] {`)
    expect(cssText).toContain('line-through')
  })

  it('marks a chip stale when the click learns its target is gone', async () => {
    const { root, chip } = mountBridge(FILE_CHIP)
    // The injected action reports the target is gone instead of opening it.
    rerenderBridge(root, () => () => 'gone')
    click(chip)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(chip.hasAttribute(MISSING_ATTRIBUTE)).toBe(true)
    // It stops being offered as a link, and a later hover cannot revive it.
    expect(chip.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(chip.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    expect(chip.hasAttribute(MISSING_ATTRIBUTE)).toBe(true)
    unmountBridge(root)
  })

  it('opens the reference a composer chip names, marking the body the framework styles', () => {
    const { root, host, opened } = mountBridge(composerChip('CHANGELOG.md'))
    const body = host.querySelector('.chipBody') as HTMLElement
    // Marked at rest on the BODY: that is where the framework's chip colour and
    // `cursor: default` live, so that is what the link language has to override.
    expect(body.getAttribute(LINK_ATTRIBUTE)).toBe('')
    expect(host.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    // The click can land on any part of the chip: marker, label, or the body.
    const event = click(host.querySelector('.label') as HTMLElement)
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'CHANGELOG.md' })
    unmountBridge(root)
  })

  it('resolves a bare chip label through the injected index before opening it', () => {
    // The sidebar plugin labels a chip with the basename while the draft keeps
    // the full path, so a bare name has to be placed by the index.
    const seen: string[] = []
    const { root, host, opened } = mountBridge(
      composerChip('index.ts'),
      true,
      label => { seen.push(label); return 'src/client/index.ts' },
    )
    click(host.querySelector('.chipBody') as HTMLElement)
    // Resolved at least once — the mark pass and the click both ask.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(label => label === 'index.ts')).toBe(true)
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'src/client/index.ts' })
    unmountBridge(root)
  })

  it('falls back to the draft when the index cannot place the label, and never guesses', () => {
    const label = `index.ts`
    // A basename two indexed paths answer to: the draft's single mention decides.
    const placed = mountBridge(composerChip(label), true, () => undefined, '看 @src/client/index.ts')
    expect(placed.host.querySelector('.chipBody')?.getAttribute(LINK_ATTRIBUTE)).toBe('')
    click(placed.host.querySelector('.chipBody') as HTMLElement)
    expect(placed.opened).toHaveBeenCalledWith({ kind: 'file', path: 'src/client/index.ts' })
    unmountBridge(placed.root)

    // Same ambiguity, but the draft names two of them: nothing is offered.
    const ambiguous = mountBridge(composerChip(label), true, () => undefined, '@src/index.ts @src/client/index.ts')
    const body = ambiguous.host.querySelector('.chipBody') as HTMLElement
    expect(body.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    expect(click(body).defaultPrevented).toBe(false)
    expect(ambiguous.opened).not.toHaveBeenCalled()
    unmountBridge(ambiguous.root)
  })

  it('leaves a composer chip that names nothing of ours alone', () => {
    const { root, host, actionFor, opened } = mountBridge(composerChip('/review'))
    const body = host.querySelector('.chipBody') as HTMLElement
    expect(body.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    const event = click(body)
    expect(event.defaultPrevented).toBe(false)
    expect(actionFor).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    unmountBridge(root)
  })

  it('picks up a composer chip body that renders after its host element', async () => {
    const { root, host } = mountBridge(composerChip('AGENTS.md', false))
    const element = host.firstElementChild as HTMLElement
    // The host element is in the transcript before its React portal is: nothing
    // to mark yet, and nothing that may run an action.
    expect(element.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    const body = document.createElement('span')
    body.setAttribute('title', 'AGENTS.md')
    element.appendChild(body)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(body.hasAttribute(LINK_ATTRIBUTE)).toBe(true)
    unmountBridge(root)
  })

  it('marks a composer chip stale when its target is gone', async () => {
    const { root, host } = mountBridge(composerChip('CHANGELOG.md'))
    rerenderBridge(root, () => () => 'gone')
    const body = host.querySelector('.chipBody') as HTMLElement
    click(body)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(body.hasAttribute(MISSING_ATTRIBUTE)).toBe(true)
    expect(body.hasAttribute(LINK_ATTRIBUTE)).toBe(false)
    unmountBridge(root)
  })

  it('publishes the composer chip override the framework cursor needs', () => {
    // The framework styles the chip body with a single class, so the link rule
    // has to out-specify it to turn the pointer on.
    expect(cssText).toContain(`[data-composer-chip] [${LINK_ATTRIBUTE}] {`)
    expect(cssText).toContain('cursor: pointer')
    expect(cssText).toContain(`[data-composer-chip] [${MISSING_ATTRIBUTE}] {`)
  })

  it('keeps one listener across re-renders and follows the newest face', () => {
    const { root, chip, opened } = mountBridge(FILE_CHIP)
    // The chat re-renders per streamed token and re-injects a fresh face: the
    // listener must neither be re-added nor keep calling the stale one.
    const next = vi.fn(() => () => { opened({ from: 'next' }) })
    rerenderBridge(root, next)
    click(chip)
    expect(next).toHaveBeenCalledWith({ kind: 'file', path: 'outsidedir/关于源代码许可的分析.md' })
    // The stale face's action never ran: only the newest one answered the click.
    expect(opened).toHaveBeenCalledExactlyOnceWith({ from: 'next' })
    unmountBridge(root)
  })
})
