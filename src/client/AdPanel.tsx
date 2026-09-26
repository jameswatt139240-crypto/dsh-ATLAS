/**
 * Display-only ad panel that flanks the @ menu. Two states:
 * - PENDING (male) shows while the @ menu is only the pinned categories (the
 *   empty query) or while a real search is still loading; it sits INSIDE the
 *   plugin interface, on the menu's RIGHT.
 * - READY (female) shows once a typed query produced the match list; it sits
 *   OUTSIDE the plugin interface, on the menu's LEFT.
 * Both images are inlined as data URLs at build time, so the ad never blocks
 * warm/match and never makes a runtime request.
 *
 * Performance principle: the panel renders independently of the candidate
 * computation - if the menu shows, the ad just follows its geometry; there is
 * no coupling that could delay matching.
 *
 * Geometry: both images stay in the panel with visibility toggled by state
 * (structurally impossible to show both at once); the panel is as tall as the
 * menu, its width adapts to the current ad's aspect ratio at that height
 * (capped), the image is object-fit:contain so the full ad is always visible,
 * and the panel never overlaps the menu (male -> right side, female -> left
 * side; shrink to the available room, hide when even the narrowest panel
 * would not fit). It also stays below the menu in z-order (see styles.ts) so
 * a residual overlap can never hide the candidate list.
 */
import { useEffect, useRef, type SyntheticEvent } from 'react'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import adPending from './ads/ad-pending.webp'
import adReady from './ads/ad-ready.webp'

/** Our @ menu: the listbox rendered while the trigger is open. Matched via the
 *  group's data-source marker so the pending (loading) row counts too - the
 *  ready option rows alone only exist after the list settles. */
const MENU_SELECTOR = '[role="listbox"]:has([data-source="atlas"])'

/** Aspect ratios (width/height) used until the browser reports natural size. */
const PENDING_ASPECT = 320 / 480 // 2:3 portrait
const READY_ASPECT = 320 / 180 // 16:9 landscape

/** Panel width bounds and the gap to the menu. */
const MIN_WIDTH = 64
const MAX_WIDTH = 280
const GAP = 8

export interface MentionAdProps {
  /** The trigger controller's menu store (open state + geometry trigger). */
  readonly menu: SnapshotStore<MenuState>
}

