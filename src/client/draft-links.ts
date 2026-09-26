/**
 * Draft-side reference activation: the pieces that let a click inside the
 * composer open the reference a token names, and that draw the link the plugin
 * can honour.
 *
 * The composer is the framework's Lexical contenteditable. It decorates SOME
 * reference tokens (a name on the plugin's lexicon, or a syntactic `@dir/`), and
 * it decorates those only PARTIALLY: `TEXT_REF_RE` (`[\w-]+`) stops at the first
 * non-word character and `FOLDER_REF_RE` stops at the last separator — in 0.1.5
 * and in 0.1.6 alike — so `@atlas:git/item.md` would be painted only up to the
 * `/`. The plugin therefore does not treat that decoration as the source of
 * truth: a draft token is a link when the PLUGIN can open it, which means it
 * decodes into a reference and the Host has confirmed the target (see
 * {@link draftActivation}). A hand-typed `@AGENTS.md` the framework never
 * recognised is a link for the same reason a recognised one is.
 *
 * Nothing here edits the draft or the editor's DOM. A Lexical text span expects
 * exactly one text child (its `updateDOM` writes through `firstChild.nodeValue`),
 * so wrapping or re-parenting any part of a token would break typing inside it.
 * The link colour is a painted range (the CSS Custom Highlight API) instead,
 * which leaves the tree alone; a browser without that API paints nothing, and
 * then only the part the framework itself coloured stays clickable.
 */
import { splitLineRange } from '../tokens.ts'
import { decodeDraftReference, type ReferenceLink } from './reference-links.ts'
import type { ReferenceOutcome } from './ReferenceLinks.tsx'

/** The attribute Lexical puts on the composer's contenteditable root. */
export const EDITOR_SELECTOR = '[data-lexical-editor="true"]'

/** The attribute the framework puts on a text node it decorated as a reference. */
export const TEXT_REF_SELECTOR = '[data-composer-text-ref]'

/** The highlight name every draft link is painted under. */
export const DRAFT_HIGHLIGHT = 'dsh-atlas-draft-ref'

/** The highlight name a reference whose target is gone is painted under. */
export const MISSING_HIGHLIGHT = 'dsh-atlas-draft-missing'

/** The action one click on a draft reference performs. */
export type DraftAction = () => ReferenceOutcome | Promise<ReferenceOutcome>

/** One token the plugin can act on, decoded. */
export interface DraftActivation {
  readonly link: ReferenceLink
  readonly run: DraftAction
}

/** Whether one character ends a token (the grammar's only separator). */
function isSpace(character: string): boolean {
  return /\s/u.test(character)
}

/** Every composer editor root currently in the document. */
function editorRoots(): readonly Element[] {
  return [...document.querySelectorAll(EDITOR_SELECTOR)]
}

/**
 * The block child of the editor root that holds `node`.
 *
 * Lexical draws one block element per line, so this is the line a caret belongs
 * to; offsets are then counted inside that one line, never across the whole
 * draft (which is what keeps the mapping exact without knowing how the editor
 * spells its line breaks).
 * @param root - one editor root.
 * @param node - a node inside it.
 * @returns the block, or undefined when the node is not inside this root.
 */
export function blockOf(root: Element, node: Node): Element | undefined {
  let current: Node | null = node
  while (current !== null && current.parentNode !== root) current = current.parentNode
  return current instanceof Element ? current : undefined
}

/** One line's text plus the offset each of its text nodes starts at. */
export interface LineIndex {
  readonly text: string
  readonly nodes: readonly { readonly node: Text; readonly start: number }[]
}

/** Index one line so a character offset and a text node convert into each other. */
export function indexLine(block: Element): LineIndex {
  const nodes: { node: Text; start: number }[] = []
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let text = ''
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const current = node as Text
    nodes.push({ node: current, start: text.length })
    text += current.data
  }
  return { text, nodes }
}

/**
 * The DOM point of one character offset inside an indexed line.
 * @param index - the indexed line.
 * @param offset - a character offset in its text.
 * @returns the text node and offset to build a Range from, or undefined past the end.
 */
export function pointAt(index: LineIndex, offset: number): { readonly node: Text; readonly offset: number } | undefined {
  if (offset < 0) return undefined
  for (const entry of index.nodes) {
    if (offset <= entry.start + entry.node.data.length) {
      return { node: entry.node, offset: offset - entry.start }
    }
  }
  return undefined
}

