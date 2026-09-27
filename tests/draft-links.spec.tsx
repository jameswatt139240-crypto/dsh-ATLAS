// @vitest-environment jsdom
/**
 * Draft-side reference activation: reading a token out of the composer DOM
 * (decorated by the framework or hand-typed), deciding what the plugin can
 * open, and the click/pointer/colour behaviour over real composer markup.
 */
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blockOf,
  canPaintTails,
  DRAFT_HIGHLIGHT,
  draftActivation,
  draftLink,
  draftMissing,
  draftTokens,
  indexLine,
  MISSING_HIGHLIGHT,
  paintDraftLinks,
  pointAt,
  TEXT_REF_SELECTOR,
  tokenAtPoint,
  tokenRunAt,
} from '../src/client/draft-links.ts'
import { DraftLinks, type DraftLinksProps } from '../src/client/DraftLinks.tsx'
import type { ReferenceInfoSnapshot } from '../src/client/FilesDock.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

/**
 * One composer with both renderings: the framework decorated the head of the
 * first token and the whole of the second, while the third line was typed by
 * hand and never decorated at all.
 */
const COMPOSER = '<div data-composer-card><div data-lexical-editor="true" contenteditable="true">'  + '<p><span data-lexical-text="true">看 </span>'
  + '<span data-lexical-text="true" data-composer-text-ref>@atlas:git/</span>'
  + '<span data-lexical-text="true">.dsh-atlas-git-smoke.md</span>'
  + '<span data-lexical-text="true"> 和 </span>'
  + '<span data-lexical-text="true" data-composer-text-ref>@AGENTS.md</span></p>'
  + '<p><span data-lexical-text="true">手打 @README.md 和 @prose</span></p>'
  + '<p><span data-lexical-text="true">文件夹 @outsidedir 和外域 @E:\\outsidedir\\Rust\\DSH\\outsidedir\\AI.md</span></p>'
  + '</div></div>'

/** Mounted bridges still alive, unmounted after every test (they observe body). */
const liveRoots = new Set<Root>()

/** The live session reference, spelled exactly as the Harness wrote it into the log. */
const SESSION_ID = 'session-syw-v016-0001'
const WIRE_SESSION = `@[${SESSION_ID}](dsh-session:InNlc3Npb24tc3l3LXYwMTYtMDAwMSI)`

/**
 * The reference the user actually typed, from the session whose label has spaces
 * (`继续 LoongCrush J 项目的任务`). This is the form the tokenizer used to cut in half.
 */
const SPACED_ID = 'session-9efe1297-867a-4fb2-adbd-edc5c978b978'
const WIRE_SESSION_SPACED = `@[继续 LoongCrush J 项目的任务](dsh-session:InNlc3Npb24tOWVmZTEyOTctODY3YS00ZmIyLWFkYmQtZWRjNWM5NzhiOTc4Ig)`

/** The caret stub installed by {@link stubCaret}. */
let restoreCaret: (() => void) | undefined
/** The Custom Highlight API stub installed by {@link stubHighlight}. */
let restoreHighlight: (() => void) | undefined

afterEach(() => {
  for (const root of [...liveRoots]) { liveRoots.delete(root); root.unmount() }
  restoreCaret?.()
  restoreCaret = undefined
  restoreHighlight?.()
  restoreHighlight = undefined
  document.body.innerHTML = ''
})

/** Point `document.caretRangeFromPoint` at one fixed position. */
function stubCaret(node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  const original = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
  Object.defineProperty(document, 'caretRangeFromPoint', { value: () => range, configurable: true })
  restoreCaret = () => {
    if (original === undefined) Reflect.deleteProperty(document, 'caretRangeFromPoint')
    else Object.defineProperty(document, 'caretRangeFromPoint', original)
  }
}

