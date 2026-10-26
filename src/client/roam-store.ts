/**
 * The roaming cursor's shared state.
 *
 * The gesture and the readout used to be one component. They are now two: the
 * key listener stays in `conversation.input.overlay` (it owns the keyboard), while
 * the readout renders in `conversation.input.dock` so it stacks with `/goal` and
 * `/todo` instead of floating over them. Two slot components are two React trees,
 * so they cannot share state through props or context — this module is the seam.
 *
 * It is a `createSnapshotStore`, the same primitive the plugin already uses for
 * its other cross-half state: a store whose snapshot identity changes only when
 * the value does, which is what `useSyncExternalStore` needs to avoid a render
 * loop. The store is created ONCE per plugin apply and injected into BOTH
 * registrations, so the two halves are looking at one instance rather than at two
 * module-level singletons (a second `apply` in the same page — which a reload or a
 * second session shell can produce — must not have them fighting over one value).
 */

/** What the readout needs in order to draw itself. */
export interface RoamView {
  /** Whether the walk is active; false hides the readout entirely. */
  readonly roaming: boolean
  /** The position line, already interpolated for the active locale. */
  readonly count: string
  /** The highlighted frame's preview, or the draft's caption at slot 0. */
  readonly preview: string
  /** Whether the walk is pressed against the oldest loaded frame. */
  readonly edge: boolean
  /**
   * The origin tag for the highlighted frame, already localized (A-20), or `''`
   * for a normal user message.
   *
   * A system-initiated turn carries no prompt text in the outline, so before this
   * the readout rendered an empty cell where the message should be and the user
   * read that as a broken feature. The tag names the origin, and the caller pairs
   * it with a fallback line when there is no message text to show.
   */
  readonly tag: string
  /**
   * Whether the highlighted frame could not be scrolled to (A-26), or `false`
   * when the page did move.
   *
   * Kept separate from `edge`: they answer different questions and only one of
   * them is the walk's fault. `edge` says the walk ran out of loaded history;
   * this says the frame is known but this build exposes no row to scroll to — a
   * degraded build, not an exhausted history. Reporting the second as the first
   * would tell the user their history ended when it did not.
   */
  readonly offscreen: boolean
}

/** The store's public shape: a snapshot to read and a setter to publish. */
export interface RoamStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => RoamView
  readonly set: (next: RoamView) => void
}

/**
 * Build one roaming store.
 *
 * Equality is by VALUE rather than by identity on purpose: the publisher builds a
 * fresh object on every key press and every streamed token, and a store that
 * republished on identity alone would re-render the readout for every token.
 * @returns the store, seeded with the hidden view.
 */
export function createRoamStore(): RoamStore {
  const hidden: RoamView = { roaming: false, count: '', preview: '', edge: false, tag: '', offscreen: false }
  let view = hidden
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => view,
    set: (next) => {
      if (next.roaming === view.roaming
        && next.count === view.count
        && next.preview === view.preview
        && next.edge === view.edge
        // `tag` belongs in this comparison like every other field: two frames can
        // share a count and a preview while only the origin differs — a system
        // turn whose outline carries no text renders an EMPTY preview, so walking
        // from one such frame to another changes nothing else and the readout
        // would keep the previous frame's tag.
        && next.tag === view.tag
        && next.offscreen === view.offscreen) return
      view = next
      for (const listener of listeners) listener()
    },
  }
}