/** Where one DOM point falls in an indexed line, or undefined when it is not part of it. */
function localOffset(index: LineIndex, node: Node, offset: number): number | undefined {
  const direct = index.nodes.find(entry => entry.node === node)
  if (direct !== undefined) return direct.start + Math.min(offset, direct.node.data.length)
  // A caret API may answer with an element and a child index instead of a text
  // node; fall back to the start of the child the index points at.
  if (!(node instanceof Element)) return undefined
  const child = node.childNodes[Math.min(offset, node.childNodes.length - 1)]
  if (child === undefined) return index.text.length
  return index.nodes.find(entry => child.contains(entry.node))?.start ?? index.text.length
}

/** One `@` token's span inside a line's text. */
export interface TokenRun {
  readonly token: string
  readonly start: number
  readonly end: number
}

/**
 * The `@` token run that covers one character offset of a line.
 *
 * The run is bounded by whitespace and by a second `@` (the grammar is `@` plus
 * a run of non-whitespace, non-`@` characters), so a click anywhere inside a
 * token — including its undecorated tail — resolves to the same whole token.
 * @param text - one line's text.
 * @param offset - the character offset the caret sits at.
 * @returns the token and its span, or undefined when no `@` governs that offset.
 */
export function tokenRunAt(text: string, offset: number): TokenRun | undefined {
  if (offset < 0 || offset > text.length) return undefined
  let start = offset
  while (start > 0 && !isSpace(text[start - 1] as string)) start -= 1
  let end = offset
  while (end < text.length && !isSpace(text[end] as string)) end += 1
  const at = text.lastIndexOf('@', offset)
  if (at < start) return undefined
  const next = text.indexOf('@', at + 1)
  const tokenEnd = next === -1 || next > end ? end : next
  return { token: text.slice(at, tokenEnd), start: at, end: tokenEnd }
}

/** One reference token under a caret position. */
export interface InlineToken extends TokenRun {
  readonly line: Element
  readonly index: LineIndex
  /** Where the caret sits inside the line's text. */
  readonly local: number
  /** Whether the user has finished typing the token (see {@link DraftToken}). */
  readonly settled: boolean
  /**
   * The offset at which the framework's own colouring stops, when it drew the
   * token's head at all. Only used by a browser that cannot paint a range: there
   * the framework's colour is the only "this is a link" the user can see.
   */
  readonly decoratedEnd?: number
}

/** The first offset of a line's text that one element owns. */
function startOf(index: LineIndex, element: Element): number | undefined {
  return index.nodes.find(entry => element.contains(entry.node))?.start
}

/**
 * The reference token a caret position in the composer resolves to.
 *
 * The token is read from the line's text, not from the framework's decoration:
 * a hand-typed token the editor never recognised is the same reference as one it
 * did, and the caller decides what may be offered (see {@link draftActivation}).
 * @param root - one editor root.
 * @param node - the caret's container node.
 * @param offset - the caret's offset inside that node.
 * @returns the token, or undefined when no `@` token covers the point.
 */
export function tokenAtPoint(root: Element, node: Node, offset: number): InlineToken | undefined {
  const line = blockOf(root, node)
  if (line === undefined) return undefined
  const index = indexLine(line)
  const local = localOffset(index, node, offset)
  if (local === undefined) return undefined
  const run = tokenRunAt(index.text, local)
  if (run === undefined) return undefined
  const head = [...line.querySelectorAll(TEXT_REF_SELECTOR)]
    .find(span => startOf(index, span) === run.start && (span.textContent ?? '').length > 0)
  const settled = settledIn(index.text, run.end, line === root.lastElementChild)
  if (head === undefined) return { ...run, line, index, local, settled }
  return { ...run, line, index, local, settled, decoratedEnd: run.start + (head.textContent ?? '').length }
}

/** One `@` token of the composer, with the line it lives in. */
export interface DraftToken extends TokenRun {
  readonly line: Element
  readonly index: LineIndex
  /**
   * Whether the user has finished typing this token: a whitespace character
   * follows it, or its line is followed by another line (Enter). A token that
   * ends the draft is still being written, and every prefix of a real path is a
   * path the Host has never heard of — judging one would strike it through
   * halfway through typing it.
   */
  readonly settled: boolean
}

/**
 * Whether one token is finished inside its line.
 * @param text - the line's own text.
 * @param end - the token's end offset in it.
 * @param lastLine - whether this is the draft's last line.
 * @returns true when whitespace follows the token, or when another line does.
 */