/** Install the CSS Custom Highlight API jsdom never implements. */
function stubHighlight(): { readonly ranges: () => readonly Range[]; readonly stale: () => readonly Range[] } {
  const globals = globalThis as { CSS?: Record<string, unknown>; Highlight?: unknown }
  const css = globals.CSS ?? {}
  const createdCss = globals.CSS === undefined
  const originalCss = css.highlights
  const originalHighlight = globals.Highlight
  class FakeHighlight {
    readonly ranges: Range[] = []
    add(range: Range): void { this.ranges.push(range) }
  }
  const registry = new Map<string, FakeHighlight>()
  if (createdCss) Object.defineProperty(globalThis, 'CSS', { value: css, configurable: true })
  Object.defineProperty(css, 'highlights', { value: registry, configurable: true })
  Object.defineProperty(globalThis, 'Highlight', { value: FakeHighlight, configurable: true })
  restoreHighlight = () => {
    if (createdCss) Reflect.deleteProperty(globalThis, 'CSS')
    else if (originalCss === undefined) Reflect.deleteProperty(css, 'highlights')
    else Object.defineProperty(css, 'highlights', { value: originalCss, configurable: true })
    if (originalHighlight === undefined) Reflect.deleteProperty(globalThis, 'Highlight')
    else Object.defineProperty(globalThis, 'Highlight', { value: originalHighlight, configurable: true })
  }
  return {
    ranges: () => registry.get(DRAFT_HIGHLIGHT)?.ranges ?? [],
    stale: () => registry.get(MISSING_HIGHLIGHT)?.ranges ?? [],
  }
}

/** Put the composer fixture into the document. */
function mountComposer(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = COMPOSER
  document.body.appendChild(host)
  return host
}

/** One decorated span of the fixture, in document order. */
function pick(host: HTMLElement, index: number): HTMLElement {
  return host.querySelectorAll(TEXT_REF_SELECTOR)[index] as HTMLElement
}

/** The text node one element holds. */
function textOf(element: Element): Text {
  return element.firstChild as Text
}

/** The text node of one fixture line. */
function lineText(host: HTMLElement, index: number): Text {
  const line = host.querySelectorAll('p')[index] as HTMLElement
  return textOf(line.firstElementChild as HTMLElement)
}

/** A click as a browser delivers it outside a selection. */
function click(target: Element, detail = 1): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail, button: 0 })
  target.dispatchEvent(event)
  return event
}

/** A pointer move over one element. */
function moveOver(target: Element): void {
  target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true }))
}

/** Let the bridge's queued microtasks run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** The verdict the dock would have published for one existing file. */
const EXISTS = (relative: string): { relative: string; exists: boolean } => ({ relative, exists: true })

/**
 * Mount the draft bridge over the composer fixture.
 * @param infos - the inspection verdicts the dock would have published.
 * @param behaviour - whether the injected face offers an action, none, or a broken one.
 * @returns the root, the fixture host, and the spies.
 */
function mountBridge(infos: readonly unknown[] = [], behaviour: 'open' | 'none' | 'reject' = 'open'): {
  root: Root
  host: HTMLElement
  opened: ReturnType<typeof vi.fn>
  actionFor: ReturnType<typeof vi.fn>
} {
  const host = mountComposer()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  liveRoots.add(root)
  const opened = vi.fn()
  const actionFor = vi.fn((_link: unknown) => {
    if (behaviour === 'none') return undefined
    if (behaviour === 'reject') return () => Promise.reject(new Error('provider refused'))
    return () => { opened(_link) }
  })
  const useReferenceInfo = (select: (snapshot: ReferenceInfoSnapshot) => unknown): unknown =>
    select({ value: infos as ReferenceInfoSnapshot['value'] })
  flushSync(() => {
    root.render(<DraftLinks {...({ actionFor, useReferenceInfo } as unknown as DraftLinksProps)} />)
  })
  flushSync(() => {})
  return { root, host, opened, actionFor }
}

