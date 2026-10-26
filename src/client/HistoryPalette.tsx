/**
 * F1 — the history palette. `Ctrl/Cmd+Shift+H` (or without Shift) opens a
 * searchable list of every
 * user message this session has sent, oldest first, and `Enter` puts one back
 * into the composer.
 *
 * This is the "find it" half of the feature, where F2 (`FrameCursor`) is the
 * "walk it" half: the palette can jump straight to a message from twenty turns
 * ago without stepping through the nineteen in between.
 *
 * The palette and the roaming cursor share the frame index (`history-frames.ts`)
 * and the write-back path, but NOT their key handling: this component owns the
 * keyboard while it is open (the roaming listener declines every key in the
 * `palette` phase), because a filter input needs the arrow keys for its own
 * caret movement and the list's highlight for navigation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { buildFrames, collapse, frameKeyOf, type HistoryFrame, type HistoryFrameMode } from './history-frames.ts'
import type { HistoryChatHook, HistoryStandardProps } from './history-keys.ts'
import { isPaletteChord } from './history-keys.ts'
import type { AtFileSettingsSource } from './FilesDock.tsx'
import { NS } from './locales.ts'

/** Marks the palette root, so a test can find it without a generated class. */
const PALETTE_SELECTOR = '[data-atlas-history-palette]'

/** The composer card, focused again once a message has been reused. */
const CARD_SELECTOR = '[data-composer-card]'

/** Injected surface for the palette. */
export interface HistoryPaletteInjected {
  /** The plugin's settings snapshot. */
  readonly scope: AtFileSettingsSource
}

/** The palette props; standard session props arrive spread onto the object. */
export type HistoryPaletteProps =
  & PropsRuntime<'conversation.input.overlay'>
  & InjectFace<HistoryPaletteInjected>
  & HistoryStandardProps
  & PropsLocale<typeof NS>

/**
 * Whether a modal dialog currently owns the keyboard.
 *
 * The palette is itself a dialog, so this is asked only while it is CLOSED: an
 * already-open modal must keep owning Escape and the arrows.
 * @returns whether a modal is open.
 */
