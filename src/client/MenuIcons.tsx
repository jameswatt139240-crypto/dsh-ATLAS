/**
 * Menu glyphs: this plugin's own icons, drawn over the framework's menu rows.
 *
 * The framework renders a candidate icon through its own `ReferenceIcon`, which
 * knows exactly three kinds (`session`, `file`, `folder`) and returns nothing for
 * anything else — React element, component or emoji alike. So a row of ours can
 * declare which box it wants but not what goes in it: `menuIconKind` reserves the
 * 16 px slot (that is what lines the names up), and this overlay draws the glyph.
 *
 * It draws OUTSIDE the framework's DOM: the slot is measured with
 * `getBoundingClientRect` and the glyph is rendered into a fixed-position layer
 * of our own, so nothing is inserted into, or removed from, a row the framework
 * owns. The only thing written back is one attribute on the slot, which is what
 * lets the stylesheet hide the framework's own glyph exactly where ours covers
 * it — never anywhere else, and never when this overlay failed to place one.
 *
 * Being outside that DOM also means the layer does NOT inherit the menu's
 * clipping: the framework's list is a scrolling viewport (`[role="listbox"]`
 * with `overflow-y: auto`), and a slot measured for a row scrolled out of it
 * would put our glyph outside the menu entirely — over the composer card below
 * it. So a glyph is drawn only while its row is FULLY INSIDE that viewport; a
 * clipped row keeps the framework's own glyph, exactly like a slot this overlay
 * cannot place. Degrading to "no glyph of ours" is always the safe direction.
 *
 * The glyphs are the same Tabler set the reference dock uses (per file type and
 * per language). A row that carries data is monochrome so it reads as one line of
 * text rather than as a badge stuck next to it; a CATEGORY row is drawn in its
 * accent hue (`menuGlyphColor`), which is where the menu spends colour on
 * meaning rather than decoration.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { menuGlyph, menuGlyphColor, type MenuGlyphRow } from './icons.tsx'
import { SOURCE_NAME } from './source.ts'

/** The attribute this overlay sets on an icon slot it covers. */
export const HOST_ATTRIBUTE = 'data-dsh-atlas-menu-icon-host'

/** The framework's own id for one option row of one source. */
function optionId(index: number): string {
  return `dsh-slash-option-${SOURCE_NAME}-${index}`
}

/** Our group's rows in the live menu, or nothing while it is closed or pending. */
function ourRows(state: MenuState): readonly MenuGlyphRow[] {
  if (!state.open) return []
  const group = state.groups.find(candidate => candidate.source === SOURCE_NAME)
  return group?.status === 'ready' ? group.items as readonly MenuGlyphRow[] : []
}

/** One glyph with the screen position of the slot it belongs in. */
interface Placed {
  readonly row: MenuGlyphRow
  readonly key: number
  readonly top: number
  readonly left: number
  /** The row's accent, or undefined to keep the neutral glyph colour. */
  readonly color: string | undefined
}

/** Sub-pixel slack when testing a slot against the viewport that clips it. */
const EDGE_SLACK = 1

/**
 * The slot of one option row, but only while that row is fully inside the
 * menu's scrolling viewport.
 *
 * `getBoundingClientRect` answers for clipped content too, so a row scrolled out
 * of the list still reports a real rect — below the menu, where this fixed
 * layer would happily paint it over the composer. Requiring the slot to sit
 * inside the viewport's own rect is what keeps every glyph inside the menu.
 * @param option - the option row element, or null when the row is not rendered.
 * @returns the slot element and its rect, or undefined when it must be left alone.
 */
function visibleSlot(option: HTMLElement | null): { box: Element; rect: DOMRect } | undefined {
  if (option === null) return undefined
  const box = option.querySelector('[class*="itemIcon"]')
  if (box === null) return undefined
  // No viewport found means the menu's markup is not what this layer knows: draw
  // nothing rather than guess where the clip is.
  const viewport = option.closest('[role="listbox"]')
  if (viewport === null) return undefined
  const rect = box.getBoundingClientRect()
  const clip = viewport.getBoundingClientRect()
  const inside = rect.top >= clip.top - EDGE_SLACK
    && rect.bottom <= clip.bottom + EDGE_SLACK
    && rect.left >= clip.left - EDGE_SLACK
    && rect.right <= clip.right + EDGE_SLACK
  return inside ? { box, rect } : undefined
}

/** What the session's overlay shares with the menu layer. */
export interface MenuIconsInjected {
  /** The trigger controller's menu store: the rows, their order, and the open state. */
  readonly hooks: { readonly menu: SnapshotStore<MenuState> }
}

/** Overlay entry props: the composer runtime face plus the menu store. */
export type MenuIconsProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<MenuIconsInjected>

/** The glyph layer. */
export function MenuIcons({ useMenu }: MenuIconsProps) {
  const state = useMenu(snapshot => snapshot)
  const [placed, setPlaced] = useState<readonly Placed[]>([])
  // Slots currently marked as covered; a slot stops being marked the moment this
  // overlay stops drawing into it, so the framework's own glyph comes back
  // rather than leaving an empty box behind.
  const covered = useRef<readonly Element[]>([])

  const measure = (): void => {
    const rows = ourRows(state)
    const next: Placed[] = []
    const boxes: Element[] = []
    rows.forEach((row, index) => {
      const slot = visibleSlot(document.getElementById(optionId(index)))
      if (slot === undefined) return
      // The glyph is drawn centred on the slot the framework laid out.
      next.push({
        row,
        key: index,
        left: slot.rect.left + slot.rect.width / 2 - GLYPH_SIZE / 2,
        top: slot.rect.top + slot.rect.height / 2 - GLYPH_SIZE / 2,
        color: menuGlyphColor(row),
      })
      boxes.push(slot.box)
    })
    for (const box of covered.current) if (!boxes.includes(box)) box.removeAttribute(HOST_ATTRIBUTE)
    for (const box of boxes) box.setAttribute(HOST_ATTRIBUTE, '')
    covered.current = boxes
    setPlaced(next)
  }

  // Measure after the framework's own commit — the rows are its DOM, and this
  // component re-renders from the same store update that renders them.
  useLayoutEffect(measure, [state])
  // A scrolling list or a resized window moves the slots without touching the
  // menu state, so the layer follows those two events as well.
  useEffect(() => {
    const onMove = (): void => { measure() }
    window.addEventListener('resize', onMove)
    document.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      document.removeEventListener('scroll', onMove, true)
    }
  }, [state])
  useEffect(() => () => {
    for (const box of covered.current) box.removeAttribute(HOST_ATTRIBUTE)
  }, [])

  if (placed.length === 0) return null
  return (
    <>
      {placed.map(entry => (
        <span
          key={`${entry.key}:${entry.row.mentionKind}`}
          className="dsh_atlas_menuIcon"
          style={{ top: `${entry.top}px`, left: `${entry.left}px`, color: entry.color }}
          aria-hidden
        >
          {menuGlyph(entry.row, GLYPH_SIZE)}
        </span>
      ))}
    </>
  )
}

/** Glyph size in px, matching the slot the framework reserves. */
const GLYPH_SIZE = 16
