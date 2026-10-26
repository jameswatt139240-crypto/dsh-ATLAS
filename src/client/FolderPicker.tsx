/**
 * The folder chooser dialog: a modal picker over the product's own browse
 * backend.
 *
 * Why not the product's dialog itself: `BrowseDirectoryFlow` is not a service, it
 * is a component filling the workspace picker's PRIVATE child slots
 * (`conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`),
 * and rendering a slot belongs to the entry that declared it — a plugin can
 * neither declare the same hole nor render someone else's. And
 * `directoryPicker/pick` is the NATIVE chooser, which a profile serving the
 * in-app browse capability refuses (`directory-picker/unavailable`).
 *
 * What CAN be borrowed is the backend both of those use: this plugin's own
 * `atFile.browse` / `atFile.list` / `atFile.create` (see the wire face below).
 *
 * The list is ONE tree in TWO groups:
 *
 *     常用区外文件夹        (collapsed until asked for)
 *       ├ Projects          → a jump outside the workspace
 *       └ …
 *     当前文件夹            (open, and where the browsing happens)
 *       ├ ⬆ 上一级
 *       ├ Eason             → Enter expands it in place, Ctrl+Enter adopts it
 *       └ …
 *
 * The path line and the list are two views of the SAME location and may not
 * diverge: typing a path (or pressing Enter on it) re-roots the tree, and every
 * way of moving — a crumb, a drive, the way up, a preset, an expanded folder —
 * updates both.
 *
 * `Enter` and `Ctrl+Enter` are different verbs everywhere in this dialog, and
 * the difference does not depend on which row happens to be current:
 *
 *     Enter        expand what can be expanded (a group, a folder with children);
 *                  adopt what cannot (a folder without children)
 *     Ctrl+Enter   adopt the current row — write the reference and close
 *
 * The cursor is tracked by ROW KEY rather than by index, so expanding a folder
 * (which inserts rows) or filtering (which removes them) leaves it exactly where
 * it was: the only thing that moves the current row is an arrow key.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { mentionIcon } from './icons.tsx'

/** One row of a browse level, as the product's picker backend reports it. */
export interface PickerEntry {
  readonly name: string
  readonly path: string
  readonly hidden: boolean
  /**
   * Whether this folder holds at least one child folder. Absent when the Host did
   * not say (an older Host, or a probe that ran out of budget): the row then
   * offers expansion and finds out on the way in.
   */
  readonly hasChildren?: boolean
}

/** One offered folder the chooser can jump to without browsing (see the Host's `recentFolders`). */
export interface PickerPreset {
  readonly path: string
  readonly name: string
  readonly reason: 'sibling' | 'parent' | 'child' | 'recent' | 'family'
}

/** One browse level: the folder itself, its ancestry, and its child folders. */
export interface PickerListing {
  readonly path: string
  readonly home: string
  readonly crumbs: readonly PickerEntry[]
  readonly entries: readonly PickerEntry[]
  readonly truncated: boolean
  /** The drive roots, present exactly while the listing IS a drive root. */
  readonly drives?: readonly string[]
  /** The folder above, absent at a drive root (where `drives` takes its place). */
  readonly parent?: string
  /** Why this level could not be listed, when it could not. */
  readonly error?: 'outside' | 'missing' | 'notDirectory'
  /**
   * What the user actually typed, present only while it is DEEPER than `path`:
   * `path` is the longest valid prefix of it that could be listed, and the rest is
   * the needle the two groups filter by.
   */
  readonly requested?: string
}

/** The open/closed share between the source's picker row and this dialog. */
export interface FolderPickerSnapshot {
  /** Set while the dialog is open; the token the pick will replace travels with it. */
  readonly value: unknown | null
}

/** Read-only observable face the dialog subscribes to. */
export interface FolderPickerSource {
  getSnapshot(): FolderPickerSnapshot
  subscribe(listener: () => void): () => void
}

/** What the session's shell shares with the dialog. */
export interface FolderPickerInjected {
  /** One directory level for a path being typed: the longest valid prefix plus its child folders. */
  readonly browse: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>
  /** One directory level; `''` means the session workspace root, undefined means the drive root holding it. */
  readonly list: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>
  /** Create one child folder and answer its absolute path. */
  readonly create: (path: string, name: string) => Promise<string>
  /** The folders worth offering before any browsing (ranked; possibly empty). */
  readonly recent: (signal: AbortSignal) => Promise<readonly PickerPreset[]>
  /** Adopt the folder the path line shows (inserts the reference and closes). */
  readonly confirm: (path: string) => void
  /** Dismiss without adopting anything. */
  readonly close: () => void
  readonly hooks: { readonly folderPicker: FolderPickerSource }
}

