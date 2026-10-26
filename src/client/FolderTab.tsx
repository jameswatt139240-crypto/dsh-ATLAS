/**
 * The folder tab: one directory, one level, in the right Sidebar.
 *
 * Why a type of this plugin's own: a `dsh-resource://file/…` address is claimed
 * by the file viewers, and a directory makes them answer `"…" is a directory`;
 * the built-in `files` tab is a page (a tree rooted at the session workspace)
 * that claims no address at all. So a folder click has nowhere to go in the
 * shipped product, and this tab is that destination — for a workspace folder and
 * for an out-of-workspace one alike, because the Host gates the listing with the
 * same rule it uses for a reference.
 *
 * The body walks on its own: a directory row descends in this tab, a file row
 * opens the file's own viewer, and the header carries the way back up plus the
 * OS opener. Nothing here reads a file — `atFile/list` returns names and kinds.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DirectoryListing } from '../contract.ts'
import type { AtFileKey } from './locales.ts'
import { folderPathOf, selectionOf } from './reference-links.ts'
import { childOf } from './model.ts'
import { mentionIcon } from './icons.tsx'

/** This type's identity in the tab registry, and the key its body registers under. */
export const FOLDER_TAB_ID = 'dsh-atlas/folder'

/** The tab kind this plugin owns. */
export const FOLDER_TAB_KIND = 'atlas-folder'

/**
 * The folder tab's registry definition: it claims every address of our own
 * `folder` resource type, so nothing else can be asked to open one.
 * @param t - namespace-bound translate for the chip title.
 * @returns the definition to register.
 */
export function folderTabDefinition(t: (key: AtFileKey, params?: Record<string, string>) => string): SidebarRightTabDefinition {
  return {
    id: FOLDER_TAB_ID,
    kind: FOLDER_TAB_KIND,
    priority: 'builtin',
    patterns: ['dsh-resource://folder/**'],
    title: (address) => {
      const path = folderPathOf(address)
      if (path === undefined) return t('folder.title')
      const name = path.replace(/[/\\]+$/u, '').split(/[/\\]/u).pop()
      return name === undefined || name === '' ? t('folder.title') : name
    },
  }
}

/** What the session's shell shares with the folder tab. */
export interface FolderTabInjected {
  /**
   * List one directory (one level); `''` means the session workspace root.
   * `include` names ONE child that must be present in the page: the entry cap is
   * applied before the sort, so a huge folder can answer a page without the very
   * row this tab has to select. `''` asks for no such guarantee.
   */
  readonly list: (path: string, signal: AbortSignal, include?: string) => Promise<DirectoryListing>
  /** Open a file the way every other reference does. */
  readonly openFile: (path: string) => void
  /** Hand a path to the OS file manager. */
  readonly openNative: (path: string) => void
}

/** The folder tab's props: the tab seat, the copy seat, and the shell's face. */
export type FolderTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'atlas'> & InjectFace<FolderTabInjected>

export { childOf }

/**
 * Render one directory's contents.
 * @param props - the tab's live info, the Host listing call, and the openers.
 * @returns the folder's rows, or the reason it could not be listed.
 */
