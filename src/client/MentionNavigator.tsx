/**
 * The @ mention menu's overlay bridge: the two gestures the framework's own
 * keymap has no concept of.
 *
 * 1. **Group collapse** — `skill`/`plugin`/`chat` group headers fold, by click or
 *    by Enter while one is highlighted. The framework settles (or drills) the
 *    highlighted row; folding is ours.
 * 2. **Category rows keep the menu open** — picking a category row or the back row
 *    through the normal pick path closes the menu, so those two row kinds are
 *    intercepted and re-tracked instead (`applyCompletion`).
 *
 * Everything else belongs to the framework and is deliberately NOT touched here:
 * Tab completion, ↑/↓, Esc, and the plain pick. Nothing in this file reads the
 * input element — the composer is a Lexical contenteditable, so a handler gated
 * on `HTMLTextAreaElement` would silently never run, which is exactly what the
 * deleted textarea-era completion ghost and ArrowRight bridge did.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  InputTriggerCandidate,
  MenuState,
  TriggerGuard,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { completionTarget, SOURCE_NAME } from './source.ts'
import type { AtFileSettingsSource } from './FilesDock.tsx'

/** Controller surface required by the completion bridge. */
export interface MentionNavigationController {
  readonly menu: SnapshotStore<MenuState>
  track(draft: string, caret: number, guard: TriggerGuard, draftRev: number): void
  /** Close the menu without a pick (used to force a refresh). */
  dismiss(): void
}

/** Injected controller for the current session. */
export interface MentionNavigatorInjected {
  readonly controller: MentionNavigationController
  readonly hooks: { scope: AtFileSettingsSource }
  readonly sessionId: string
  /** Toggle one group header's collapse state (chat:/skill: keys). */
  readonly toggleGroup: (key: string) => void
  /** Synchronously rebuild rows for a category query from settled caches. */
  readonly rebuildRows: (sessionId: string, query: string) => readonly InputTriggerCandidate[] | undefined
  /**
   * A message was submitted. The Host records referenced external paths in its
   * ledger during the send, so any cached out-of-workspace scope is now suspect.
   */
  readonly onSend?: () => void
}

/** Overlay entry props: session input state/actions plus the trigger controller. */
export type MentionNavigatorProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<MentionNavigatorInjected>