function modalOpen(): boolean {
  /* v8 ignore next -- a browser-only plugin: this guard only fires under SSR, which never renders it. */
  if (typeof document === 'undefined') return false
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

/**
 * Whether the event came from an editor this plugin does not own.
 * @param target - the event target.
 * @returns whether to decline the gesture.
 */
function isForeignEditor(target: EventTarget | null): boolean {
  /* v8 ignore next -- the null/instanceof guard is unreachable from a real keydown, which always has an HTMLElement target. */
  if (target === null || !(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Give the composer focus back, so the user can keep typing where they were. */
function focusComposer(): void {
  /* v8 ignore next -- a browser-only plugin: this guard only fires under SSR, which never renders it. */
  if (typeof document === 'undefined') return
  const card = document.querySelector(CARD_SELECTOR)
  card?.querySelector<HTMLElement>('[contenteditable="true"], [contenteditable=""]')?.focus()
}

/**
 * Whether a frame matches the palette's filter.
 *
 * The query is matched against the message's own text AND its turn's answer:
 * "the one where we talked about X" is as often remembered by the reply as by
 * the question. An empty query matches everything.
 * @param frame - the frame.
 * @param query - the collapsed, lower-cased query.
 * @returns whether the frame should be listed.
 */
export function matchesQuery(frame: HistoryFrame, query: string): boolean {
  if (query === '') return true
  return frame.preview.toLowerCase().includes(query) || frame.answer.toLowerCase().includes(query)
}

/** The history palette overlay. */
export function HistoryPalette(props: HistoryPaletteProps) {
  const { scope, useInput, inputActions, useChat, t } = props
  const settings = scope.getSnapshot().value
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const enabled = settings.historyJump !== false
  // A-33: see FrameCursor — absent means turn, only an explicit `'message'`
  // opts into the finer walk.
  const mode: HistoryFrameMode = settings.historyJumpFrames === 'message' ? 'message' : 'turn'
  const reuseMode = settings.historyJumpReuseMode === 'append' ? 'append' : 'replace'
  const frames = useHistoryFrames(useChat, mode)

  const draft = useInput(state => state.draft)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // The frames are listed NEWEST first: the message a user wants back is far more
  // often the last one than the first one, so the top of the list is the recent
  // end. (F2 walks the other way because it is a cursor the user steps from the
  // draft, but a searchable list is read from the top.)
  const listed = useMemo(
    () => frames.filter(frame => matchesQuery(frame, collapse(query).toLowerCase())).reverse(),
    [frames, query],
  )

  // Everything the document listener reads lives in one ref: the listener is
  // installed once (see the effect below), so captured render values would go
  // stale between presses.
  const stateRef = useRef({ open, listed, cursor, reuseMode })
  stateRef.current = { open, listed, cursor, reuseMode }

  /** Put one frame's original text back into the composer and close. */
  const reuse = useCallback((frame: HistoryFrame): void => {
    const current = draftRef.current
    const append = stateRef.current.reuseMode === 'append'
    const next = append && current.trim() !== '' && frame.text !== ''
      ? `${current}${current.endsWith('\n') ? '' : '\n'}${frame.text}`
      : frame.text
    inputActions.setDraft(next)
    setOpen(false)
    setQuery('')
    setCursor(0)
    focusComposer()
  }, [inputActions])

  // The highlight follows the LIST: a filter that shrinks the list must not leave
  // the cursor pointing past its end (which would make Enter do nothing).
  useEffect(() => {
    setCursor(current => (current >= listed.length ? Math.max(0, listed.length - 1) : current))
  }, [listed.length])

  // Opening the palette moves focus into it: the filter input is the first thing
  // the user types into, and the frame list's own keys are handled on the root.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const input = document.querySelector<HTMLInputElement>(`${PALETTE_SELECTOR} [data-atlas-history-filter]`)
    input?.focus()
  }, [open])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = stateRef.current
      const foreign = isForeignEditor(event.target)
      const chord = isPaletteChord({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
      }) && event.key.toLowerCase() === 'h'

      if (!state.open) {
        // Opening is the one gesture that has to survive the composer's own key
        // handling, so it is consumed. It also works while generating: reading
        // history is exactly what a user does while waiting for an answer.
        if (!enabled || event.isComposing || chord === false) return
        if (foreign || modalOpen()) return
        event.preventDefault()
        setQuery('')
        setCursor(0)
        setOpen(true)
        return
      }

      // While the palette is open it owns the keyboard: the filter input's caret
      // must not also be walking the conversation behind it.
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          setOpen(false)
          focusComposer()
          return
        case 'ArrowUp':
          event.preventDefault()
          setCursor(current => (current <= 0 ? Math.max(0, state.listed.length - 1) : current - 1))
          return
        case 'ArrowDown':
          event.preventDefault()
          setCursor(current => (current >= state.listed.length - 1 ? 0 : current + 1))
          return
        case 'Enter': {
          event.preventDefault()
          const frame = state.listed[state.cursor]
          if (frame !== undefined) reuse(frame)
          return
        }
        default:
          // Typing filters; nothing to consume. The chord itself is ignored here
          // so Ctrl+H does not close a palette the user is already reading.
          return
      }
    }
    // Capture phase, for the same reason the roaming cursor uses it: the palette
    // must see Escape and the arrows before the composer's own key handling does.
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [enabled, reuse])

  // Close without reusing: a click on the backdrop, or the close button.
  const close = useCallback((): void => {
    setOpen(false)
    focusComposer()
  }, [])

  if (!open) return null

  const total = frames.length
  const count = t('history.paletteCount', { total: String(listed.length) })

  return (
    <div className="dsh_atlas_paletteLayer" data-atlas-history-palette="" data-atlas-frame-count={String(total)}>
      <div className="dsh_atlas_paletteBackdrop" onClick={close} aria-hidden="true" />
      <div className="dsh_atlas_palette" role="dialog" aria-modal="true" aria-label={t('history.paletteTitle')}>
        <div className="dsh_atlas_paletteHead">
          <span className="dsh_atlas_paletteTitle">{t('history.paletteTitle')}</span>
          <span className="dsh_atlas_paletteCount">{count}</span>
        </div>
        <input
          type="text"
          className="dsh_atlas_paletteFilter"
          data-atlas-history-filter=""
          value={query}
          placeholder={t('history.paletteFilter')}
          aria-label={t('history.paletteFilter')}
          onChange={event => { setQuery(event.target.value); setCursor(0) }}
        />
        {listed.length === 0
          ? <div className="dsh_atlas_paletteEmpty">{t('history.paletteEmpty')}</div>
          : (
            <ul className="dsh_atlas_paletteList" role="listbox" aria-label={t('history.paletteTitle')}>
              {listed.map((frame, index) => (
                <li key={frameKeyOf(frame)}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === cursor}
                    className="dsh_atlas_paletteRow"
                    data-atlas-history-row=""
                    data-atlas-history-active={index === cursor ? '' : undefined}
                    data-atlas-frame-key={frame.key}
                    onClick={() => { reuse(frame) }}
                    onMouseEnter={() => { setCursor(index) }}
                  >
                    <span className="dsh_atlas_paletteRowText">
                      {frame.kind === 'steering'
                        ? <span className="dsh_atlas_paletteTag">{t('history.steeringTag')}</span>
                        : frame.systemInitiated
                          ? <span className="dsh_atlas_paletteTag">{t('history.systemTag')}</span>
                          : frame.kind === 'reply'
                            ? <span className="dsh_atlas_paletteTag">{t('history.replyTag')}</span>
                            : null}
                      {frame.preview === '' ? t('history.draftSlot') : frame.preview}
                    </span>
                    {frame.answer === ''
                      ? null
                      : (
                        <span className="dsh_atlas_paletteRowAnswer">
                          <span className="dsh_atlas_paletteTag">{t('history.paletteAnswer')}</span>
                          {frame.answer}
                        </span>
                      )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        <div className="dsh_atlas_paletteFoot">{t('history.paletteHint')}</div>
      </div>
    </div>
  )
}

/**
 * Build the frame list from the session's live Chat snapshot.
 *
 * `useChat` arrives as a standard prop the renderer spreads into every
 * session-scoped slot, exactly as in `FrameCursor`; selecting `order` and `nodes`
 * separately keeps the rebuild tied to the node set rather than to every snapshot
 * identity.
 * @param useChat - the session's standard Chat selector hook.
 * @param mode - the configured frame granularity.
 * @returns the frames, oldest first.
 */
function useHistoryFrames(
  useChat: HistoryChatHook,
  mode: HistoryFrameMode,
): readonly HistoryFrame[] {
  const order = useChat(snapshot => snapshot.order)
  const nodes = useChat(snapshot => snapshot.nodes)
  return useMemo(
    () => buildFrames(order, key => nodes.get(key) as never, mode),
    [order, nodes, mode],
  )
}