export function FolderTab({ useTabInfo, list, openFile, openNative, t }: FolderTabProps): ReactNode {
  const { tab } = useTabInfo()
  const opened = useMemo(() => folderPathOf(tab.contentId) ?? folderPathOf(tab.navigation.address) ?? '', [tab.contentId, tab.navigation.address])
  // The object whose SECOND click opened this folder (A.16). It arrives as tab
  // navigation params, not as part of the address: the address is the tab's
  // identity (re-opening the same folder must reveal this very tab rather than
  // open a second one), so what is merely pointed AT cannot live in it.
  const selected = useMemo(() => selectionOf(tab.navigation.params), [tab.navigation.params])
  const [current, setCurrent] = useState(opened)
  /** The rows by entry name, so the selected one can be scrolled to without a DOM query. */
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(true)
  // The injected face is re-created whenever the shell re-injects, so it must NOT
  // be an effect dependency: a new identity would abort and restart the listing on
  // every render, and the render that follows each answer would start the next one.
  const listRef = useRef(list)
  useEffect(() => { listRef.current = list }, [list])
  // The tab can be pointed at another folder from outside (the same tab reveals a
  // new address instead of a second tab), and that navigation is the new subject.
  useEffect(() => { setCurrent(opened) }, [opened])
  useEffect(() => {
    const controller = new AbortController()
    setPending(true)
    setFailure(undefined)
    void listRef.current(current, controller.signal, selected).then(
      (next) => {
        if (controller.signal.aborted) return
        setListing(next)
        setPending(false)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setFailure(error instanceof Error ? error.message : String(error))
        setPending(false)
      },
    )
    return () => { controller.abort() }
  }, [current, selected])
  const refusal = listing?.error === undefined ? undefined : t(`folder.error.${listing.error}`)
  /**
   * Bring the selected row into sight — and move nothing else.
   *
   * Deliberately NOT `scrollIntoView`: that scrolls EVERY scrollable ancestor, so
   * it also moves the Sidebar's own viewport (or the chat behind it), which the
   * user never asked for — the picker learned this the hard way in `3abd603`. Only
   * the nearest scrollable ancestor of the row is touched, and only by the amount
   * the row is out of sight.
   */
  useEffect(() => {
    if (selected === undefined) return
    const row = rowRefs.current.get(selected)
    if (row === undefined) return
    let box: HTMLElement | null = row.parentElement
    while (box !== null && box.scrollHeight <= box.clientHeight) box = box.parentElement
    if (box === null) return
    const rowBox = row.getBoundingClientRect()
    const boxBox = box.getBoundingClientRect()
    if (rowBox.top < boxBox.top) box.scrollTop += rowBox.top - boxBox.top
    else if (rowBox.bottom > boxBox.bottom) box.scrollTop += rowBox.bottom - boxBox.bottom
  }, [selected, listing, tab.navigation])
  return (
    <section className="dsh_atlas_folder" data-atlas-folder>
      <header className="dsh_atlas_folderHead">
        <button
          type="button"
          className="dsh_atlas_folderUp"
          title={t('folder.up')}
          aria-label={t('folder.up')}
          disabled={listing?.parent === undefined}
          onClick={() => { if (listing?.parent !== undefined) setCurrent(listing.parent) }}
        >
          ↑
        </button>
        <span className="dsh_atlas_folderPath" title={listing?.path ?? current}>{listing?.path ?? current}</span>
        <button type="button" className="dsh_atlas_folderOpen" onClick={() => { openNative(listing?.path ?? current) }}>
          {t('folder.system')}
        </button>
      </header>
      {refusal !== undefined && <p className="dsh_atlas_folderNote" role="alert">{refusal}</p>}
      {failure !== undefined && <p className="dsh_atlas_folderNote" role="alert">{failure}</p>}
      {pending && listing === undefined && <p className="dsh_atlas_folderNote">{t('folder.loading')}</p>}
      {/* Only when there ARE siblings to offer. The Host answers a POSIX top level
          with `drives: []`, and a `!== undefined` test rendered an empty "other
          drives" section there — a heading with nothing under it, in the very menu
          that was reported as showing no options. */}
      {listing?.drives !== undefined && listing.drives.length > 0 && (
        <ul className="dsh_atlas_folderList" aria-label={t('folder.drives')}>
          {listing.drives.map(drive => (
            <li key={drive}>
              <button type="button" className="dsh_atlas_folderRow" onClick={() => { setCurrent(drive) }}>
                <span className="dsh_atlas_folderGlyph" aria-hidden>{mentionIcon('folder')}</span>
                {drive}
              </button>
            </li>
          ))}
        </ul>
      )}
      {listing !== undefined && listing.entries.length > 0 && (
        <ul className="dsh_atlas_folderList" aria-label={t('folder.aria')}>
          {listing.entries.map(entry => {
            const child = childOf(listing.path, entry.name)
            const hit = entry.name === selected
            return (
              <li
                key={entry.name}
                ref={(node) => {
                  if (node === null) rowRefs.current.delete(entry.name)
                  else rowRefs.current.set(entry.name, node)
                }}
              >
                <button
                  type="button"
                  className={hit ? 'dsh_atlas_folderRow dsh_atlas_folderRowSelected' : 'dsh_atlas_folderRow'}
                  // The row the second click asked for, marked for both eyes and tests: a
                  // data attribute so an end-to-end check can find it, and `aria-current`
                  // so a screen reader says which row this folder was opened FOR.
                  data-atlas-selected={hit ? '' : undefined}
                  // The row the Host put back because the entry cap had cut it out of
                  // the page (see `pinEntry`). It is FIRST rather than sorted into
                  // place: the visible mark already says why it is here, and a row the
                  // user must scroll to find is the bug this repairs. The attribute
                  // lets an end-to-end check tell "pinned" from "happened to be in the
                  // first 200".
                  data-atlas-pinned={entry.pinned === true ? '' : undefined}
                  aria-current={hit ? 'true' : undefined}
                  title={child}
                  onClick={() => { if (entry.kind === 'dir') setCurrent(child); else openFile(child) }}
                >
                  <span className="dsh_atlas_folderGlyph" aria-hidden>{mentionIcon(entry.kind === 'dir' ? 'folder' : 'file')}</span>
                  <span className="dsh_atlas_folderName">{entry.kind === 'dir' ? `${entry.name}/` : entry.name}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {listing !== undefined && listing.error === undefined && listing.entries.length === 0 && (listing.drives?.length ?? 0) === 0 && (
        <p className="dsh_atlas_folderNote">{t('folder.empty')}</p>
      )}
      {listing?.truncated === true && <p className="dsh_atlas_folderNote">{t('folder.truncated')}</p>}
    </section>
  )
}
