/**
 * Click-through for the reference chips the product renders.
 *
 * The product draws a reference as a chip — glyph plus label — but leaves it
 * inert in this client build, in both places a chip appears:
 *
 * - a SENT message renders `@path` through `projectUserText`, which only becomes
 *   interactive when its caller passes the reference actions, and the installed
 *   chat view still calls it without them;
 * - the COMPOSER holds an inserted reference as an atomic chip node
 *   (`data-composer-chip`), whose React face is the same blue body the sent chip
 *   uses and which this build activates not at all.
 *
 * Both are stable, framework-owned DOM contracts, so the plugin supplies the
 * missing click by delegation rather than by re-rendering anything: a chip that
 * is not already a `<button>` (i.e. one the framework did NOT wire itself) is
 * decoded into one mention, and the injection turns that mention into the action
 * a click performs — a file lands in the product's right Sidebar (the same place
 * the framework opens it when it does wire it), a skill goes to the skill source,
 * and a seam provider item goes to its own `open` callback. Once a build passes
 * those actions, every chip is a button and this bridge steps aside on its own.
 *
 * Hover affordance is published the same way: a chip whose mention yields an
 * action is marked (`data-dsh-atlas-link`) as soon as it renders, and the
 * stylesheet gives exactly those chips the product's own link language — the
 * framework's `--dsw-alias-link` colour at rest, a dotted underline and a pointer
 * cursor under the mouse — so a reference reads as clickable before the mouse
 * reaches it, and an inert one (unknown provider, provider without `open`) never
 * does. Nothing is rendered here.
 */