/** Side ad panel; hidden unless the @ menu is open and on-screen. */
export function MentionAd({ menu }: MentionAdProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const pendingImgRef = useRef<HTMLImageElement | null>(null)
  const readyImgRef = useRef<HTMLImageElement | null>(null)
  const naturalRef = useRef<{ pending: { width: number; height: number } | null; ready: { width: number; height: number } | null }>({ pending: null, ready: null })
  // The currently-displayed ad state (false = male/pending, true = female/ready).
  // Sticky: while a search is loading we keep the current ad instead of flipping
  // on every keystroke's transient pending phase - the ad only switches when it
  // genuinely transitions (male -> female when the list first becomes ready;
  // female -> male when the query is cleared back to the empty @ categories).
  const currentReadyRef = useRef<boolean | null>(null)

  const reposition = (): void => {
    const panel = panelRef.current
    if (panel === null) return
    const state = menu.getSnapshot()
    if (!state.open) {
      panel.style.display = 'none'
      currentReadyRef.current = null
      return
    }
    // Only the @ trigger's menu: a slash/other menu has no atlas group.
    const group = state.groups.find(candidate => candidate.source === 'atlas')
    if (group === undefined) {
      panel.style.display = 'none'
      currentReadyRef.current = null
      return
    }
    // READY (female) only after a typed query produced the match list; the
    // empty @ (pinned categories alone) and any still-loading search keep the
    // PENDING (male) image. The state is STICKY: while a search is loading
    // (group pending with a query), keep whichever ad is currently shown so the
    // image never flickers on each keystroke's transient pending phase.
    const query = state.hit?.query ?? ''
    const hasQuery = query.trim() !== ''
    let ready: boolean
    if (group.status === 'ready' && hasQuery) {
      ready = true
    } else if (!hasQuery) {
      ready = false
    } else {
      // Pending + a query (list still loading): keep the current ad.
      ready = currentReadyRef.current ?? false
    }
    const pendingImg = pendingImgRef.current
    const readyImg = readyImgRef.current
    if (currentReadyRef.current !== ready) {
      currentReadyRef.current = ready
      if (pendingImg !== null && readyImg !== null) {
        pendingImg.style.display = ready ? 'none' : 'block'
        readyImg.style.display = ready ? 'block' : 'none'
      }
    }
    const menuEl = document.querySelector<HTMLElement>(MENU_SELECTOR)
    if (menuEl === null) {
      panel.style.display = 'none'
      return
    }
    const rect = menuEl.getBoundingClientRect()
    if (rect.height <= 0) {
      panel.style.display = 'none'
      return
    }
    // As tall as the menu; width follows the ad's own aspect at that height so
    // the whole image fits (object-fit:contain) instead of being cropped.
    const natural = ready ? naturalRef.current.ready : naturalRef.current.pending
    const aspect = natural !== null ? natural.width / natural.height : (ready ? READY_ASPECT : PENDING_ASPECT)
    let width = Math.max(MIN_WIDTH, Math.min(Math.round(rect.height * aspect), MAX_WIDTH))
    const viewport = window.innerWidth
    // Male (pending) sits INSIDE on the menu's right; female (ready) sits
    // OUTSIDE on the menu's left. Never overlap the menu: shrink to the
    // available room, hide when even the narrowest panel would not fit.
    let left: number
    if (!ready) {
      const rightRoom = viewport - GAP - (rect.right + GAP)
      if (width > rightRoom) {
        if (rightRoom >= MIN_WIDTH) width = Math.min(width, rightRoom)
        else { panel.style.display = 'none'; return }
      }
      left = rect.right + GAP
    } else {
      const leftRoom = rect.left - GAP - GAP
      if (width > leftRoom) {
        if (leftRoom >= MIN_WIDTH) width = Math.min(width, leftRoom)
        else { panel.style.display = 'none'; return }
      }
      left = rect.left - GAP - width
    }
    // Align exactly with the menu box (top and height), so the ad and the
    // plugin interface share the same top/bottom edges even when the tall menu
    // extends above the viewport. The menu is the reference; the ad follows it.
    const top = rect.top
    panel.style.display = 'block'
    panel.style.width = width + 'px'
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
    panel.style.height = rect.height + 'px'
  }

  useEffect(() => {
    // The menu store updates before React reflows the menu DOM, so the rect read
    // in the subscription can lag the menu's grown height. The menu's content can
    // also grow without a store event (loading -> categories -> results), so a
    // lightweight poll re-reads the menu rect while it is open - the ad always
    // tracks the menu's real size (display-only inline style updates, negligible).
    const off = menu.subscribe(reposition)
    const onResize = (): void => reposition()
    const onScroll = (): void => reposition()
    window.addEventListener('resize', onResize)
    document.addEventListener('scroll', onScroll, true)
    const interval = setInterval(() => {
      if (menu.getSnapshot().open) reposition()
    }, 150)
    // Pre-warm both ad states with the category pages (inlined data URLs make
    // this instant, but the hook stays for future remote images).
    const preload = (url: string): void => {
      const image = new Image()
      image.src = url
    }
    preload(adPending)
    preload(adReady)
    reposition()
    return () => {
      off()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('scroll', onScroll, true)
      clearInterval(interval)
    }
  }, [menu])

  const onImageLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const target = event.currentTarget
    if (target.naturalWidth > 0 && target.naturalHeight > 0) {
      const state = target.getAttribute('data-state') === 'true' ? 'ready' : 'pending'
      naturalRef.current[state] = { width: target.naturalWidth, height: target.naturalHeight }
      reposition()
    }
  }
  const hideImage = (event: SyntheticEvent<HTMLImageElement>): void => {
    event.currentTarget.style.display = 'none'
  }

  return (
    <aside ref={panelRef} className="dsh_atAll_ad" data-dsh-atlas-ad aria-hidden style={{ display: 'none' }}>
      <img
        ref={pendingImgRef}
        src={adPending}
        data-state="false"
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={onImageLoad}
        onError={hideImage}
      />
      <img
        ref={readyImgRef}
        src={adReady}
        data-state="true"
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        style={{ display: 'none' }}
        onLoad={onImageLoad}
        onError={hideImage}
      />
    </aside>
  )
}