describe('tokenRunAt', () => {
  it('reads the whole token from a position inside its undecorated tail', () => {
    const line = '看 @atlas:git/.dsh-atlas-git-smoke.md 和 @AGENTS.md'
    // The user's case: the framework painted `@atlas:git/`, the click lands on the
    // file name, and the token must still resolve as a whole.
    expect(tokenRunAt(line, 20)).toEqual({ token: '@atlas:git/.dsh-atlas-git-smoke.md', start: 2, end: 36 })
    expect(tokenRunAt(line, 2)).toEqual({ token: '@atlas:git/.dsh-atlas-git-smoke.md', start: 2, end: 36 })
    expect(tokenRunAt(line, 45)).toEqual({ token: '@AGENTS.md', start: 39, end: 49 })
  })

  it('stops at whitespace, at a second trigger and off the line', () => {
    expect(tokenRunAt('@a.ts and @b.ts', 11)).toEqual({ token: '@b.ts', start: 10, end: 15 })
    // A second `@` inside the run belongs to the next token.
    expect(tokenRunAt('@a@b', 3)).toEqual({ token: '@b', start: 2, end: 4 })
    // Prose with no trigger of its own never resolves.
    expect(tokenRunAt('plain words here', 3)).toBeUndefined()
    expect(tokenRunAt('@a.ts', 99)).toBeUndefined()
    expect(tokenRunAt('@a.ts', -1)).toBeUndefined()
  })

  it('keeps a WIRE session mention whole even though its label has spaces', () => {
    // The live failure this pins: the whitespace rule cut this mention at its
    // first space, the fragment decoded as a FILE path, and the click answered
    // `cannot resolve target "E:\…\dsh-atlas\继续": ENOENT`. A session label that
    // contains spaces only exists in the bracket form, so that form is one token.
    const line = `看 ${WIRE_SESSION_SPACED} 和 @AGENTS.md`
    const start = 2
    const end = start + WIRE_SESSION_SPACED.length
    expect(tokenRunAt(line, start)).toEqual({ token: WIRE_SESSION_SPACED, start, end })
    // Anywhere inside the mention — its label, its whitespace, its payload.
    expect(tokenRunAt(line, start + 6)).toEqual({ token: WIRE_SESSION_SPACED, start, end })
    expect(tokenRunAt(line, start + 14)).toEqual({ token: WIRE_SESSION_SPACED, start, end })
    expect(tokenRunAt(line, end - 1)).toEqual({ token: WIRE_SESSION_SPACED, start, end })
    // The mention's own end offset still belongs to it (the run covers the caret),
    // and the FIRST offset after the following space is the next token's trigger.
    expect(tokenRunAt(line, end)).toEqual({ token: WIRE_SESSION_SPACED, start, end })
    expect(tokenRunAt(line, end + 1)).toBeUndefined()
    // And the mention after it still resolves on its own.
    expect(tokenRunAt(line, line.length - 2)).toEqual({ token: '@AGENTS.md', start: line.indexOf('@AGENTS'), end: line.length })
  })
})

describe('draftLink', () => {
  it('decodes every form a draft token can spell', () => {
    expect(draftLink('@AGENTS.md')).toEqual({ kind: 'file', path: 'AGENTS.md' })
    expect(draftLink('@outsidedir/分析.md')).toEqual({ kind: 'file', path: 'outsidedir/分析.md' })
    expect(draftLink('@outsidedir/')).toEqual({ kind: 'folder', path: 'outsidedir' })
    expect(draftLink('@atlas:git/.dsh-atlas-git-smoke.md'))
      .toEqual({ kind: 'atlas', provider: 'git', item: '.dsh-atlas-git-smoke.md' })
    // A line range is a reading instruction: the file is what opens.
    expect(draftLink('@src/view.ts:12-40')).toEqual({ kind: 'file', path: 'src/view.ts' })
    expect(draftLink('@src/view.ts:12')).toEqual({ kind: 'file', path: 'src/view.ts' })
    // A folder token keeps its own kind, so the range split never runs on it.
    expect(draftLink('@outsidedir/')).toEqual({ kind: 'folder', path: 'outsidedir' })
  })

  it('refuses the tokens that name nothing openable', () => {
    expect(draftLink('@plugin:dsh-atlas')).toBeUndefined()
    // `file:` is a category handle, never a path — even with a range attached.
    expect(draftLink('@file:12-40')).toBeUndefined()
    expect(draftLink('@skill:')).toBeUndefined()
    expect(draftLink('@')).toBeUndefined()
  })
})