/** The dialog's props: the overlay seat, this plugin's copy, and the shell's face. */
export type FolderPickerProps = PropsRuntime<'conversation.input.overlay'> & PropsLocale<'atlas'> & InjectFace<FolderPickerInjected>

/** Which of the two regions holds the keyboard. */
type PickerZone = 'path' | 'list'

/** The two top-level groups, in the order they are rendered. */
type PickerGroup = 'presets' | 'current'

/** What activating a row does. */
type PickerAction =
  /** Adopt this folder: write the reference and close. */
  | { readonly kind: 'choose'; readonly path: string }
  /** Expand or collapse one of the two groups. The cursor does not move. */
  | { readonly kind: 'toggle'; readonly group: PickerGroup }
  /** Expand this folder in place, or collapse it again. */
  | { readonly kind: 'expand'; readonly path: string }
  /** Ask the Host whether this folder has children, then expand it or adopt it. */
  | { readonly kind: 'probe'; readonly path: string }
  /** Make this folder the level being listed. */
  | { readonly kind: 'root'; readonly path: string }

/** One rendered row: a group header, a folder, or the way up. */
interface PickerRow {
  /** Stable identity the highlight follows. Never an index: rows are inserted and removed under it. */
  readonly key: string
  readonly kind: 'group' | 'preset' | 'up' | 'drive' | 'folder' | 'note'
  readonly label: string
  readonly hint: string
  /** Nesting depth: 0 for a group header, 1 for its rows, deeper inside an expanded folder. */
  readonly level: number
  /** Whether the arrow keys may land here. Notes are read-only, so they never hold the cursor. */
  readonly focusable: boolean
  readonly preset: boolean
  readonly expandable: boolean
  readonly expanded: boolean
  /** The folder `Ctrl+Enter` adopts while this row is current. */
  readonly target?: string
  readonly action?: PickerAction
}

/** The preset group's row key: not a path, so it can never collide with one. */
const PRESETS_KEY = '\u0000presets'
/** The current group's row key. */
const CURRENT_KEY = '\u0000current'
/** How long the path line waits after the last keystroke before it browses. */
const PICKER_DEBOUNCE_MS = 200

/**
 * Render the folder chooser while one is requested.
 * @param props - the open state, the browse backend, and the adoption callbacks.
 * @returns the modal, or null while closed.
 */