/** Input facts needed to validate a menu-time completion. */
export interface MentionNavigationInput {
  readonly draft: string
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

/**
 * The row kinds this plugin folds.
 *
 * Folding a group header is one of the two menu gestures this plugin owns; these
 * are the headers that carry it. `dir-group` is the folder category's own two
 * headers (out-of-workspace and workspace folders), and `browse-note` is never a
 * group — it is a line of prose the user cannot pick.
 */
const GROUP_KINDS: readonly string[] = ['chat-group', 'skill-group', 'plugin-group', 'dir-group']

/** The group row currently highlighted in the @ menu, if any. */
export function highlightedGroup(menu: MenuState): { key: string; index: number } | undefined {
  if (menu.highlight === null || menu.highlight.source !== SOURCE_NAME) return undefined
  const group = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
  if (group?.status !== 'ready') return undefined
  const item = group.items[menu.highlight.index] as { groupKey?: string; mentionKind?: string } | undefined
  if (item?.mentionKind === undefined || !GROUP_KINDS.includes(item.mentionKind)) return undefined
  if (item.groupKey === undefined) return undefined
  return { key: item.groupKey, index: menu.highlight.index }
}

/** The group row at a menu index, or undefined. */
export function groupAt(menu: MenuState, index: number): { key: string } | undefined {
  return groupItemAt(menu, index)
}

/** Whether the row at index is the back-to-categories row. */
export function backRowAt(menu: MenuState, index: number): boolean {
  return rowAt(menu, index)?.mentionKind === 'back'
}

/** The category row at index (its draft prefix), or undefined. */
export function categoryRowAt(menu: MenuState, index: number): { prefix: string } | undefined {
  const item = rowAt(menu, index)
  if (item?.mentionKind !== 'category' || item.value === undefined) return undefined
  return { prefix: item.value }
}

/** One menu row with the source-owned routing fields. */
function rowAt(menu: MenuState, index: number): { mentionKind?: string; value?: string } | undefined {
  const group = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
  if (group?.status !== 'ready') return undefined
  return group.items[index] as { mentionKind?: string; value?: string } | undefined
}

/** The group row item at a menu index (shared by the click and keyboard paths). */
function groupItemAt(menu: MenuState, index: number): { key: string } | undefined {
  const group = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
  if (group?.status !== 'ready') return undefined
  const item = group.items[index] as { groupKey?: string; mentionKind?: string } | undefined
  if (item?.mentionKind === undefined || !GROUP_KINDS.includes(item.mentionKind)) return undefined
  return item.groupKey === undefined ? undefined : { key: item.groupKey }
}

/** Whether a menu item is a section header (category/back/group) rather than a result leaf. */
export function isHeaderRow(item: { mentionKind?: string } | undefined): boolean {
  if (item?.mentionKind === undefined) return false
  return GROUP_KINDS.includes(item.mentionKind)
    || item.mentionKind === 'category'
    || item.mentionKind === 'back'
    || item.mentionKind === 'section-header'
}

/**
 * The index of the first result leaf in the atlas group (skipping every
 * section header), or -1 when the menu has no result rows yet.
 */
export function firstLeafIndex(menu: MenuState): number {
  const group = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
  if (group?.status !== 'ready') return -1
  return group.items.findIndex(item => !isHeaderRow(item as { mentionKind?: string }))
}

/**
 * The row a freshly settled query's default highlight belongs on.
 *
 * A query that uniquely names a category — a shortcut letter (F/D/S/C/P) or an
 * English prefix (fi/fo/sk/ch/pl) — is an explicit "I want this category"
 * intent, so the highlight goes to that category's own row: the gray hint row
 * the source pins on top, whose pick enters `@<category>:`. Landing on the
 * first result leaf instead would make Enter insert whichever most-used entry
 * happens to contain the typed letter, which is the opposite of what typing a
 * category shortcut asks for. Every other query keeps the best-match behavior
 * and lands on the first result leaf.
 * @param menu - the live menu state.
 * @returns the row index, or -1 when no row qualifies yet.
 */
export function defaultHighlightIndex(menu: MenuState): number {
  const group = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
  if (group?.status !== 'ready') return -1
  const rows = group.items as readonly { mentionKind?: string; value?: string; completionHint?: true }[]
  // The SOURCE decides what a query completes to — it is the one that knows the
  // registered provider categories, each with the shortcut letter it claimed —
  // and marks that row. If it marked one, that is the row the highlight belongs
  // on: the hint row, which the source puts LAST, so it is the bottom-most row of
  // the menu, the one nearest the composer.
  const hint = rows.findIndex(row => row.completionHint === true)
  if (hint >= 0) return hint
  // A bare `@` is the category menu. The highlight has to be OURS here: the
  // framework highlights the first row of the first source, which is the stock
  // `dsh-client-ui-reference` group sitting ABOVE this plugin's bottom band, and
  // then scrolls the list to it — so the categories flash into view and are
  // pushed out again.
  if (menu.hit !== null && menu.hit.query.trim() === '') {
    return rows.findIndex(row => row.mentionKind === 'category')
  }
  const category = menu.hit === null ? undefined : completionTarget(menu.hit.query)
  if (category === undefined) return firstLeafIndex(menu)
  const index = rows.findIndex(row => row.mentionKind === 'category' && row.value === category.prefix)
  return index >= 0 ? index : firstLeafIndex(menu)
}

/**
 * One completion waiting for the draft to settle: the text to write, where the
 * caret belongs, and the trigger tier to re-track under.
 */
interface PendingCompletion {
  readonly draft: string
  readonly caret: number
  readonly tier: 'plain' | 'claimed'
}

/**
 * Frames the bottom-band anchor keeps re-asserting after a content change.
 *
 * The framework's own "scroll the highlight into view" runs in a passive effect,
 * so it can land after the frame that anchored the band. Six frames (~100 ms) is
 * enough to outlast that without fighting a deliberate user scroll.
 */
const HOLD_FRAMES = 6

/**
 * Rows one PageUp/PageDown covers when the list cannot be measured.
 *
 * jsdom implements no layout, and a browser can be asked before the list has one:
 * a fixed page is better than a division by zero, and eight rows is what the menu
 * shows at its usual height anyway.
 */
export const PAGE_ROWS = 8

/**
 * How many rows one page covers in the open menu.
 *
 * Measured from the live list rather than assumed, so a taller window pages
 * further and a short one does not jump past what the user can see.
 * @param box - the menu's scrolling listbox, or null when it is not rendered.
 * @returns the row count of one page (at least one).
 */
export function pageStep(box: Element | null): number {
  const height = box instanceof HTMLElement ? box.clientHeight : 0
  const rowHeight = box?.firstElementChild?.getBoundingClientRect().height ?? 0
  if (height <= 0 || rowHeight <= 0) return PAGE_ROWS
  return Math.max(1, Math.floor(height / rowHeight) - 1)
}

/** Whether this is a plain Enter: no IME ownership, no modifier, not already handled. */
export function isPlainEnter(event: Pick<KeyboardEvent,
  'key' | 'keyCode' | 'defaultPrevented' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  return event.key === 'Enter'
}

/** Invisible overlay entry: folds group headers and keeps category rows in the menu. */
export function MentionNavigator({ controller, useInput, inputActions, toggleGroup, sessionId, rebuildRows, onSend }: MentionNavigatorProps) {
  const input = useInput(state => state)
  const pending = useRef<PendingCompletion | null>(null)
  // One call per submission: the phase stays 'submitting' while the turn starts.
  const sentRef = useRef(false)
  useEffect(() => {
    if (input.phase === 'submitting') {
      if (sentRef.current) return
      sentRef.current = true
      onSend?.()
      return
    }
    sentRef.current = false
  }, [input.phase, onSend])

  // Menu height budget: publish the real space above the composer as a CSS
  // variable, so the list caps itself at the available height instead of
  // guessing with viewport arithmetic. The menu is bottom-anchored above the
  // composer card, so that card's top edge is the budget; re-measure on every
  // menu change and on resize (the composer grows with multi-line drafts).
  useLayoutEffect(() => {
    let published = ''
    const publish = (): void => {
      const card = document.querySelector('[data-composer-card]')
      const top = card?.getBoundingClientRect().top
      const root = document.documentElement
      if (top === undefined) {
        if (published !== '') {
          root.style.removeProperty('--dsh-atlas-menu-max')
          published = ''
        }
        return
      }
      const value = `${Math.max(160, Math.floor(top - 16))}px`
      if (value === published) return
      published = value
      root.style.setProperty('--dsh-atlas-menu-max', value)
    }
    publish()
    window.addEventListener('resize', publish)
    const unsubscribe = controller.menu.subscribe(publish)
    return () => {
      window.removeEventListener('resize', publish)
      unsubscribe()
      document.documentElement.style.removeProperty('--dsh-atlas-menu-max')
    }
  }, [controller])

  // Replace the current @token with `@${prefix}` and keep the menu open by
  // re-tracking (the pipeline's pick path closes the menu and never reopens it).
  // No DOM access at all: the draft is the slot's own state and the caret is a
  // number, so this works whatever element the composer renders.
  const applyCompletion = (prefix: string): void => {
    const menu = controller.menu.getSnapshot()
    const hit = menu.hit
    if (hit === null) return
    const token = `@${prefix}`
    const draft = input.draft.slice(0, hit.span.start) + token + input.draft.slice(hit.span.end)
    pending.current = {
      draft,
      caret: hit.span.start + token.length,
      tier: input.phase === 'claimed' ? 'claimed' : 'plain',
    }
    inputActions.setDraft(draft)
  }

  // Collapse toggles apply INSTANTLY: the cached rows are rebuilt synchronously
  // and written into the open menu store (no refetch, no blank gap). Only when
  // the needed cache is not settled yet do we fall back to dismiss + track to
  // force a refresh (track() early-returns on an unchanged hit).
  const toggleAndRefresh = (menu: MenuState, index: number): void => {
    const group = groupItemAt(menu, index)
    if (group === undefined || menu.hit === null) return
    toggleGroup(group.key)
    const rows = rebuildRows(sessionId, menu.hit.query)
    if (rows !== undefined && menu.open) {
      controller.menu.update(draft => {
        // Immer drafts are mutable even though the published type is readonly.
        const groupState = draft.groups.find(candidate => candidate.source === SOURCE_NAME)
        if (groupState !== undefined) {
          (groupState.items as InputTriggerCandidate[]) = [...rows]
        }
        if (draft.highlight !== null && draft.highlight.source === SOURCE_NAME && draft.highlight.index >= rows.length) {
          (draft.highlight as { index: number }).index = Math.max(0, rows.length - 1)
        }
      })
      return
    }
    controller.dismiss()
    const tier = input.phase === 'claimed' ? 'claimed' : 'plain'
    controller.track(input.draft, menu.hit.span.end, { tier }, input.draftRev)
  }

  useLayoutEffect(() => {
    const completion = pending.current
    if (completion === null) return
    pending.current = null
    controller.track(input.draft, completion.caret, { tier: completion.tier }, input.draftRev)
  }, [controller, input.draft, input.draftRev])

  // Keyboard group folding — the one Enter gesture the framework does not own.
  // It reads the live MENU state and never the input element, so it runs on the
  // Lexical contenteditable the composer actually is. Every other Enter (settle
  // the highlighted row) is left to the framework's own keymap.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPlainEnter(event)) return
      const menu = controller.menu.getSnapshot()
      const group = highlightedGroup(menu)
      if (group === undefined) return
      event.preventDefault()
      event.stopPropagation()
      toggleAndRefresh(menu, group.index)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [controller, input, toggleGroup])