describe('draftActivation', () => {
  const open = (): 'opened' => 'opened'

  it('offers the action for a token whose target the Host confirmed', () => {
    const activation = draftActivation('@AGENTS.md', () => open, () => ({ exists: true }))
    expect(activation?.link).toEqual({ kind: 'file', path: 'AGENTS.md' })
    expect(activation?.run()).toBe('opened')
  })

  it('opens a hand-typed directory as the FOLDER it is', () => {
    // `@outsidedir` has no trailing separator, so it decodes as a file token — but the
    // dock's own inspection already answered that this path IS a directory. The
    // Host's kind is what decides, which is what makes a hand-typed folder behave
    // like the one the sidebar inserted (`@outsidedir/`).
    const activation = draftActivation('@outsidedir', () => open, () => ({ exists: true, kind: 'dir' }))
    expect(activation?.link).toEqual({ kind: 'folder', path: 'outsidedir' })
    // A trailing separator keeps winning: it is what the user wrote.
    expect(draftActivation('@outsidedir/', () => open, () => ({ exists: true, kind: 'dir' }))?.link)
      .toEqual({ kind: 'folder', path: 'outsidedir' })
    // A file the Host calls a file stays one.
    expect(draftActivation('@AGENTS.md', () => open, () => ({ exists: true, kind: 'file' }))?.link)
      .toEqual({ kind: 'file', path: 'AGENTS.md' })
    // A verdict with no kind cannot promote anything.
    expect(draftActivation('@outsidedir', () => open, () => ({ exists: true }))?.link)
      .toEqual({ kind: 'file', path: 'outsidedir' })
  })

  it('stays inert until the target is confirmed, and on a vanished one', () => {
    // The plugin draws a link only for what it can open: an answer that has not
    // arrived yet is not an answer, and the dock reads 已失效 for the other.
    expect(draftActivation('@AGENTS.md', () => open, () => undefined)).toBeUndefined()
    expect(draftActivation('@gone.md', () => open, () => ({ exists: false }))).toBeUndefined()
    expect(draftActivation('@plugin:x', () => open, () => ({ exists: true }))).toBeUndefined()
    expect(draftActivation('@atlas:git/x.ts', () => undefined, () => ({ exists: true }))).toBeUndefined()
    // A provider item has no workspace verdict: its owner decides, so it is
    // offered as soon as that owner declares an `open`.
    expect(draftActivation('@atlas:git/x.ts', () => open, () => undefined)?.link)
      .toEqual({ kind: 'atlas', provider: 'git', item: 'x.ts' })
  })

  it('opens a session from the wire form with no session list involved', () => {
    const asked: string[] = []
    const activation = draftActivation(
      WIRE_SESSION,
      () => open,
      () => ({ exists: true }),
      label => { asked.push(label); return undefined },
    )
    expect(activation?.link).toEqual({ kind: 'session', sessionId: SESSION_ID })
    expect(activation?.run()).toBe('opened')
    // The token names its own session, so the list is never consulted.
    expect(asked).toEqual([])
  })

  it('opens a spaced-label wire mention as a session, never as a file', () => {
    // The tokenizer hands the whole bracket form over (see `tokenRunAt`), so the
    // activation must name the session — and must NOT ask the Host about a path,
    // which is what produced `cannot resolve target "…\继续": ENOENT` live.
    const activation = draftActivation(
      WIRE_SESSION_SPACED,
      () => open,
      () => undefined,
      () => undefined,
    )
    expect(activation?.link).toEqual({ kind: 'session', sessionId: SPACED_ID })
    expect(activation?.run()).toBe('opened')
  })

  it('promotes a bare label only on the injected session answer', () => {
    // Without a resolver a bare token keeps the rules it always had, so a name
    // the Host confirms as a path stays a file reference — the session face
    // never widens what a token may open, it only answers for its own names.
    expect(draftActivation(`@${SESSION_ID}`, () => open, () => ({ exists: true }))?.link)
      .toEqual({ kind: 'file', path: SESSION_ID })
    // With a resolver, the label the session list matched becomes a session link
    // and the path rules are not consulted at all.
    const asked: string[] = []
    const activation = draftActivation(
      `@${SESSION_ID}`,
      () => open,
      () => undefined,
      label => { asked.push(label); return label === SESSION_ID ? SESSION_ID : undefined },
    )
    expect(activation?.link).toEqual({ kind: 'session', sessionId: SESSION_ID })
    expect(activation?.run()).toBe('opened')
    expect(asked).toEqual([SESSION_ID])
  })

  it('never lets a session answer hijack a workspace path', () => {    // A label that also names a real file is offered as the FILE: the resolver
    // must have already refused it (that is the resolver's uniqueness rule), so
    // this pins the ordering — a Host-confirmed path is never overruled.
    const activation = draftActivation('@AGENTS.md', () => open, () => ({ exists: true }), () => undefined)
    expect(activation?.link).toEqual({ kind: 'file', path: 'AGENTS.md' })
  })
})