function settledIn(text: string, end: number, lastLine: boolean): boolean {
  if (end < text.length) return isSpace(text[end] as string)
  return !lastLine
}

/**
 * Every `@` token the composer currently shows, in document order.
 *
 * The tokens are read per line, so the mapping from a token to a DOM range needs
 * no knowledge of how the editor spells its line breaks.
 * @returns the tokens, with the offsets they occupy in their line.
 */
export function draftTokens(): readonly DraftToken[] {
  const out: DraftToken[] = []
  for (const root of editorRoots()) {
    const blocks = [...root.children]
    blocks.forEach((block, position) => {
      const index = indexLine(block)
      for (let at = index.text.indexOf('@'); at >= 0; at = index.text.indexOf('@', at + 1)) {
        // `at` is the trigger's own position, so the run that covers it starts
        // there; a second `@` inside the run belongs to its own token.
        const run = tokenRunAt(index.text, at)
        if (run === undefined || run.token.length < 2) continue
        const settled = settledIn(index.text, run.end, position === blocks.length - 1)
        out.push({ ...run, line: block, index, settled })
      }
    })
  }
  return out
}

/**
 * The action one draft token offers, or undefined when it offers none.
 *
 * This is the plugin's own definition of a draft link, and it deliberately does
 * NOT consult the framework's decoration: a hand-typed `@AGENTS.md` names the
 * same reference whether or not the editor happened to recognise the name.
 *
 * A file or folder token is offered only while the Host CONFIRMS its target: the
 * dock above the composer already inspects exactly those tokens and marks a
 * vanished one `已失效`, so an unknown verdict means "not yet" rather than "yes" —
 * a link drawn before the answer arrives would have to be taken back a moment
 * later, and a link that opens nothing must never be handed to the pointer. A
 * provider or skill token has no such verdict: whether it is openable is its
 * owner's answer, asked through `actionFor`.
 * @param token - one draft token, `@` included.
 * @param actionFor - the session's action lookup.
 * @param verdict - the dock's last inspection verdict for one referenced path.
 * @returns the action, or undefined when there is nothing to open.
 */
export function draftActivation(
  token: string,
  actionFor: (link: ReferenceLink) => DraftAction | undefined,
  verdict: DraftVerdictLookup,
): DraftActivation | undefined {
  const link = draftLink(token)
  if (link === undefined) return undefined
  const resolved = withHostKind(link, verdict)
  if (resolved === undefined) return undefined
  const run = actionFor(resolved)
  return run === undefined ? undefined : { link: resolved, run }
}

/** The Host's inspection verdict for one referenced path. */
export interface DraftVerdict {
  /** Whether the target exists right now. */
  readonly exists: boolean
  /** The target's kind, when the Host reported one. */
  readonly kind?: 'file' | 'dir'
}

/** Look one referenced path up among the dock's verdicts. */
export type DraftVerdictLookup = (path: string) => DraftVerdict | undefined

/**
 * The reference a decoded link names, once the Host's own KIND is folded in.
 *
 * A path typed by hand carries no kind: `@docs` is a directory on disk but reads
 * as a file token, and opening it as a file fails (that is what "手打 @docs 没有
 * 识别为文件夹链接" was). The dock already inspected every draft token, so the
 * verdict for this exact path is in hand: a target the Host calls a directory
 * becomes the FOLDER reference it is — which is also the reference that gets the
 * sidebar + OS open a folder click performs. A trailing separator keeps winning
 * (it is what the user wrote), and a target that is gone stays unopenable.
 * @param link - the decoded reference.
 * @param verdict - the dock's last inspection verdict for one referenced path.
 * @returns the reference to open, or undefined when it is not confirmed.
 */
function withHostKind(link: ReferenceLink, verdict: DraftVerdictLookup): ReferenceLink | undefined {
  if (link.kind !== 'file' && link.kind !== 'folder') return link
  const info = verdict(link.path)
  if (info?.exists !== true) return undefined
  if (link.kind === 'file' && info.kind === 'dir') return { kind: 'folder', path: link.path }
  return link
}

/**
 * Whether one draft token is a reference whose target the Host reports as gone.
 *
 * This is the dock's own `已失效` state, said in the composer: the token names a
 * file or a folder, the inspection answered, and the answer was no. It is NOT
 * the same as an unanswered inspection (nothing is claimed then) and not the
 * same as a token that decodes into no reference at all (`@plugin:x` is a label,
 * not a path) — neither of those is a claim the plugin can make about a file.
 * @param token - one draft token, `@` included.
 * @param verdict - the dock's last inspection verdict for one referenced path.
 * @returns true when the token names a target that is gone.
 */