  // PageUp/PageDown: one page of rows per press (the user asked for it, because a
  // list longer than the visible area is now allowed to scroll instead of being
  // truncated). The framework owns ↑/↓ (one row), so a page is expressed the same
  // way — move the HIGHLIGHT by a page and let the framework keep it in view — and
  // only a menu whose highlight is not ours (another source's row, or none yet) is
  // scrolled directly, so a second `@` source keeps its own highlight.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const direction = event.key === 'PageDown' ? 1 : event.key === 'PageUp' ? -1 : 0
      if (direction === 0) return
      const menu = controller.menu.getSnapshot()
      if (!menu.open) return
      const box = document.querySelector('[role="listbox"]')
      const groupState = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
      const rows = groupState?.items.length ?? 0
      const current = menu.highlight
      event.preventDefault()
      event.stopPropagation()
      if (current !== null && current.source === SOURCE_NAME && rows > 0) {
        const next = Math.min(rows - 1, Math.max(0, current.index + direction * pageStep(box)))
        if (next === current.index) return
        controller.menu.update(draft => {
          // Re-check inside the update: the highlight may have moved since the
          // snapshot (a hover, a pick, a re-settle) and another source's is not ours.
          if (draft.highlight === null || draft.highlight.source !== SOURCE_NAME) return
          (draft.highlight as { index: number }).index = next
        })
        return
      }
      if (box instanceof HTMLElement) {
        const page = box.clientHeight > 0 ? box.clientHeight : PAGE_ROWS * 32
        box.scrollTop += direction * page
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [controller])