describe('composer DOM reads', () => {
  it('indexes one line and converts offsets both ways', () => {
    const host = mountComposer()
    const line = host.querySelector('p') as HTMLElement
    const index = indexLine(line)
    expect(index.text).toBe('看 @atlas:git/.dsh-atlas-git-smoke.md 和 @AGENTS.md')
    expect(index.nodes.map(entry => entry.start)).toEqual([0, 2, 13, 36, 39])
    const point = pointAt(index, 20)
    expect(point?.node.data).toBe('.dsh-atlas-git-smoke.md')
    expect(point?.offset).toBe(7)
    expect(pointAt(index, index.text.length)?.offset).toBe('@AGENTS.md'.length)
    expect(pointAt(index, -1)).toBeUndefined()
    expect(pointAt(index, index.text.length + 5)).toBeUndefined()
  })

  it('lists every token of every line, hand-typed ones included', () => {
    const host = mountComposer()
    expect(draftTokens().map(token => token.token)).toEqual([
      '@atlas:git/.dsh-atlas-git-smoke.md',
      '@AGENTS.md',
      '@README.md',
      '@prose',
      '@outsidedir',
      '@E:\\outsidedir\\Rust\\DSH\\outsidedir\\AI.md',
    ])
    expect(draftTokens().map(token => token.start)).toEqual([2, 39, 3, 16, 4, 20])
    expect(draftTokens()[2]?.line).toBe(host.querySelectorAll('p')[1])
    // Only a FINISHED token may be judged: the absolute path ends the draft, so
    // the user may still be typing it, while every token followed by whitespace
    // (or by another line, like `@prose`) is done.
    expect(draftTokens().map(token => token.settled)).toEqual([true, true, true, true, true, false])
  })

  it('resolves a caret position over a decorated token and over a hand-typed one', () => {
    const host = mountComposer()
    const root = host.querySelector('[data-lexical-editor]') as HTMLElement
    const tail = host.querySelectorAll('span')[2] as HTMLElement
    const decorated = tokenAtPoint(root, textOf(tail), 7)
    // The head is 11 characters (`@atlas:git/`), so anything past it is the tail.
    expect(decorated?.token).toBe('@atlas:git/.dsh-atlas-git-smoke.md')
    expect(decorated?.decoratedEnd).toBe(13)
    expect(decorated?.local).toBe(20)
    // A hand-typed token the framework never recognised resolves the same way —
    // it just carries no decoration offset, because there is no decoration.
    const typed = tokenAtPoint(root, lineText(host, 1), 5)
    expect(typed?.token).toBe('@README.md')
    expect(typed?.decoratedEnd).toBeUndefined()
    // A position outside the editor, and a position on plain prose, resolve to nothing.
    expect(tokenAtPoint(root, document.body, 0)).toBeUndefined()
    expect(tokenAtPoint(root, textOf(host.querySelector('span') as HTMLElement), 1)).toBeUndefined()
  })

  it('finds the line of a node and nothing outside the editor', () => {
    const host = mountComposer()
    const root = host.querySelector('[data-lexical-editor]') as HTMLElement
    const line = host.querySelectorAll('p')[1] as HTMLElement
    expect(blockOf(root, textOf(line.firstElementChild as HTMLElement))).toBe(line)
    expect(blockOf(root, document.body)).toBeUndefined()
  })
})

