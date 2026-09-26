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
 * What CAN be borrowed is the backend both of those use:
 * `ctx.uiWorkspace.listDirectory` / `createDirectory` (the `directoryPicker`
 * namespace's browse verbs). This dialog is that backend with our own face: the
 * path line is editable, a row with a chevron walks into that folder, and 打开
 * confirms the folder the path line is showing.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { mentionIcon } from './icons.tsx'

/** One row of a browse level, as the product's picker backend reports it. */
export interface PickerEntry {
  readonly name: string
  readonly path: string
  readonly hidden: boolean
}

/** One browse level: the folder itself, its ancestry, and its child folders. */
export interface PickerListing {
  readonly path: string
  readonly home: string
  readonly crumbs: readonly PickerEntry[]
  readonly entries: readonly PickerEntry[]
  readonly truncated: boolean
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
  /** One directory level from the product's picker backend; undefined starts at home. */
  readonly list: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>
  /** Create one child folder and answer its absolute path. */
  readonly create: (path: string, name: string) => Promise<string>
  /** Adopt the folder the path line shows (inserts the reference and closes). */
  readonly confirm: (path: string) => void
  /** Dismiss without adopting anything. */
  readonly close: () => void
  readonly hooks: { readonly folderPicker: FolderPickerSource }
}

/** The dialog's props: the overlay seat, this plugin's copy, and the shell's face. */
export type FolderPickerProps = PropsRuntime<'conversation.input.overlay'> & PropsLocale<'atlas'> & InjectFace<FolderPickerInjected>

/**
 * Render the folder chooser while one is requested.
 * @param props - the open state, the browse backend, and the adoption callbacks.
 * @returns the modal, or null while closed.
 */
export function FolderPicker({ useFolderPicker, list, create, confirm, close, t }: FolderPickerProps): ReactNode {
  const open = useFolderPicker(snapshot => snapshot.value !== null)
  const [path, setPath] = useState<string | undefined>(undefined)
  const [listing, setListing] = useState<PickerListing | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [folderName, setFolderName] = useState('')
  // The injected face is re-created whenever the shell re-injects, so it must not be
  // an effect dependency: a new identity would restart the listing on every render.
  const faces = useRef({ list, create })
  useEffect(() => { faces.current = { list, create } }, [list, create])
  // Every open starts at the home directory again, like the product's dialog.
  useEffect(() => {
    if (!open) return
    setPath(undefined)
    setListing(undefined)
    setFailure(undefined)
    setEditing(false)
    setCreating(false)
  }, [open])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void faces.current.list(path, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return
        setListing(next)
        setFailure(undefined)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { controller.abort() }
  }, [open, path])
  if (!open) return null
  const visible = (listing?.entries ?? []).filter(entry => showHidden || !entry.hidden)
  const walk = (next: string): void => {
    setEditing(false)
    setCreating(false)
    setPath(next)
  }
  return (
    <div className="dsh_atlas_pickerScrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section className="dsh_atlas_picker" role="dialog" aria-modal="true" aria-label={t('picker.title')} data-atlas-folder-picker>
        <header className="dsh_atlas_pickerHead">
          <h2 className="dsh_atlas_pickerTitle">{t('picker.title')}</h2>
          {editing
            ? (
              <form
                className="dsh_atlas_pickerPathRow"
                onSubmit={(event) => { event.preventDefault(); if (draft.trim() !== '') walk(draft.trim()) }}
              >
                <input
                  className="dsh_atlas_pickerInput"
                  value={draft}
                  autoFocus
                  aria-label={t('picker.path')}
                  onChange={(event) => { setDraft(event.target.value) }}
                />
                <button type="submit" className="dsh_atlas_pickerButton">{t('picker.go')}</button>
              </form>
            )
            : (
              <div className="dsh_atlas_pickerPathRow">
                <span className="dsh_atlas_pickerPath" title={listing?.path ?? ''}>{listing?.path ?? t('picker.loading')}</span>
                <button
                  type="button"
                  className="dsh_atlas_pickerIconButton"
                  title={t('picker.editPath')}
                  aria-label={t('picker.editPath')}
                  onClick={() => { setDraft(listing?.path ?? ''); setEditing(true) }}
                >
                  ✎
                </button>
              </div>
            )}
          <nav className="dsh_atlas_pickerCrumbs" aria-label={t('picker.crumbs')}>
            {listing !== undefined && listing.home !== '' && (
              <button type="button" className="dsh_atlas_pickerCrumb" onClick={() => { walk(listing.home) }}>{t('picker.home')}</button>
            )}
            {(listing?.crumbs ?? []).map(crumb => (
              <button key={crumb.path} type="button" className="dsh_atlas_pickerCrumb" title={crumb.path} onClick={() => { walk(crumb.path) }}>
                {crumb.name === '' ? crumb.path : crumb.name}
              </button>
            ))}
          </nav>
        </header>
        {failure !== undefined && <p className="dsh_atlas_pickerNote" role="alert">{failure}</p>}
        <ul className="dsh_atlas_pickerList" aria-label={t('picker.list')}>
          {visible.map(entry => (
            <li key={entry.path}>
              <button type="button" className="dsh_atlas_pickerRow" title={entry.path} onClick={() => { walk(entry.path) }}>
                <span className="dsh_atlas_pickerGlyph" aria-hidden>{mentionIcon('folder')}</span>
                <span className="dsh_atlas_pickerName">{entry.name}</span>
                <span className="dsh_atlas_pickerChevron" aria-hidden>›</span>
              </button>
            </li>
          ))}
          {listing !== undefined && visible.length === 0 && <li className="dsh_atlas_pickerNote">{t('picker.empty')}</li>}
        </ul>
        {listing?.truncated === true && <p className="dsh_atlas_pickerNote">{t('picker.truncated')}</p>}
        {creating && (
          <form
            className="dsh_atlas_pickerNewRow"
            onSubmit={(event) => {
              event.preventDefault()
              const name = folderName.trim()
              if (name === '' || listing === undefined) return
              void faces.current.create(listing.path, name).then(
                (created) => { setFolderName(''); setCreating(false); walk(created) },
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
        <footer className="dsh_atlas_pickerFoot">
          <button type="button" className="dsh_atlas_pickerButton" onClick={() => { setCreating(true); setEditing(false) }}>
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
            onClick={() => { if (listing !== undefined) confirm(listing.path) }}
          >
            {t('picker.open')}
          </button>
        </footer>
      </section>
    </div>
  )
}
