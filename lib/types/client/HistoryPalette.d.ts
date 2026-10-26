import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { type HistoryFrame } from './history-frames.ts';
import type { HistoryStandardProps } from './history-keys.ts';
import type { AtFileSettingsSource } from './FilesDock.tsx';
import { NS } from './locales.ts';
/** Injected surface for the palette. */
export interface HistoryPaletteInjected {
    /** The plugin's settings snapshot. */
    readonly scope: AtFileSettingsSource;
}
/** The palette props; standard session props arrive spread onto the object. */
export type HistoryPaletteProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<HistoryPaletteInjected> & HistoryStandardProps & PropsLocale<typeof NS>;
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
export declare function matchesQuery(frame: HistoryFrame, query: string): boolean;
/** The history palette overlay. */
export declare function HistoryPalette(props: HistoryPaletteProps): import("react").JSX.Element | null;
