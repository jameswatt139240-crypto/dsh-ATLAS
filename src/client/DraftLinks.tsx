/**
 * Draft-side reference bridge: the composer half of "a reference the product
 * draws is a reference the plugin can open" — and, for a draft token, "a
 * reference the PLUGIN can open is drawn as a link".
 *
 * A hand-typed `@AGENTS.md` is a reference whether or not the editor recognised
 * the name, so the plugin does not wait for the framework's decoration: it reads
 * the token out of the composer, asks whether it can open it (decode + the
 * Host's own verdict from the dock), and then paints the whole token as a link
 * and opens it on a plain click. Nothing is restructured — the colour is a
 * painted range (CSS Custom Highlight API) because a Lexical text span expects
 * exactly one text child — and nothing is promised: a token with no confirmed
 * target, an unknown provider, or an ambiguous label stays plain text.
 *
 * The listener is a CAPTURE one: this build wires no activation of its own, so
 * nothing else claims the click first. A build that later registers the
 * framework's own reference activation would run it as well — both ends open the
 * same reference through the same source, and by then this bridge is the piece to
 * delete (the version gate already reports such a build as unverified).
 */
import { useEffect, useMemo, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReferenceInfoSource } from './FilesDock.tsx'
import {
  canPaintTails,
  draftActivation,
  draftMissing,
  EDITOR_SELECTOR,
  paintDraftLinks,
  setEditorCursor,
  tokenAtPoint,
  type DraftActivation,
  type DraftVerdict,
  type InlineToken,
} from './draft-links.ts'
import { referenceKey } from './model.ts'
import type { ReferenceLink } from './reference-links.ts'
import type { SessionLabelResolver } from './session-link.ts'
import type { ReferenceOutcome } from './ReferenceLinks.tsx'

/** What the session's overlay shares with the draft bridge. */
export interface DraftLinksInjected {
  /** The action a click on this mention performs, or undefined when this build has none. */
  readonly actionFor: (link: ReferenceLink) => (() => ReferenceOutcome | Promise<ReferenceOutcome>) | undefined
  /** The dock's own inspection verdicts: the bridge never re-asks for the same path. */
  readonly hooks: { readonly referenceInfo: ReferenceInfoSource }
  /**
   * Resolve a BARE `@label` to the one session it names, or undefined. A session
   * mention carries no id once it is durable, so this is the only way a draft
   * token can become a session link — and it answers undefined for an ambiguous
   * or unknown label, so a name that also exists as a file is never hijacked.
   */
  readonly resolveSession?: SessionLabelResolver | undefined
}

/** Overlay entry props: the composer runtime face plus the opener and the verdicts. */
export type DraftLinksProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<DraftLinksInjected>

/** The caret position of a mouse event, as far as the browser can tell. */
function caretOf(event: MouseEvent): { readonly node: Node; readonly offset: number } | undefined {
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY)
  if (range == null) return undefined
  return { node: range.startContainer, offset: range.startOffset }
}

/**
 * Invisible bridge: opens the reference token a composer click lands in.
 * @param props - the injected opener and the dock's verdict source.
 * @returns nothing; this entry renders no DOM of its own.
 */