export function FolderPicker({ useFolderPicker, browse, list, create, recent, confirm, close, t }: FolderPickerProps): ReactNode {
  const open = useFolderPicker(snapshot => snapshot.value !== null)
  /**
   * The location the user has ASKED for, which is what the fetch runs on. It is
   * deliberately separate from `listing.path` (the longest valid prefix that could
   * be listed): between the last keystroke and the answer, everything the user
   * does refers to what they typed, and adopting the listing instead writes a
   * path the user never chose.
   */
  const [asked, setAsked] = useState('')
  const [draft, setDraft] = useState('')
  const [listing, setListing] = useState<PickerListing | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [zone, setZone] = useState<PickerZone>('path')
  /** The current row, by key. See the header: row identity, not position. */
  const [hotKey, setHotKey] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [presets, setPresets] = useState<readonly PickerPreset[]>([])
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [currentOpen, setCurrentOpen] = useState(true)
  /** The paths whose children are spliced into the tree, in insertion order. */
  const [expanded, setExpanded] = useState<readonly string[]>([])
  /** The children of an expanded folder, by path (fetched once, kept for the visit). */
  const [extra, setExtra] = useState<Record<string, PickerListing>>({})
  // The injected face is re-created whenever the shell re-injects, so it must not be
  // a dependency of the fetch effects: that would restart every in-flight request.
  const faces = useRef({ browse, list, create, recent })
  faces.current = { browse, list, create, recent }
  const extraRef = useRef(extra)
  extraRef.current = extra
  /** Children requests in flight, so a second Enter does not ask twice. */
  const loading = useRef(new Set<string>())
  /** Children requests to abort when the dialog closes. */
  const children = useRef<AbortController[]>([])
  const dialogRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /**
   * Set the moment a pick hands the keyboard back to the composer. While it is set
   * the focus guard below stands down: reclaiming the focus right after a pick would
   * fight `adoptPath`, which is the one place focus is MEANT to leave.
   */
  const released = useRef(false)
  // Opening resets the whole visit: the previous level, expansion, filtering and
  // the cursor all belong to the dialog that just closed.
  useEffect(() => {
    if (!open) return
    released.current = false
    setAsked('')
    setDraft('')
    setListing(undefined)
    setFailure(undefined)
    setCreating(false)
    setFolderName('')
    setZone('path')
    setHotKey(undefined)
    setFilter('')
    setExpanded([])
    setExtra({})
    setPresetsOpen(false)
    setCurrentOpen(true)
  }, [open])
  // Incremental typing browses the longest valid prefix it has: waiting for a
  // pause keeps a six-character path from firing six walks, and the answer is
  // keyed on `asked` so a late one cannot overwrite a newer level.
  useEffect(() => {
    if (!open || draft === asked) return
    const timer = setTimeout(() => { setAsked(draft) }, PICKER_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [open, draft, asked])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setFailure(undefined)
    void faces.current.browse(asked === '' ? undefined : asked, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setListing(next) },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { controller.abort() }
  }, [open, asked])
  // The presets are fetched once per open, not per level: they describe the
  // session, not the directory being looked at.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void faces.current.recent(controller.signal).then(
      (next) => { if (!controller.signal.aborted) setPresets(next) },
      () => { if (!controller.signal.aborted) setPresets([]) },
    )
    return () => { controller.abort() }
  }, [open])
  // In-flight child listings die with the dialog; a resolved one would land in a
  // tree that no longer exists.
  useEffect(() => {
    if (!open) return
    const pending = children.current
    return () => {
      for (const controller of pending) controller.abort()
      pending.length = 0
    }
  }, [open])
  // Opening focuses the path line with the whole location selected: the fastest
  // path to an out-of-workspace folder is typing (or pasting) it, and that only
  // works if the old location gets out of the way.
  useEffect(() => {
    if (!open || zone !== 'path') return
    const input = inputRef.current
    if (input === null) return
    input.focus()
    // `select()` on a just-mounted input is a no-op in some engines; the explicit
    // range is what actually selects, and it keeps the caret usable.
    input.select()
  }, [open, zone])
  // The dialog is `aria-modal`: while it is up, the keyboard belongs to it. Asking
  // once when we mount is not enough — the dialog is opened by a click on the
  // mention row, and the shell re-focuses the composer around that same click, so
  // the two race. Measured on the real device over two runs of the same E2E: in one
  // the first ArrowDown arrived with the path line focused, in the next EVERY
  // keydown arrived on the composer's contenteditable and was left unhandled — the
  // dialog was on screen and keyboard-deaf, and Enter on a row did nothing. The
  // focus has to be taken back when it leaves, not merely requested once.
  useEffect(() => {
    if (!open) return
    const claim = (): void => {
      if (released.current) return
      const dialog = dialogRef.current
      if (dialog === null) return
      const active = document.activeElement
      if (active !== null && dialog.contains(active)) return
      if (zone === 'path') inputRef.current?.focus()
      else listRef.current?.focus()
    }
    // `focusin` catches another element taking the focus; `focusout` catches the
    // focus being dropped on `body` (also observed), which no `focusin` follows.
    const onFocusOut = (): void => { queueMicrotask(claim) }
    document.addEventListener('focusin', claim)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', claim)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [open, zone])
  const setGroupOpen = useCallback((group: PickerGroup, update: (current: boolean) => boolean): void => {
    if (group === 'presets') setPresetsOpen(update)
    else setCurrentOpen(update)
  }, [])
  const jumpTo = useCallback((next: string): void => {
    setCreating(false)
    setFilter('')
    setExpanded([])
    setExtra({})
    setDraft(next)
    // Setting the asked level fetches immediately, without the debounce: a crumb,
    // a drive or the way up is a deliberate destination, not a keystroke.
    setAsked(next)
  }, [])
  // The one place a location is adopted. Focus goes back to the composer
  // explicitly: the dialog unmounts on the next commit, so a focused button would
  // leave the caret on `body` and the user would have to click before typing
  // again — the last metre of a keyboard flow, and the easy one to lose.
  //
  // Two attempts, because the dialog's unmount is the shell's business and the
  // timing is not ours: the microtask runs after the commit that closes us, and the
  // frame after that is the backstop for a shell that closes us later still. The
  // second is a no-op once the first has already moved focus.
  const adoptPath = useCallback((target: string | undefined): void => {
    if (target === undefined || target === '') return
    released.current = true
    confirm(target)
    const toComposer = (): void => {
      const composer = document.querySelector('[data-composer-input]')
      if (composer instanceof HTMLElement) composer.focus()
    }
    queueMicrotask(toComposer)
    requestAnimationFrame(toComposer)
  }, [confirm])
  const loadChildren = useCallback((path: string): void => {
    const controller = new AbortController()
    children.current.push(controller)
    loading.current.add(path)
    void faces.current.list(path, controller.signal).then(
      (next) => {
        loading.current.delete(path)
        if (controller.signal.aborted) return
        setExtra(current => ({ ...current, [path]: next }))
      },
      (error: unknown) => {
        loading.current.delete(path)
        if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error))
      },
    )
  }, [])
  const expandFolder = useCallback((path: string): void => {
    setExpanded(current => (current.includes(path) ? current : [...current, path]))
    if (extraRef.current[path] === undefined && !loading.current.has(path)) loadChildren(path)
  }, [loadChildren])
  const collapseFolder = useCallback((path: string): void => {
    setExpanded(current => current.filter(entry => entry !== path))
  }, [])
  // A row whose `hasChildren` the Host did not answer with: look before deciding.
  // This is the only place an Enter needs I/O, and it only happens on a listing
  // whose probe budget ran out — the answer then decides which verb Enter was.
  const probeFolder = useCallback((path: string): void => {
    const controller = new AbortController()
    children.current.push(controller)
    void faces.current.list(path, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return
        const kids = next.entries.filter(entry => showHidden || !entry.hidden)
        if (kids.length === 0) { adoptPath(path); return }
        setExtra(current => ({ ...current, [path]: next }))
        setExpanded(current => (current.includes(path) ? current : [...current, path]))
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error))
      },
    )
  }, [adoptPath, showHidden])
  const activate = useCallback((row: PickerRow | undefined): void => {
    const action = row?.action
    if (action === undefined) return
    if (action.kind === 'choose') { adoptPath(action.path); return }
    if (action.kind === 'toggle') { setGroupOpen(action.group, current => !current); return }
    if (action.kind === 'expand') {
      if (expanded.includes(action.path)) collapseFolder(action.path)
      else expandFolder(action.path)
      return
    }
    if (action.kind === 'probe') { probeFolder(action.path); return }
    jumpTo(action.path)
  }, [adoptPath, collapseFolder, expandFolder, expanded, jumpTo, probeFolder, setGroupOpen])
  // The needle is what the user typed BEYOND the level that could be listed. It is
  // derived from the Host's answer rather than re-parsed here, so the two cannot
  // disagree about which prefix was valid.
  const needle = listing?.requested === undefined ? '' : listing.requested.slice(listing.path.length).replace(/^\/+/, '')
  const filtering = needle !== '' || filter.trim() !== ''
  const shownPath = draft === '' ? (listing?.path ?? '') : draft
  const rows = useMemo<readonly PickerRow[]>(() => {
    // Both fields filter at once, stacked, so the needle from the path line and the
    // characters typed in the list narrow the same tree rather than one replacing
    // the other.
    const needles = [needle, filter].map(value => value.trim().toLowerCase()).filter(value => value !== '')
    const matchesName = (name: string): boolean => needles.every(value => name.toLowerCase().includes(value))
    const matchesEither = (name: string, path: string): boolean => needles.every(value =>
      name.toLowerCase().includes(value) || path.toLowerCase().includes(value))
    const out: PickerRow[] = []
    const note = (key: string, label: string): void => {
      out.push({ key, kind: 'note', label, hint: '', level: 1, focusable: false, preset: false, expandable: false, expanded: false })
    }
    const presetRow = (preset: PickerPreset): void => {
      out.push({
        key: `preset:${preset.path}`,
        kind: 'preset',
        label: preset.name,
        hint: preset.path,
        level: 1,
        focusable: true,
        preset: true,
        expandable: false,
        expanded: false,
        target: preset.path,
        action: { kind: 'choose', path: preset.path },
      })
    }
    // One level of the tree, and — when a folder in it is expanded — the levels
    // below it, in place. A filter SHRINKS this offer rather than replacing it: the
    // folders that match stay where they are, indentation and all.
    const pushLevel = (levelListing: PickerListing, level: number, root: boolean): void => {
      // The way up and the drives are ways to CHANGE the level, so a needle that
      // describes a folder below this one has nothing to say about them.
      if (root && !filtering) {
        if (levelListing.parent !== undefined) {
          out.push({
            key: '\u0000up',
            kind: 'up',
            label: t('picker.up'),
            hint: levelListing.parent,
            level,
            focusable: true,
            preset: false,
            expandable: false,
            expanded: false,
            target: levelListing.parent,
            action: { kind: 'root', path: levelListing.parent },
          })
        }
        for (const drive of levelListing.drives ?? []) {
          out.push({
            key: `drive:${drive}`,
            kind: 'drive',
            label: drive,
            hint: drive,
            level,
            focusable: true,
            preset: false,
            expandable: false,
            expanded: false,
            target: drive,
            action: { kind: 'root', path: drive },
          })
        }
      }
      const entries = levelListing.entries.filter(entry => (showHidden || !entry.hidden) && matchesName(entry.name))
      for (const entry of entries) {
        const isOpen = expanded.includes(entry.path)
        out.push({
          key: entry.path,
          kind: 'folder',
          label: entry.name,
          hint: entry.path,
          level,
          focusable: true,
          preset: false,
          // An OPEN row is always the collapse verb, whatever `hasChildren` said: the
          // Host may answer `undefined` for a folder it did not probe, and that row
          // used to re-ask instead — Enter on an expanded folder could only ever
          // expand it again (m05904). A closed row: a known-empty folder is a leaf and
          // Enter adopts it, anything else offers expansion, and an unanswered
          // `hasChildren` is settled on the way in.
          expandable: entry.hasChildren !== false,
          expanded: isOpen,
          target: entry.path,
          action: isOpen
            ? { kind: 'expand', path: entry.path }
            : entry.hasChildren === false
              ? { kind: 'choose', path: entry.path }
              : entry.hasChildren === true
                ? { kind: 'expand', path: entry.path }
                : { kind: 'probe', path: entry.path },
        })
        if (!isOpen) continue
        const below = extra[entry.path]
        if (below !== undefined) pushLevel(below, level + 1, false)
      }
    }
    // 常用区外文件夹: collapsed until the user asks for it, and forced open while a
    // needle is being typed — a filtered offer the user cannot see is not an offer.
    const presetsShown = presetsOpen || filtering
    out.push({
      key: PRESETS_KEY,
      kind: 'group',
      label: t('picker.group.presets'),
      hint: '',
      level: 0,
      focusable: true,
      preset: false,
      expandable: true,
      expanded: presetsShown,
      action: { kind: 'toggle', group: 'presets' },
    })
    if (presetsShown) {
      const matched = presets.filter(preset => !filtering || matchesEither(preset.name, preset.path))
      for (const preset of matched) presetRow(preset)
      if (matched.length === 0) note('note:presets', filtering ? t('picker.noMatch') : t('picker.group.none'))
    }
    // 当前文件夹: the level the path line names, expanded, with the browsing under it.
    out.push({
      key: CURRENT_KEY,
      kind: 'group',
      label: t('picker.group.current'),
      hint: listing?.path ?? '',
      level: 0,
      focusable: true,
      preset: false,
      expandable: true,
      expanded: currentOpen,
      action: { kind: 'toggle', group: 'current' },
    })
    if (currentOpen) {
      if (listing === undefined) {
        if (failure === undefined) note('note:level', t('picker.loading'))
      } else {
        const before = out.length
        pushLevel(listing, 1, true)
        if (out.length === before) note('note:level', filtering ? t('picker.noMatch') : t('picker.empty'))
      }
    }
    return out
  }, [expanded, extra, failure, filter, filtering, listing, needle, presets, presetsOpen, currentOpen, showHidden, t])
  const hotRow = rows.find(entry => entry.key === hotKey)
  // A cursor tracked by KEY still has to be told when its row is gone (a filter
  // removed it, the group holding it collapsed): it then starts over on the first
  // row the arrows can reach. That is a repair, not a move — nothing else here
  // writes `hotKey`.
  useEffect(() => {
    if (!open) return
    const focusable = rows.filter(entry => entry.focusable)
    const first = focusable[0]
    if (first === undefined) return
    if (hotKey !== undefined && focusable.some(entry => entry.key === hotKey)) return
    setHotKey(first.key)
  }, [hotKey, open, rows])
  // Turning the page. The list scrolls, so the current row can travel out of sight;
  // the requirement is that stepping past the last visible row scrolls to the next
  // page with the cursor on that page's FIRST row (and symmetrically upwards), not
  // that the list be tall enough to hold every folder.
  useEffect(() => {
    const container = listRef.current
    if (container === null || hotKey === undefined) return
    const box = container.getBoundingClientRect()
    // Nothing is laid out under jsdom, and there is no page to turn there either.
    if (box.height === 0) return
    let target: HTMLElement | undefined
    for (const child of Array.from(container.children)) {
      if (child instanceof HTMLElement && child.dataset.key === hotKey) { target = child; break }
    }
    if (target === undefined) return
    // Scrolled through the container's own `scrollTop` rather than through
    // `scrollIntoView` on the row: that one scrolls EVERY scrollable ancestor, so
    // turning the page could carry the whole shell along and slide content that has
    // nothing to do with this list — the pointer included — out from under the user.
    // A step lands the cursor on the SECOND row of the page it turns to, one row
    // short of a plain page: the row that was last on the page just left (first on
    // the page just entered when going up) stays visible at the leading edge, so the
    // user can see the two pages meet instead of wondering whether the cursor
    // continues from where it was (m05904).
    const row = target.getBoundingClientRect()
    if (row.top < box.top) container.scrollTop += row.bottom - box.bottom + row.height
    else if (row.bottom > box.bottom) container.scrollTop += row.top - box.top - row.height
  }, [hotKey, rows])
  const moveTo = useCallback((where: 'first' | 'last'): void => {
    const focusable = rows.filter(entry => entry.focusable)
    const target = where === 'first' ? focusable[0] : focusable[focusable.length - 1]
    if (target !== undefined) setHotKey(target.key)
  }, [rows])
  const moveBy = useCallback((step: number): void => {
    const focusable = rows.filter(entry => entry.focusable)
    if (focusable.length === 0) return
    const at = focusable.findIndex(entry => entry.key === hotKey)
    // Clamped at both ends, never wrapped: a cursor that jumped from the last row
    // back to the first would make "step to the next page" impossible to observe.
    const from = at === -1 ? (step > 0 ? -1 : focusable.length) : at
    const next = focusable[Math.min(focusable.length - 1, Math.max(0, from + step))]
    if (next !== undefined) setHotKey(next.key)
  }, [hotKey, rows])
  // Pointing at a row makes it current. A row can also arrive under a STATIONARY
  // pointer: the page turns, the list scrolls, and the browser reports the row that
  // slid there as a `mouseover` of its own. Taken for a hover it would write the
  // cursor, so walking to the bottom would keep handing the current row to whatever
  // happened to land under the mouse and the walk would never get past the page —
  // and the requirement is that nothing but an arrow (or a genuine pointer move)
  // ever moves the cursor. The two are told apart by their coordinates: a real move
  // brings new ones, a scroll-induced re-target repeats the last position exactly.
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined)
  const hoverRow = useCallback((event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>, key: string): void => {
    const x = event.clientX
    const y = event.clientY
    const last = pointer.current
    pointer.current = { x, y }
    if (last !== undefined && last.x === x && last.y === y) return
    setZone('list')
    setHotKey(key)
  }, [])
  const focusList = useCallback((where: 'first' | 'last'): void => {
    moveTo(where)
    listRef.current?.focus()
    setZone('list')
  }, [moveTo])
  // Enter in the path line converges it on the longest valid prefix it has, which
  // is the level already on screen — typing a partial name and pressing Enter
  // accepts the folder you are inside instead of reporting an error.
  const snap = useCallback((): void => {
    if (listing === undefined) { setAsked(draft); return }
    jumpTo(listing.path)
  }, [draft, jumpTo, listing])
  // Ctrl+Enter: adopt what the current row NAMES, so a preset or the way up lands
  // its own folder rather than the level it happens to be shown in.
  const pick = useCallback((): void => {
    adoptPath(hotRow?.target ?? listing?.path)
  }, [adoptPath, hotRow, listing])
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>): void => {
    // The IME owns keys while it is composing: a Chinese user pressing Enter to
    // accept a candidate must not also adopt the folder.
    if (event.nativeEvent.isComposing) return
    const { key } = event
    if (key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      // Three levels, so a wrong step costs one Escape rather than the whole
      // dialog: cancelling the new-folder form, then the list's filter, then the
      // dialog. Expansion is deliberately NOT a level — it is undone by the same
      // Enter that opened it, without the cursor moving.
      if (creating) { setCreating(false); return }
      if (filter !== '') { setFilter(''); return }
      close()
      return
    }
    if (key === 'Tab') {
      // Focus trap: the dialog is `aria-modal`, so Tab must cycle inside it.
      const dialog = dialogRef.current
      if (dialog === null) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return
      event.preventDefault()
      const active = document.activeElement
      const index = focusable.findIndex(element => element === active)
      const step = event.shiftKey ? -1 : 1
      const next = focusable[(index + step + focusable.length) % focusable.length]
      next?.focus()
      return
    }
    // `Ctrl+Enter` adopts from ANYWHERE, and it is checked before the zone split:
    // it is the one gesture whose meaning never depends on which region has focus.
    if ((key === 'Enter' || key === ' ') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      pick()
      return
    }
    if (zone === 'path') {
      if (key === 'Enter') { event.preventDefault(); snap(); return }
      if (key === 'ArrowDown') { event.preventDefault(); focusList('first'); return }
      if (key === 'ArrowUp') { event.preventDefault(); focusList('last'); return }
      return
    }
    if (key === 'ArrowDown') { event.preventDefault(); moveBy(1); return }
    if (key === 'ArrowUp') { event.preventDefault(); moveBy(-1); return }
    if (key === 'Home') { event.preventDefault(); moveTo('first'); return }
    if (key === 'End') { event.preventDefault(); moveTo('last'); return }
    if (key === 'Backspace') {
      event.preventDefault()
      if (filter !== '') { setFilter(current => current.slice(0, -1)); return }
      const parent = listing?.parent
      if (parent !== undefined) jumpTo(parent)
      return
    }
    if (key === 'Enter' || key === ' ') { event.preventDefault(); activate(hotRow); return }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing in the list filters it (no I/O: the level is already in memory).
      event.preventDefault()
      setFilter(current => current + key)
    }
  }, [activate, close, creating, draft, filter, focusList, hotRow, jumpTo, listing, moveBy, moveTo, pick, snap, zone])
  if (!open) return null
  // The dialog is portaled to <body> instead of being left in the slot the shell
  // hands this plugin. Measured cause: that slot sits inside a stacking context
  // the shell's own sidebar resize handle (`z-index: 8`) outranks, so the handle
  // — a 40px-wide vertical band — took every pointer event over the dialog's
  // western edge and left the top crumbs unclickable, and no z-index could
  // recover them: raising this scrim to 2147483647 changed nothing, while moving
  // the very same node to <body> made the dialog topmost at that same point.
  // Nothing in the dialog depends on where it sits: the outside-click test
  // compares event.target against event.currentTarget, and the Tab trap queries
  // the dialog element itself.
  return createPortal(
    <div
      className="dsh_atlas_pickerScrim"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <section
        className="dsh_atlas_picker"
        role="dialog"
        aria-modal="true"
        aria-label={t('picker.title')}
        data-atlas-folder-picker
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="dsh_atlas_pickerHead">
          <h2 className="dsh_atlas_pickerTitle">{t('picker.title')}</h2>
          <div className="dsh_atlas_pickerPathRow">
            <input
              className="dsh_atlas_pickerInput"
              ref={inputRef}
              value={shownPath}
              aria-label={t('picker.path')}
              placeholder={t('picker.pathPlaceholder')}
              onFocus={() => { setZone('path') }}
              onChange={(event) => {
                // The line is always editable, so there is no ✎ mode to enter first
                // and no way to type into a field that swallows the keystroke. It
                // never writes the listing back: the level that answers is the level
                // the user asked for, and echoing it here would fetch twice per step.
                setZone('path')
                setDraft(event.target.value)
              }}
            />
            <button
              type="button"
              className="dsh_atlas_pickerIconButton"
              title={t('picker.go')}
              aria-label={t('picker.go')}
              onClick={snap}
            >
              ⏎
            </button>
          </div>
          <nav className="dsh_atlas_pickerCrumbs" aria-label={t('picker.crumbs')}>
            {/* A drive LIST, not a drive-root FLAG. The Host answers a POSIX top
                level with `drives: []` — there are no drive letters to offer — and a
                `!== undefined` test turned that into a crumb labelled with Windows
                drive letters whose click only re-walked the level it was already on. */}
            {listing?.drives !== undefined && listing.drives.length > 0 && (
              <button type="button" className="dsh_atlas_pickerCrumb" onClick={() => { jumpTo(listing.path) }}>{t('picker.drives')}</button>
            )}
            {listing !== undefined && listing.home !== '' && listing.drives === undefined && (
              <button type="button" className="dsh_atlas_pickerCrumb" onClick={() => { jumpTo(listing.home) }}>{t('picker.home')}</button>
            )}
            {(listing?.crumbs ?? []).map(crumb => (
              <button key={crumb.path} type="button" className="dsh_atlas_pickerCrumb" title={crumb.path} onClick={() => { jumpTo(crumb.path) }}>
                {crumb.name === '' ? crumb.path : crumb.name}
              </button>
            ))}
          </nav>
        </header>
        {failure !== undefined && <p className="dsh_atlas_pickerNote" role="alert">{failure}</p>}
        {listing?.error !== undefined && <p className="dsh_atlas_pickerNote" role="alert">{t(`picker.refusal.${listing.error}`)}</p>}
        {filtering && <p className="dsh_atlas_pickerNote">{t('picker.filtering')} <b>{needle !== '' ? needle : filter}</b></p>}
        <div
          className="dsh_atlas_pickerList"
          aria-label={t('picker.list')}
          role="tree"
          ref={listRef}
          // Focusable so the list can HOLD the keyboard once the user arrows into it
          // (`-1` would refuse programmatic focus). `onFocus` is what keeps the zone
          // honest when focus arrives some other way, such as Tab.
          tabIndex={0}
          onFocus={() => { setZone('list') }}
        >
          {rows.map((row) => {
            if (row.kind === 'note') return <p key={row.key} className="dsh_atlas_pickerNote">{row.label}</p>
            const classes = ['dsh_atlas_pickerRow']
            if (row.kind === 'group') classes.push('dsh_atlas_pickerGroup')
            if (row.key === hotKey && zone === 'list') classes.push('dsh_atlas_pickerRowHot')
            return (
              <button
                key={row.key}
                type="button"
                data-key={row.key}
                className={classes.join(' ')}
                style={{ paddingLeft: 8 + row.level * 14 }}
                title={row.hint}
                role="treeitem"
                aria-level={row.level + 1}
                aria-selected={row.key === hotKey}
                aria-expanded={row.expandable ? row.expanded : undefined}
                // Pointer events cover mouse, pen and touch; the mouse event is a
                // fallback for environments that do not deliver pointer events.
                onPointerOver={event => { hoverRow(event, row.key) }}
                onMouseOver={event => { hoverRow(event, row.key) }}
                onClick={() => { setZone('list'); setHotKey(row.key); activate(row) }}
              >
                <span className="dsh_atlas_pickerGlyph" aria-hidden>{mentionIcon('folder')}</span>
                <span className="dsh_atlas_pickerName">{row.label}</span>
                {row.preset && <span className="dsh_atlas_pickerTag">{t('picker.preset')}</span>}
                {row.hint !== '' && row.kind !== 'group' && <span className="dsh_atlas_pickerHint">{row.hint}</span>}
                {/* Rendered only where it means something: an empty span is still a
                    flex item, and its share of the row's gap would be trailing air. */}
                {row.expandable && <span className="dsh_atlas_pickerChevron" aria-hidden>{row.expanded ? '⌄' : '›'}</span>}
              </button>
            )
          })}
        </div>
        {listing?.truncated === true && <p className="dsh_atlas_pickerNote">{t('picker.truncated')}</p>}
        {creating && (
          <form
            className="dsh_atlas_pickerNewRow"
            onSubmit={(event) => {
              event.preventDefault()
              const name = folderName.trim()
              if (name === '' || listing === undefined) return
              void faces.current.create(listing.path, name).then(
                (created) => { setFolderName(''); setCreating(false); jumpTo(created) },
                (error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) },
              )
            }}
          >
            <input
              className="dsh_atlas_pickerInput"
              value={folderName}
              autoFocus
              placeholder={t('picker.folderName')}
              aria-label={t('picker.folderName')}
              onChange={(event) => { setFolderName(event.target.value) }}
            />
            <button type="submit" className="dsh_atlas_pickerButton">{t('picker.create')}</button>
          </form>
        )}
        <p className="dsh_atlas_pickerKeys">{t('picker.keys')}</p>
        <footer className="dsh_atlas_pickerFoot">
          <button type="button" className="dsh_atlas_pickerButton" onClick={() => { setCreating(true) }}>
            ＋ {t('picker.newFolder')}
          </button>
          <label className="dsh_atlas_pickerToggle">
            <input type="checkbox" checked={showHidden} onChange={(event) => { setShowHidden(event.target.checked) }} />
            {t('picker.showHidden')}
          </label>
          <span className="dsh_atlas_pickerSpacer" />
          <button type="button" className="dsh_atlas_pickerButton" onClick={close}>{t('picker.cancel')}</button>
          <button
            type="button"
            className="dsh_atlas_pickerButton dsh_atlas_pickerPrimary"
            disabled={listing === undefined}
            onClick={() => { adoptPath(listing?.path) }}
          >
            {t('picker.open')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
