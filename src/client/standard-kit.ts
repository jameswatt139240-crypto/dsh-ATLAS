/**
 * Consumer-side declarations for the shared snapshot hooks this plugin reads.
 *
 * The framework's standard kit is declared EMPTY on purpose (`SessionStandardProps`,
 * `GlobalStandardProps`): each owning UI adapter merges the selectors it
 * contributes, so a plugin that renders into a slot receives them at runtime
 * while a program that does not depend on those adapter packages cannot see
 * them. This module is that documented mechanism used from the consumer side —
 * the same move `history-keys.ts` makes for the conversation hooks.
 *
 * Only the fields this plugin actually reads are declared, and every shape is
 * read-only: the plugin never writes a harness snapshot.
 */

/** The one Session fact the settings section reads off the list snapshot. */
export interface SessionListEntryView {
  /** Host-authoritative last update time, in epoch milliseconds. */
  readonly updatedAt: number
  /** The Session's working directory, when the Host reports one. */
  readonly cwd?: string
}

/** The Session-list snapshot as this plugin reads it. */
export interface SessionsSnapshotView {
  /** Sessions by identity. */
  readonly byId: Readonly<Record<string, SessionListEntryView | undefined>>
  /** The Session the client currently shows, when one is selected. */
  readonly current?: string
}

/** A selector hook over the Session-list snapshot. */
export type SessionsSelectorHook = <Selection>(selector: (snapshot: SessionsSnapshotView) => Selection) => Selection

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /**
     * The Session-list selector hook (contributed by ui-session).
     *
     * The Workspace hook beside it is already declared by a package this
     * program loads, so only the Session one is added here.
     */
    readonly useSessions: SessionsSelectorHook
  }
}