describe('draftMissing', () => {
  it('reports a reference the Host says is gone, and nothing else', () => {
    expect(draftMissing('@gone.md', () => ({ exists: false }))).toBe(true)
    expect(draftMissing('@outsidedir/', () => ({ exists: false }))).toBe(true)
    // An unanswered inspection claims nothing, and a name that is not a path at
    // all (`@plugin:x`) is not a claim about a file either.
    expect(draftMissing('@gone.md', () => undefined)).toBe(false)
    expect(draftMissing('@gone.md', () => ({ exists: true }))).toBe(false)
    expect(draftMissing('@plugin:x', () => ({ exists: false }))).toBe(false)
    expect(draftMissing('@atlas:git/x.ts', () => ({ exists: false }))).toBe(false)
  })
})

describe('paintDraftLinks', () => {
  it('does nothing without the highlight API', () => {
    const host = mountComposer()
    expect(canPaintTails()).toBe(false)
    expect(paintDraftLinks(() => 'link')).toEqual({ link: 0, missing: 0 })
    expect(host.querySelectorAll(TEXT_REF_SELECTOR)).toHaveLength(2)
  })

  it('paints the whole token of each kind, and clears the rest', () => {
    mountComposer()
    const highlight = stubHighlight()
    expect(canPaintTails()).toBe(true)
    expect(paintDraftLinks(() => 'link')).toEqual({ link: 6, missing: 0 })
    expect(highlight.ranges().map(range => range.toString())).toEqual([
      '@atlas:git/.dsh-atlas-git-smoke.md',
      '@AGENTS.md',
      '@README.md',
      '@prose',
      '@outsidedir',
      '@E:\\outsidedir\\Rust\\DSH\\outsidedir\\AI.md',
    ])
    // The two kinds are separate sets: a token the Host reports as gone is drawn
    // stale, not as a link.
    expect(paintDraftLinks(token => token.token === '@README.md' ? 'missing' : undefined))
      .toEqual({ link: 0, missing: 1 })
    expect(highlight.ranges()).toHaveLength(0)
    expect(highlight.stale().map(range => range.toString())).toEqual(['@README.md'])
    // A token the caller says nothing about keeps whatever the framework gave it.
    expect(paintDraftLinks(() => undefined)).toEqual({ link: 0, missing: 0 })
    expect(highlight.ranges()).toHaveLength(0)
    expect(highlight.stale()).toHaveLength(0)
  })
})