export function draftMissing(
  token: string,
  verdict: DraftVerdictLookup,
): boolean {
  const link = draftLink(token)
  if (link === undefined) return false
  if (link.kind !== 'file' && link.kind !== 'folder') return false
  return verdict(link.path)?.exists === false
}

/**
 * Decode one draft token into the reference it names.
 *
 * {@link decodeDraftReference} owns the vocabulary. A file token may still carry
 * the line-range spelling (`@src/view.ts:12-40`), which that decoder accepts as
 * a path because its colon is not in the first segment; the range is a reading
 * instruction rather than part of the path, so it is dropped here exactly as the
 * dock's rows drop it. A handle spelling (`@file:12-40`) is refused by the
 * decoder itself, and stays refused.
 * @param token - one draft token, `@` included.
 * @returns the reference, or undefined when the token names nothing openable.
 */
export function draftLink(token: string): ReferenceLink | undefined {
  const direct = decodeDraftReference(token)
  if (direct === undefined || direct.kind !== 'file') return direct
  const target = splitLineRange(direct.path)
  return target.lines === undefined ? direct : { kind: 'file', path: target.path }
}

/** Whether this browser can colour text ranges without touching the editor's DOM. */
export function canPaintTails(): boolean {
  return typeof CSS !== 'undefined' && CSS.highlights !== undefined && typeof Highlight === 'function'
}

/** How one draft token should be drawn: an openable link, or a stale reference. */
export type DraftPaint = 'link' | 'missing'

/** How many tokens of each kind the last {@link paintDraftLinks} pass drew. */
export interface DraftPaintCount {
  readonly link: number
  readonly missing: number
}

/**
 * Publish one highlight set, or clear it when nothing belongs to it.
 * @param name - the highlight name the stylesheet targets.
 * @param ranges - the ranges to paint.
 * @param count - how many ranges were collected (0 clears the set).
 */
function publishHighlight(name: string, ranges: Highlight, count: number): void {
  if (count === 0) CSS.highlights.delete(name)
  else CSS.highlights.set(name, ranges)
}

/**
 * Paint every draft token `decide` classifies.
 *
 * The whole token is painted, not just the part the framework happened to
 * colour: a link that opens on a click must look like a link along its entire
 * length, and the framework's own colour (when it drew one) is the same design
 * token, so nothing shifts for a token it did recognise. A token whose target is
 * gone is painted the other way — stale, the dock's own language — so a
 * reference that cannot open is visibly a reference rather than ordinary prose.
 * The API paints ranges over the existing text, so the editor's node structure
 * is untouched.
 * @param decide - classifies one token; it receives the token with its line and
 *   its `settled` flag, because a token still being typed must not be judged.
 * @returns how many tokens of each kind were painted.
 */
export function paintDraftLinks(decide: (token: DraftToken) => DraftPaint | undefined): DraftPaintCount {
  if (!canPaintTails()) return { link: 0, missing: 0 }
  const links = new Highlight()
  const stale = new Highlight()
  let link = 0
  let missing = 0
  for (const token of draftTokens()) {
    const decision = decide(token)
    if (decision === undefined) continue
    const from = pointAt(token.index, token.start)
    const to = pointAt(token.index, token.end)
    if (from === undefined || to === undefined) continue
    const range = token.line.ownerDocument.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    if (decision === 'missing') {
      stale.add(range)
      missing += 1
    } else {
      links.add(range)
      link += 1
    }
  }
  publishHighlight(DRAFT_HIGHLIGHT, links, link)
  publishHighlight(MISSING_HIGHLIGHT, stale, missing)
  return { link, missing }
}

/**
 * Show or clear the link pointer on one composer.
 *
 * The cursor cannot be part of a highlight — it is a property of the element
 * under the pointer, and the undecorated tail shares its element with whatever
 * prose follows — so the bridge hit-tests the pointer and publishes the answer
 * on the editor root.
 * @param root - one editor root.
 * @param hot - whether the pointer is over an openable reference token.
 */
export function setEditorCursor(root: Element, hot: boolean): void {
  const element = root as HTMLElement
  if (hot) element.style.cursor = 'pointer'
  else element.style.removeProperty('cursor')
}
