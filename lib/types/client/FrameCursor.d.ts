import type { ReactElement } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { RoamStore } from './roam-store.ts';
import { type HistoryStandardProps } from './history-keys.ts';
import type { AtFileSettingsSource } from './FilesDock.tsx';
import { NS } from './locales.ts';
/**
 * The plugin's own structural view of one session projection face.
 *
 * Deliberately structural rather than imported from the api package: the overlay
 * only ever needs `faceOf`, and narrowing it here keeps a client build whose face
 * spells that differently degrading to the window-only walk rather than failing
 * to typecheck against a version this package does not pin.
 */
export interface ProjectionFace {
    /** @param key - projection key. @returns its live value, or undefined. */
    readonly faceOf: (key: string) => {
        readonly getSnapshot: () => unknown;
        readonly subscribe: (listener: () => void) => () => void;
    };
}
/** How many slots `PageUp`/`PageDown` move while roaming. */
export declare const ROAM_PAGE_ROWS = 5;
/** Injected surface for the roaming overlay. */
export interface FrameCursorInjected {
    /** The plugin's settings snapshot. */
    readonly scope: AtFileSettingsSource;
    /** The @ mention menu, whose open state suppresses the gesture. */
    readonly menu?: SnapshotStore<{
        readonly open: boolean;
    }>;
    /**
     * Page the loaded window back until it covers a seq (A-05).
     *
     * Optional by design: an older client build has no such verb, and the walk
     * then simply stops at the oldest LOADED frame — which is a supported
     * degradation, not a broken feature.
     */
    readonly loadThrough?: (seq: number) => Promise<void>;
    /**
     * The session-wide `turnOutline` projection, as a live observable (A-13).
     *
     * This is what makes the walk's total agree with the page's own turn ruler: the
     * projection folds the WHOLE log, while the Chat snapshot only holds the paged
     * window. Reading it through the session face rather than through a slot prop
     * is deliberate — `useProjection` is declared on `ChatViewInjected`, which the
     * `conversation.view` slot alone receives, whereas this overlay is handed the
     * session face directly.
     *
     * Optional by design: a client build without the projection keeps the
     * window-only walk instead of failing to register the gesture.
     */
    readonly projections?: ProjectionFace;
    /**
     * Where the readout is published.
     *
     * The readout renders in the input dock (so it stacks with `/goal` and `/todo`)
     * while this component owns the key listener, and two slot components are two
     * React trees — hence a store rather than state. Optional so an injected
     * `FrameCursor` in a spec that only cares about keys stays valid.
     */
    readonly roam?: RoamStore;
}
/**
 * The overlay props.
 *
 * `input`, `inputActions` and `useChat` are NOT declared as injections: they are
 * standard props the renderer spreads into every session-scoped slot, so listing
 * them here would be a lie the registration site then has to satisfy. Only the
 * plugin's own injections live in `FrameCursorInjected`.
 */
export type FrameCursorProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<FrameCursorInjected> & HistoryStandardProps & PropsLocale<typeof NS>;
/** Invisible overlay entry: the history roaming gesture. */
export declare function FrameCursor(props: FrameCursorProps): null;
/** Injected surface for the dock-hosted readout. */
export interface FrameReadoutInjected {
    /** The store the overlay publishes the cursor into. */
    readonly roam?: RoamStore;
}
/**
 * The dock-hosted counterpart of `FrameCursorProps`, for the readout half.
 *
 * It deliberately does NOT take the Chat hook: the cursor is already computed by
 * the overlay half, and recomputing the walk here would double the work for a
 * value it would then have to keep in step. It reads the published store instead.
 */
export type FrameReadoutProps = PropsRuntime<'conversation.input.dock'> & InjectFace<FrameReadoutInjected> & PropsLocale<typeof NS>;
/**
 * The roaming readout, rendered above the composer.
 *
 * It lives in `conversation.input.dock` rather than in an overlay, which is what
 * the user asked for: `/goal` and `/todo` are dock entries too, and the dock is a
 * flex column, so the three STACK instead of covering one another. That is a
 * structural guarantee — there is no z-index to get wrong and no geometry to
 * measure — and it also means the readout shares the composer's width for free,
 * which is what the retired card-measuring effect used to arrange by hand.
 *
 * It renders nothing at all while the walk is inactive, so the dock gains no
 * permanent row when the feature is not in use.
 * @param props - the dock slot props, carrying the injected store.
 * @returns the readout strip, or null when not roaming.
 */
export declare function FrameReadout(props: FrameReadoutProps): ReactElement | null;