  // Smart default highlight: when a NEW query's rows become READY, move the
  // highlight to the row that query asks for — the named category's row when
  // the query is a category shortcut, else the first result leaf (categories
  // stay on top, Enter picks the best match). The guard tracks the query so the
  // pending 'hit' notification (groups not ready yet) cannot consume the snap,
  // and manual navigation on an unchanged query is never overridden.
  const queryRef = useRef<string | null>(null)
  const snappedRef = useRef(false)
  useEffect(() => {
    const off = controller.menu.subscribe(() => {
      const menu = controller.menu.getSnapshot()
      if (!menu.open || menu.hit === null || menu.hit.trigger !== '@') return
      // A bare `@` is the category menu, and the highlight must be OURS there:
      // the framework highlights the first row of the whole menu — the stock
      // `dsh-client-ui-reference` group, which sits ABOVE this plugin's bottom
      // band — and then scrolls to it, so the categories flash into view and are
      // pushed out again. Every other query leaves another source's highlight
      // strictly alone.
      const empty = menu.hit.query.trim() === ''
      const group = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
      const ready = group?.status === 'ready'
      if (menu.hit.query !== queryRef.current) {
        queryRef.current = menu.hit.query
        snappedRef.current = false
      }
      if (!ready || snappedRef.current) return
      snappedRef.current = true
      const target = defaultHighlightIndex(menu)
      if (target < 0) return
      // A category-shortcut query claims OUR rows outright — the user named the
      // category, so it outranks whatever leaf the rows would default to. A
      // plain query only takes the highlight off one of our header rows, so a
      // highlight the user moved by hand stays where it is. Neither ever takes
      // another registered '@' source's highlight.
      const completion = completionTarget(menu.hit.query) !== undefined
      const current = menu.highlight
      if (current !== null && current.source !== SOURCE_NAME && !empty) return
      if (current !== null && current.index === target && current.source === SOURCE_NAME) return
      const currentKind = current === null || current.source !== SOURCE_NAME
        ? undefined
        : (group?.items[current.index] as { mentionKind?: string } | undefined)
      if (!empty && !completion && current !== null && !isHeaderRow(currentKind)) return
      controller.menu.update(draft => {
        const groupState = draft.groups.find(candidate => candidate.source === SOURCE_NAME)
        // Re-check inside the update: the highlight may have moved since the
        // snapshot (another source's pick, a hover) and stays untouched then.
        if (draft.highlight !== null && draft.highlight.source !== SOURCE_NAME && !empty) return
        const currentState = draft.highlight === null || draft.highlight.source !== SOURCE_NAME
          ? undefined
          : (groupState?.items[draft.highlight.index] as { mentionKind?: string } | undefined)
        if (empty || completion || draft.highlight === null || isHeaderRow(currentState)) {
          ;(draft.highlight as { source: string; index: number } | null) = { source: SOURCE_NAME, index: target }
        }
      })
    })
    return off
  }, [controller])