import { useEffect, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { splitLineRange } from '../tokens.ts'
import { basenameOf } from './model.ts'
import { decodeDraftReference, decodeReferenceLink, type ReferenceLink } from './reference-links.ts'

/** The framework-owned attribute carried by every decorated reference chip. */
const CHIP_ATTRIBUTE = 'data-ref-chip'

/**
 * The framework-owned attribute on a COMPOSER chip's host element.
 *
 * The composer holds two different reference renderings. A plain-text token the
 * editor recognised becomes an editable text span (`data-composer-text-ref`,
 * see `draft-links.ts`); a reference another source INSERTED becomes an atomic
 * decorator node — `<span data-composer-chip="<source>" contenteditable="false">`
 * — whose React face draws the same blue body as a sent chip
 * (`color: var(--dsw-alias-state-business-primary)`) and, in this client build,
 * activates nothing at all. Its host carries no `data-ref-chip`, so the chip
 * branch below has to look for it separately; the visible label is the body
 * element's `title`, with the `@` drawn as its own marker.
 */
const COMPOSER_CHIP_ATTRIBUTE = 'data-composer-chip'

/** The attribute this bridge sets on a chip it can open (hover affordance hook). */
export const LINK_ATTRIBUTE = 'data-dsh-atlas-link'

/** The attribute this bridge sets on a chip whose target is gone (stale styling hook). */
export const MISSING_ATTRIBUTE = 'data-dsh-atlas-missing'

/** The chip kind whose title may name a file, a skill, or a session. */
const LINKABLE_KIND = 'file'

/** The second linkable kind: a session chip whose title still carries the wire URI. */
const SESSION_KIND = 'session'

/** What a click on one reference did, as far as the chip is concerned. */
export type ReferenceOutcome = 'opened' | 'gone'

/** What the session's overlay shares with the bridge. */
export interface ReferenceLinksInjected {
  /**
   * The action a click on this mention performs, or undefined when this build
   * has none (an unknown provider, a provider that declared no `open`, a
   * session with no client scope). The same answer drives the hover affordance,
   * so a chip is never drawn as clickable unless clicking really does something.
   *
   * The outcome is what the chip has to show: a reference whose target no longer
   * exists is a normal state — the user deleted or renamed the file long after
   * the mention was sent — so the bridge marks that chip stale instead of
   * pretending the click opened something.
   */
  readonly actionFor: (link: ReferenceLink) => (() => ReferenceOutcome | Promise<ReferenceOutcome>) | undefined
  /**
   * Map one composer chip's label to a workspace-relative path.
   *
   * A source that inserts chips may label them with a bare file name (the
   * sidebar plugin does: the chip shows `@index.ts` while it serializes to
   * `@src/client/index.ts`), so a bare name is resolved through the plugin's own
   * index before the click. `undefined` means the label alone cannot name one
   * file (two indexed paths answer to it), and the bridge then falls back to the
   * draft — never to a guess.
   */
  readonly resolveLabel: (label: string) => string | undefined
}

/** Overlay entry props: the chat overlay's runtime face plus the opener. */
export type ReferenceLinksProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<ReferenceLinksInjected>

/**
 * The openable mention of one chip element, or undefined.
 *
 * A `<button>` chip means the framework passed its reference actions and wires
 * the click itself; acting as well would open the resource twice. A chip of any
 * other kind (folder, skill-slash, command) is not ours to open — EXCEPT a
 * session chip, which is nobody else's: DSH renders every session mention as a
 * plain label element, so switching sessions is exactly the click this bridge
 * has to add. Its title has to carry the wire URI for that (the host folds the
 * mention to a bare label before the message is durable), which
 * `decodeReferenceLink` decides by value.
 * @param chip - the chip element.
 * @returns the decoded action, or undefined when the bridge must not act.
 */
export function chipLink(chip: Element): ReferenceLink | undefined {
  if (chip.tagName === 'BUTTON') return undefined
  const kind = chip.getAttribute(CHIP_ATTRIBUTE)
  if (kind !== LINKABLE_KIND && kind !== SESSION_KIND) return undefined
  const link = decodeReferenceLink(chip.getAttribute('title'))
  // The chip's own kind must agree with what its title decoded to: a session
  // chip whose bare label happens to look like a path (`@a.ts`) must never be
  // opened as that path — the label is a session title, not a workspace spelling.
  if (link !== undefined && kind === SESSION_KIND && link.kind !== 'session') return undefined
  return link
}

/** The visual body of a composer chip inside its host element. */
export function composerChipBody(host: Element): Element {
  return host.querySelector('[title]') ?? host
}

/**
 * The openable mention of one composer chip, or undefined.
 *
 * The label is the chip body's `title` (the framework renders the visible `@` as
 * a separate marker span, and uses a domain icon instead for some sources), with
 * the host's own text as the fallback. A label that is not a mention of ours — a
 * slash chip (`/skill`), an empty label, a provider handle — stays inert, exactly
 * as an inert sent chip does.
 *
 * Unlike a draft TOKEN, this is not checked against the Host first: the label is
 * another source's display text, not necessarily a workspace spelling the dock
 * inspected. `dsh-better-sidebar`, which inserts these chips, labels a chip with
 * the file's BASENAME while its serialization keeps the full relative path, so
 * the caller resolves a bare name through the plugin's own index before the
 * click, and the click itself discovers a vanished target the way a sent chip
 * does — the action reports `gone` and the chip is marked stale.
 * @param host - one `[data-composer-chip]` host element.
 * @param resolve - maps one chip label to a workspace-relative path.
 * @returns the decoded mention, or undefined when the bridge must not act.
 */
export function composerChipLink(
  host: Element,
  resolve: (label: string) => string | undefined = label => label,
): ReferenceLink | undefined {
  const raw = (composerChipBody(host).getAttribute('title') ?? host.textContent ?? '').trim()
  if (raw === '' || raw.startsWith('/')) return undefined
  const label = raw.startsWith('@') ? raw.slice(1) : raw
  const path = resolve(label)
  if (path === undefined) return undefined
  // The draft vocabulary, not the chip one: a label may name a directory
  // (`Eason/`), which the sent-chip decoder deliberately refuses because its own
  // chips carry the folder kind separately.
  return decodeDraftReference(`@${path}`)
}

/**
 * The one draft token a bare chip label names, or undefined.
 *
 * A chip's full reference lives in its Lexical node, not in the DOM — but the
 * DRAFT keeps exactly what that source serializes (the whole mention), so a
 * label the index could not place is still recoverable when the draft holds
 * precisely one token with that basename. Two candidates mean the label cannot
 * say which one is meant, and the answer is then undefined: an inert chip beats
 * opening the wrong file.
 * @param draft - the composer's draft text.
 * @param label - the chip's visible label.
 * @returns the workspace-relative path the draft spells, or undefined.
 */
export function draftPathForLabel(draft: string, label: string): string | undefined {
  let match: string | undefined
  for (const token of draft.matchAll(/@([^\s@]+)/gu)) {
    const raw = token[1] as string
    // A quoted spelling can hold whitespace, so it cannot be read as one token here.
    if (raw.startsWith('"')) continue
    const path = splitLineRange(raw).path.replace(/[\\/]+$/u, '')
    if (path === '' || basenameOf(path) !== label) continue
    if (match !== undefined && match !== path) return undefined
    match = path
  }
  return match
}

/**
 * Whether a click is a reference gesture rather than a text interaction: the
 * framework's own chips ignore double clicks and clicks that end inside a
 * selection, so the bridge follows the same rule.
 * @param event - the click event.
 * @param chip - the chip the click landed on.
 * @returns true when the click should open the reference.
 */
function isPlainClick(event: MouseEvent, chip: Element): boolean {
  if (event.detail > 1) return false
  // detail 0 is a synthetic click (keyboard activation): there is no selection
  // gesture to protect, so it counts as plain.
  if (event.detail === 0) return true
  return chip.ownerDocument.getSelection()?.isCollapsed !== false
}

/** Invisible bridge: opens the reference chips the product renders on click. */
export function ReferenceLinks({ actionFor, resolveLabel, useInput }: ReferenceLinksProps) {
  const draft = useInput(state => state.draft)
  // The face is re-created on every injection and the chat re-renders on every
  // streamed token: hold it in a ref so the document listeners are installed
  // ONCE per mount instead of being torn down and re-added under the user's
  // pointer (a click landing in that window would be lost).
  const face = useRef({ actionFor, resolveLabel, draft })
  useEffect(() => { face.current = { actionFor, resolveLabel, draft } }, [actionFor, resolveLabel, draft])
  /**
   * Place one composer chip's label, index first and draft second.
   * @param label - the chip's visible label.
   * @returns the path to open, or undefined when the label cannot name one file.
   */
  const placeLabel = (label: string): string | undefined =>
    face.current.resolveLabel(label) ?? draftPathForLabel(face.current.draft, label)
  useEffect(() => {
    /**
     * Mark one chip as openable, or leave it inert.
     *
     * Marking eagerly (not only under the pointer) is what lets the stylesheet
     * give the chip the product's own link language AT REST — the same
     * `--dsw-alias-link` colour the framework gives its wired chips — instead of
     * promising the affordance only once the mouse is already on it.
     */
    const markChip = (chip: Element): void => {
      // A chip already known to be stale stays stale: its reference did not come
      // back, and offering the click again would only repeat the same nothing.
      if (chip.hasAttribute(LINK_ATTRIBUTE) || chip.hasAttribute(MISSING_ATTRIBUTE)) return
      const link = chipLink(chip)
      if (link === undefined || face.current.actionFor(link) === undefined) return
      chip.setAttribute(LINK_ATTRIBUTE, '')
    }
    /**
     * Mark one composer chip as openable.
     *
     * The mark goes on the chip's BODY, not its host: that body is what the
     * framework styles (`color` and `cursor: default` both live there), so it is
     * the element the link language has to override. When the body has not been
     * rendered yet (the host element appears before its React portal does) the
     * host is marked instead and the body is picked up by the next pass.
     */
    const markComposerChip = (host: Element): void => {
      const body = composerChipBody(host)
      if (body.hasAttribute(LINK_ATTRIBUTE) || body.hasAttribute(MISSING_ATTRIBUTE)) return
      const link = composerChipLink(host, placeLabel)
      if (link === undefined || face.current.actionFor(link) === undefined) return
      body.setAttribute(LINK_ATTRIBUTE, '')
    }
    const markWithin = (root: Element): void => {
      if (root.hasAttribute(CHIP_ATTRIBUTE)) markChip(root)
      for (const chip of root.querySelectorAll(`[${CHIP_ATTRIBUTE}]`)) markChip(chip)
      if (root.hasAttribute(COMPOSER_CHIP_ATTRIBUTE)) markComposerChip(root)
      for (const host of root.querySelectorAll(`[${COMPOSER_CHIP_ATTRIBUTE}]`)) markComposerChip(host)
    }
    /**
     * Open the reference one click landed on.
     *
     * The affordance is published on the element whose styling decides the look —
     * the chip itself for a sent chip, the chip BODY for a composer chip, whose
     * host carries no colour of its own — so a stale outcome is written where the
     * pointer can see it.
     * @param chip - the chip element the plain-click rule is judged on.
     * @param link - the mention this chip names, when it names one.
     * @param event - the click event.
     * @param mark - the element carrying the link affordance.
     */
    const open = (chip: Element, link: ReferenceLink | undefined, event: MouseEvent, mark: Element): void => {
      if (link === undefined || !isPlainClick(event, chip)) return
      const action = face.current.actionFor(link)
      if (action === undefined) return
      event.preventDefault()
      event.stopPropagation()
      void Promise.resolve(action()).then((outcome) => {
        if (outcome !== 'gone') return
        // The reference outlived its target. Say so on the chip itself: the
        // click did nothing because there is nothing to open, and a stale look
        // is the honest outcome (the dock's file rows use the same language).
        mark.removeAttribute(LINK_ATTRIBUTE)
        mark.setAttribute(MISSING_ATTRIBUTE, '')
      })
    }
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const chip = event.target.closest(`[${CHIP_ATTRIBUTE}]`)
      if (chip !== null) {
        open(chip, chipLink(chip), event, chip)
        return
      }
      // A composer chip: an atomic reference node another source inserted. It is
      // drawn as a link (the framework's own chip blue) but this build wires no
      // click to it, so the plugin supplies one — the same way it does for a sent
      // chip, and with the mark on the chip body the framework styles.
      const host = event.target.closest(`[${COMPOSER_CHIP_ATTRIBUTE}]`)
      if (host === null) return
      open(host, composerChipLink(host, placeLabel), event, composerChipBody(host))
    }
    const onOver = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      // The pointer pass stays as the safety net for a chip that became openable
      // without new DOM: a provider that registers after its mention was rendered,
      // or a composer chip whose body rendered after its host element.
      const chip = event.target.closest(`[${CHIP_ATTRIBUTE}]`)
      if (chip !== null) {
        markChip(chip)
        return
      }
      const host = event.target.closest(`[${COMPOSER_CHIP_ATTRIBUTE}]`)
      if (host !== null) markComposerChip(host)
    }
    markWithin(document.body)
    // Watch only ADDED subtrees: the transcript streams tokens in bursts, and a
    // full-document sweep per batch would be work proportional to the transcript
    // instead of to what arrived.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          markWithin(node)
          // A composer chip's body arrives through its portal, i.e. as a subtree
          // added INSIDE an already-mounted host element: the host is what has to
          // be marked then, and it is an ancestor rather than a descendant.
          const host = node.closest(`[${COMPOSER_CHIP_ATTRIBUTE}]`)
          if (host !== null) markComposerChip(host)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('click', onClick, true)
    document.addEventListener('mouseover', onOver, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('mouseover', onOver, true)
    }
  }, [])
  return null
}
