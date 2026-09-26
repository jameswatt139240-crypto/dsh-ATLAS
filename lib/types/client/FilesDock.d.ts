import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { AtFileSettings, ReferenceInfo } from '../contract.ts';
import type { ReferenceLink } from './reference-links.ts';
import type { MentionKind } from './source.ts';
export interface AtFileSettingsSnapshot {
    readonly value: AtFileSettings;
}
export type AtFileSettingsSource = ObservableSnapshot<AtFileSettingsSnapshot>;
/** Snapshot of the host-inspected reference facts (existence, kind, size). */
export interface ReferenceInfoSnapshot {
    readonly value: readonly ReferenceInfo[];
}
export type ReferenceInfoSource = ObservableSnapshot<ReferenceInfoSnapshot>;
/** Injected business face: open one mention, inspect the draft's references, and the live sources. */
export interface AtFileDockInjected {
    /**
     * Open one mention of the draft (the same action a click on the sent-message
     * chip performs, so both surfaces behave alike).
     */
    onOpen: (link: ReferenceLink) => void;
    /** Ask the Host for existence, kind, and size of the draft's path references. */
    requestInspect: (targets: readonly string[]) => void;
    hooks: {
        scope: AtFileSettingsSource;
        referenceInfo: ReferenceInfoSource;
    };
}
/** Approximate bytes per token for text files (the dock's cost hint). */
export declare const BYTES_PER_TOKEN = 4;
/** References heavier than this many tokens are flagged in the dock. */
export declare const COST_WARN_TOKENS = 8000;
/**
 * Approximate context cost of one reference, or undefined when there is nothing
 * to price (missing path, directory, or a file whose size is unknown).
 * @param info - the host-inspected facts for this reference, when available.
 * @returns the token estimate and whether it exceeds the warning threshold.
 */
export declare function referenceCost(info: ReferenceInfo | undefined): {
    readonly tokens: number;
    readonly warn: boolean;
} | undefined;
/**
 * Compact token count for the dock badge (`820`, `1.2k`).
 * @param tokens - the estimated token count.
 * @returns the badge text.
 */
export declare function formatTokenCount(tokens: number): string;
/** Full dock entry props: InputZone owner share + session standard kit + injected face + locale seat. */
export type AtFileDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<AtFileDockInjected> & PropsLocale<'atlas'>;
/** One parsed mention token in the draft, with its span for precise removal. */
export interface DraftMention {
    readonly kind: Exclude<MentionKind, 'category' | 'back'>;
    /** Stable removal key (the token start index). */
    readonly key: number;
    /** Display label. */
    readonly label: string;
    /** Workspace-relative path for file/dir rows (inspection and open action). */
    readonly relative?: string;
    /** The click action's target, for rows this build can open. */
    readonly link?: ReferenceLink;
    readonly start: number;
    readonly end: number;
}
/** Parse the draft's mention tokens in order, deduplicating by kind + span. */
export declare function draftMentions(draft: string): readonly DraftMention[];
/** Draft text with one token span removed. */
export declare function withoutToken(draft: string, start: number, end: number): string;
/**
 * Render the referenced-item rows; null while the draft has no mention tokens
 * or the settings switch is off.
 * @param props - runtime (input currency + actions), inject, and locale shares.
 * @returns the dock strip, or null.
 */
export declare function FilesDock({ input, inputActions, onOpen, requestInspect, useScope, useReferenceInfo, t }: AtFileDockProps): import("react").JSX.Element | null;