export function DraftLinks({ actionFor, useReferenceInfo, resolveSession }: DraftLinksProps) {
  const infos = useReferenceInfo(snapshot => snapshot.value)
  // Keyed by the canonical spelling (`referenceKey`): the Host answers an
  // out-of-workspace path with forward slashes while the draft may spell it with
  // backslashes, and a folder token carries a trailing separator the path does
  // not. Without that, a hand-typed `@E:\…` never found its own verdict and so
  // never became a link.
  const verdictByPath = useMemo(
    () => new Map(infos.map(info => [referenceKey(info.relative), { exists: info.exists, kind: info.kind }])),
    [infos],
  )
  // The face is re-created on every injection and every verdict lands as a new
  // array: hold it in a ref so the document listeners install ONCE per mount.
  const face = useRef({ actionFor, verdict: (path: string) => verdictByPath.get(referenceKey(path)), resolveSession })
  useEffect(() => {
    face.current = { actionFor, verdict: (path: string) => verdictByPath.get(referenceKey(path)), resolveSession }
  }, [actionFor, verdictByPath, resolveSession])
  /** Repaint on demand from outside the install effect (a verdict that arrived late). */
  const repaint = useRef(() => {})

  useEffect(() => {
    /** The action one already-resolved token offers right now, or undefined. */
    const activationFor = (reference: InlineToken): DraftActivation | undefined => {
      // Without the highlight API nothing is painted, so nothing may act as a
      // link either: only the part the framework itself coloured stays live.
      if (!canPaintTails()) {
        const end = reference.decoratedEnd
        if (end === undefined || reference.local >= end) return undefined
      }
      return draftActivation(reference.token, face.current.actionFor, face.current.verdict, face.current.resolveSession)
    }
    const paint = (): void => {
      const verdict = (path: string): DraftVerdict | undefined => face.current.verdict(path)
      paintDraftLinks((token) => {
        if (draftActivation(token.token, face.current.actionFor, verdict, face.current.resolveSession) !== undefined) return 'link'
        // A reference whose target the Host reports as gone is drawn stale rather
        // than left as prose: the dock already says 已失效 for it. Only a FINISHED
        // token is judged, though — while one is still being typed, every prefix
        // of a real path is a path the Host has never heard of, and striking it
        // through mid-word would be a claim about a word that is not written yet.
        if (!token.settled) return undefined
        return draftMissing(token.token, verdict) ? 'missing' : undefined
      })
    }
    let queued = false
    /** Cleared by the unmount, so a queued repaint cannot outlive the bridge. */
    let live = true
    const schedule = (): void => {
      if (queued || !live) return
      queued = true
      // One repaint per mutation batch: the composer's DOM is already current
      // when the observer runs, and a keystroke is one batch.
      queueMicrotask(() => {
        queued = false
        if (live) paint()
      })
    }
    repaint.current = schedule
    // The composer is re-created per session, so the per-editor observer is
    // attached on every pass (observing a node twice just replaces its options).
    const editors = new MutationObserver(schedule)
    const attach = (): void => {
      for (const root of document.querySelectorAll(EDITOR_SELECTOR)) {
        editors.observe(root, { childList: true, characterData: true, subtree: true })
      }
    }
    const onStructure = (records: readonly MutationRecord[]): void => {
      // A composer root was added or removed: re-attach and repaint.
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.closest(EDITOR_SELECTOR) !== null) {
            attach()
            schedule()
            return
          }
        }
      }
    }
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0 || event.detail > 1) return
      if (!(event.target instanceof Element)) return
      const root = event.target.closest(EDITOR_SELECTOR)
      if (root === null || document.getSelection()?.isCollapsed === false) return
      const caret = caretOf(event)
      if (caret === undefined) return
      const reference = tokenAtPoint(root, caret.node, caret.offset)
      if (reference === undefined) return
      const activation = activationFor(reference)
      if (activation === undefined) return
      event.preventDefault()
      event.stopPropagation()
      void Promise.resolve()
        .then(() => activation.run())
        .catch((error: unknown) => { console.error('[dsh-atlas] opening the draft reference failed:', error) })
    }
    let hot: Element | undefined
    const onMove = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const root = event.target.closest(EDITOR_SELECTOR)
      const caret = root === null ? undefined : caretOf(event)
      const reference = caret === undefined || root === null ? undefined : tokenAtPoint(root, caret.node, caret.offset)
      const next = root !== null && reference !== undefined && activationFor(reference) !== undefined ? root : undefined
      if (next === hot) return
      if (hot !== undefined) setEditorCursor(hot, false)
      if (next !== undefined) setEditorCursor(next, true)
      hot = next
    }
    const document_ = new MutationObserver(onStructure)
    document_.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('click', onClick, true)
    document.addEventListener('pointermove', onMove, true)
    attach()
    paint()
    return () => {
      live = false
      document_.disconnect()
      editors.disconnect()
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('pointermove', onMove, true)
      if (hot !== undefined) setEditorCursor(hot, false)
    }
  }, [])

  // A verdict that lands after the token was typed decides whether it is still a
  // link: repaint so a vanished target stops looking like one.
  useEffect(() => { repaint.current() }, [verdictByPath])

  return null
}
