import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { InputTriggerCandidate, MenuState, TriggerGuard } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { AtFileSettingsSource } from './FilesDock.tsx';
/** Controller surface required by the completion bridge. */
export interface MentionNavigationController {
    readonly menu: SnapshotStore<MenuState>;
    track(draft: string, caret: number, guard: TriggerGuard, draftRev: number): void;
    /** Close the menu without a pick (used to force a refresh). */
    dismiss(): void;
}
/** Injected controller for the current session. */
export interface MentionNavigatorInjected {
    readonly controller: MentionNavigationController;
    readonly hooks: {
        scope: AtFileSettingsSource;
    };
    readonly sessionId: string;
    /** Toggle one group header's collapse state (chat:/skill: keys). */
    readonly toggleGroup: (key: string) => void;
    /** Synchronously rebuild rows for a category query from settled caches. */
    readonly rebuildRows: (sessionId: string, query: string) => readonly InputTriggerCandidate[] | undefined;
    /**
     * A message was submitted. The Host records referenced external paths in its
     * ledger during the send, so any cached out-of-workspace scope is now suspect.
     */
    readonly onSend?: () => void;
}
/** Overlay entry props: session input state/actions plus the trigger controller. */
export type MentionNavigatorProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<MentionNavigatorInjected>;
/** Input facts needed to validate a menu-time completion. */
export interface MentionNavigationInput {
    readonly draft: string;
    readonly draftRev: number;
    readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting';
}
/** The group row currently highlighted in the @ menu, if any. */
export declare function highlightedGroup(menu: MenuState): {
    key: string;
    index: number;
} | undefined;
/** The group row at a menu index, or undefined. */
export declare function groupAt(menu: MenuState, index: number): {
    key: string;
} | undefined;
/** Whether the row at index is the back-to-categories row. */
export declare function backRowAt(menu: MenuState, index: number): boolean;
/** The category row at index (its draft prefix), or undefined. */
export declare function categoryRowAt(menu: MenuState, index: number): {
    prefix: string;
} | undefined;
/** Whether a menu item is a section header (category/back/group) rather than a result leaf. */
export declare function isHeaderRow(item: {
    mentionKind?: string;
} | undefined): boolean;
/**
 * The index of the first result leaf in the atlas group (skipping every
 * section header), or -1 when the menu has no result rows yet.
 */
export declare function firstLeafIndex(menu: MenuState): number;
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
export declare function defaultHighlightIndex(menu: MenuState): number;
/**
 * Rows one PageUp/PageDown covers when the list cannot be measured.
 *
 * jsdom implements no layout, and a browser can be asked before the list has one:
 * a fixed page is better than a division by zero, and eight rows is what the menu
 * shows at its usual height anyway.
 */
export declare const PAGE_ROWS = 8;
/**
 * How many rows one page covers in the open menu.
 *
 * Measured from the live list rather than assumed, so a taller window pages
 * further and a short one does not jump past what the user can see.
 * @param box - the menu's scrolling listbox, or null when it is not rendered.
 * @returns the row count of one page (at least one).
 */
export declare function pageStep(box: Element | null): number;
/** Whether this is a plain Enter: no IME ownership, no modifier, not already handled. */
export declare function isPlainEnter(event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'defaultPrevented' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean;
/** Invisible overlay entry: folds group headers and keeps category rows in the menu. */
export declare function MentionNavigator({ controller, useInput, inputActions, toggleGroup, sessionId, rebuildRows, onSend }: MentionNavigatorProps): null;