  // Keep the bottom BAND in view, not just the row the highlight sits on.
  //
  // The framework scrolls the highlighted row into view when the HIGHLIGHT
  // changes, and does it with `block: 'nearest'` — which parks that row against
  // the nearest edge. On a bare `@` the highlight is the first category row, so
  // "nearest" tucks it against the BOTTOM edge and every row below it (the rest
  // of the band) falls out of sight. The stock `dsh-client-ui-reference` source
  // above us makes it worse: its rows arrive asynchronously, which grows the
  // content above and slides the band further down.
  //
  // So while the band IS the content (no result rows in our group — a bare `@`
  // or a single shortcut letter), this pass anchors the band's LAST row to the
  // bottom edge: the whole band ends up visible, the highlight stays where the
  // navigator put it. Once there ARE results to read, the same pass guarantees the
  // FOCUS is visible instead (`block: 'nearest'`, a no-op while it already is):
  // the framework only follows the highlight when it CHANGES, so rows that arrive
  // late — this plugin's scoped folder listing, or a fold rebuild — could otherwise
  // leave the highlighted row, and the priority rows above it, outside a menu too
  // short for the whole budget.
  //
  // Re-anchored when the CONTENT changes — the query, or any group's row count,
  // which is what moves the list when the stock source's rows arrive late — and
  // deliberately NOT on a bare highlight change: hovering a row must not yank a
  // list the user has scrolled back to where the plugin wants it.
  //
  // One scroll is not enough. The framework's own scroll lives in a PASSIVE
  // effect and only follows the highlight, so when a row-count change and a
  // highlight change land in the same update its scroll can run a frame after
  // ours and undo it (observed live: the band ends up scrolled out again, with
  // only its first row at the bottom edge). So a content change starts a short
  // HOLD during which the anchor is re-applied on every frame; a deliberate user
  // scroll happens after that window, and a hover never starts one.
  const anchoredRef = useRef('')
  useEffect(() => {
    let frame = 0
    let hold = 0
    const apply = (force: boolean): void => {
      const menu = controller.menu.getSnapshot()
      if (!menu.open) {
        anchoredRef.current = ''
        hold = 0
        return
      }
      const group = menu.groups.find(candidate => candidate.source === SOURCE_NAME)
      if (group?.status !== 'ready' || group.items.length === 0) return
      const signature = `${menu.hit?.query ?? ''}|${menu.groups.map(candidate => candidate.items.length).join(',')}`
      const changed = signature !== anchoredRef.current
      if (!changed && !force) return
      anchoredRef.current = signature
      if (changed) hold = HOLD_FRAMES
      const rowId = (index: number): string => `dsh-slash-option-${SOURCE_NAME}-${index}`
      const leaves = firstLeafIndex(menu)
      if (leaves < 0) {
        document.getElementById(rowId(group.items.length - 1))?.scrollIntoView({ block: 'end' })
        return
      }
      // Results exist. The framework scrolls the HIGHLIGHTED row into view when the
      // highlight CHANGES, but a content change can leave it — and the priority rows
      // above it — outside a menu that is too short for the whole budget (the user's
      //口径: beyond what fits there is a scrollbar, yet the focus/priority must stay
      // visible). Our own async rows land that way: the scope's listing arrives a
      // moment after the workspace matches, and the fold rebuild rewrites the list in
      // place. `block: 'nearest'` is a NO-OP when the row is already visible, so this
      // never moves a list the user is reading; the focus is the first result leaf for
      // every ordinary query, which is also the topmost priority row.
      const focus = menu.highlight !== null && menu.highlight.source === SOURCE_NAME ? menu.highlight.index : leaves
      document.getElementById(rowId(focus))?.scrollIntoView({ block: 'nearest' })
    }
    const anchor = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const holding = hold > 0
        if (holding) hold -= 1
        apply(holding)
        if (hold > 0) anchor()
      })
    }
    const off = controller.menu.subscribe(anchor)
    anchor()
    return () => {
      off()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [controller])

  // Mouse: a mousedown on a group header toggles collapse instead of picking
  // (the MenuView row id is `dsh-slash-option-<source>-<index>`).
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      const target = event.target as Element | null
      const row = target?.closest?.('[id^="dsh-slash-option-atlas-"]')
      if (!(row instanceof HTMLElement)) return
      const suffix = row.id.slice('dsh-slash-option-atlas-'.length)
      const index = Number.parseInt(suffix, 10)
      if (!Number.isInteger(index)) return
      const menu = controller.menu.getSnapshot()
      const category = categoryRowAt(menu, index)
      if (category !== undefined) {
        event.preventDefault()
        event.stopPropagation()
        applyCompletion(category.prefix)
        return
      }
      if (backRowAt(menu, index)) {
        event.preventDefault()
        event.stopPropagation()
        applyCompletion('')
        return
      }
      const group = groupAt(menu, index)
      if (group === undefined) return
      event.preventDefault()
      event.stopPropagation()
      toggleAndRefresh(menu, index)
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => { document.removeEventListener('mousedown', onMouseDown, true) }
  }, [controller, input, toggleGroup, applyCompletion])

  return null
}