describe('the draft bridge', () => {
  it('opens a hand-typed token the framework never decorated', async () => {
    stubHighlight()
    const { host, opened } = mountBridge([EXISTS('README.md')])
    const line = lineText(host, 1)
    stubCaret(line, 5)
    const event = click(line.parentElement as HTMLElement)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'README.md' })
  })

  it('opens a hand-typed directory as the folder the Host says it is', async () => {
    stubHighlight()
    // The user's own case: the sidebar inserts `@outsidedir/`, but a hand-typed
    // `@outsidedir` has no trailing separator — so the token decodes as a file and only
    // the Host's own kind (already in hand from the dock's inspection) can turn it
    // back into the folder reference it names.
    const { host, opened } = mountBridge([{ relative: 'outsidedir', exists: true, kind: 'dir' }])
    const line = lineText(host, 2)
    stubCaret(line, line.data.indexOf('@outsidedir') + 2)
    const event = click(line.parentElement as HTMLElement)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith({ kind: 'folder', path: 'outsidedir' })
  })

  it('finds the verdict of an absolute path the draft spelled with backslashes', async () => {
    stubHighlight()
    // The Host answers an out-of-workspace path in its own canonical spelling
    // (forward slashes) while Windows users type the platform's. Keyed by raw
    // text, the token never found its own verdict — so it was never a link.
    const { host, opened } = mountBridge([
      { relative: 'E:/outsidedir/Rust/DSH/outsidedir/AI.md', exists: true, kind: 'file' },
    ])
    const line = lineText(host, 2)
    stubCaret(line, line.data.indexOf('@E:') + 2)
    const event = click(line.parentElement as HTMLElement)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'E:\\outsidedir\\Rust\\DSH\\outsidedir\\AI.md' })
  })

  it('opens the reference a click lands in, tail included', async () => {
    stubHighlight()
    const { host, opened } = mountBridge()
    const tail = host.querySelectorAll('span')[2] as HTMLElement
    stubCaret(textOf(tail), 7)
    const event = click(tail)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith({ kind: 'atlas', provider: 'git', item: '.dsh-atlas-git-smoke.md' })
  })

  it('opens a decorated token whose target the Host confirmed', async () => {
    stubHighlight()
    const { host, opened } = mountBridge([EXISTS('AGENTS.md')])
    const head = pick(host, 1)
    stubCaret(textOf(head), 3)
    click(head)
    await settle()
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'AGENTS.md' })
  })

  it('leaves an ordinary click, a double click and unknown tokens alone', () => {
    const { host, opened } = mountBridge([EXISTS('README.md')])
    const plain = host.querySelector('span') as HTMLElement
    stubCaret(textOf(plain), 1)
    expect(click(plain).defaultPrevented).toBe(false)
    // `@prose` names no file, so it is not a link even though it looks like a token.
    const line = lineText(host, 1)
    stubCaret(line, 18)
    expect(click(line.parentElement as HTMLElement).defaultPrevented).toBe(false)
    const head = pick(host, 1)
    stubCaret(textOf(head), 3)
    expect(click(head, 2).defaultPrevented).toBe(false)
    expect(opened).not.toHaveBeenCalled()
  })

  it('offers nothing for a hand-typed token the Host has not confirmed', async () => {
    stubHighlight()
    // No verdict yet: the dock has not answered, so nothing is promised.
    const { host, opened } = mountBridge()
    const line = lineText(host, 1)
    stubCaret(line, 5)
    expect(click(line.parentElement as HTMLElement).defaultPrevented).toBe(false)
    await settle()
    expect(opened).not.toHaveBeenCalled()
  })

  it('judges a token only once the user has finished typing it', async () => {
    const highlight = stubHighlight()
    // BOTH tokens name a target the Host reports as gone, but the absolute path
    // ends the draft — the user may still be writing it — so only the finished one
    // (the one followed by whitespace) is drawn stale. Judging the unfinished one
    // would strike it through halfway through the word.
    mountBridge([
      { relative: 'E:/outsidedir/Rust/DSH/outsidedir/AI.md', exists: false },
      { relative: 'README.md', exists: false },
    ])
    await settle()
    expect(highlight.stale().map(range => range.toString())).toEqual(['@README.md'])
  })

  it('draws a reference whose target is gone as stale rather than as prose', async () => {
    const highlight = stubHighlight()
    const { host, opened } = mountBridge([{ relative: 'README.md', exists: false }, EXISTS('AGENTS.md')])
    // The bridge's own paint pass (mount + verdict effects), not a hand-rolled rule.
    await settle()
    expect(highlight.stale().map(range => range.toString())).toEqual(['@README.md'])
    expect(highlight.ranges().map(range => range.toString())).toEqual([
      '@atlas:git/.dsh-atlas-git-smoke.md',
      '@AGENTS.md',
    ])
    // Stale is not a link: no hand cursor, and a click on it does nothing.
    const line = lineText(host, 1)
    const root = host.querySelector('[data-lexical-editor]') as HTMLElement
    stubCaret(line, 5)
    moveOver(line.parentElement as HTMLElement)
    expect(root.style.cursor).toBe('')
    expect(click(line.parentElement as HTMLElement).defaultPrevented).toBe(false)
    await settle()
    expect(opened).not.toHaveBeenCalled()
  })

  it('does not offer a reference the dock already reads as 已失效', async () => {
    stubHighlight()
    const { host, opened } = mountBridge([{ relative: 'AGENTS.md', exists: false }])
    const head = pick(host, 1)
    stubCaret(textOf(head), 3)
    expect(click(head).defaultPrevented).toBe(false)
    await settle()
    expect(opened).not.toHaveBeenCalled()
  })

  it('stays inert when this build has no action for the reference', async () => {
    stubHighlight()
    const { host, opened } = mountBridge([EXISTS('AGENTS.md')], 'none')
    const head = pick(host, 1)
    stubCaret(textOf(head), 3)
    expect(click(head).defaultPrevented).toBe(false)
    await settle()
    expect(opened).not.toHaveBeenCalled()
  })

  it('reports a rejected open instead of throwing into the click', async () => {
    stubHighlight()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { host } = mountBridge([EXISTS('AGENTS.md')], 'reject')
    const head = pick(host, 1)
    stubCaret(textOf(head), 3)
    click(head)
    await settle()
    expect(consoleError).toHaveBeenCalledWith('[dsh-atlas] opening the draft reference failed:', expect.any(Error))
    consoleError.mockRestore()
  })

  it('shows the link pointer over an openable token only', () => {
    stubHighlight()
    const { host } = mountBridge([EXISTS('README.md')])
    const root = host.querySelector('[data-lexical-editor]') as HTMLElement
    const line = lineText(host, 1)
    stubCaret(line, 5)
    moveOver(line.parentElement as HTMLElement)
    expect(root.style.cursor).toBe('pointer')
    // Leaving the token (the same editor, a position on prose) and leaving the
    // composer both clear it again.
    stubCaret(line, 18)
    moveOver(line.parentElement as HTMLElement)
    expect(root.style.cursor).toBe('')
    stubCaret(line, 5)
    moveOver(line.parentElement as HTMLElement)
    expect(root.style.cursor).toBe('pointer')
    moveOver(document.body)
    expect(root.style.cursor).toBe('')
  })

  it('keeps every unpainted token inert while this browser cannot paint', async () => {
    const { host, opened } = mountBridge([EXISTS('README.md'), EXISTS('AGENTS.md')])
    // No highlight API here, so nothing is drawn as a link: only the part the
    // framework itself coloured may act as one.
    const line = lineText(host, 1)
    stubCaret(line, 5)
    click(line.parentElement as HTMLElement)
    await settle()
    expect(opened).not.toHaveBeenCalled()
    // The decorated head still opens (the framework drew it), the undecorated
    // tail does not.
    const head = pick(host, 1)
    stubCaret(textOf(head), 3)
    click(head)
    await settle()
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'AGENTS.md' })
    opened.mockClear()
    const tail = host.querySelectorAll('span')[2] as HTMLElement
    stubCaret(textOf(tail), 7)
    click(tail)
    await settle()
    expect(opened).not.toHaveBeenCalled()
    // With the API present the plugin paints what it offers, and every painted
    // token opens.
    stubHighlight()
    expect(paintDraftLinks(() => 'link')).toEqual({ link: 6, missing: 0 })
    stubCaret(textOf(tail), 7)
    click(tail)
    await settle()
    expect(opened).toHaveBeenCalledWith({ kind: 'atlas', provider: 'git', item: '.dsh-atlas-git-smoke.md' })
    opened.mockClear()
    stubCaret(line, 5)
    click(line.parentElement as HTMLElement)
    await settle()
    expect(opened).toHaveBeenCalledWith({ kind: 'file', path: 'README.md' })
  })
})
