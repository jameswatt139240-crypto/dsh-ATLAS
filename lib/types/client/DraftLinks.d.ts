import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ReferenceInfoSource } from './FilesDock.tsx';
import type { ReferenceLink } from './reference-links.ts';
import type { ReferenceOutcome } from './ReferenceLinks.tsx';
/** What the session's overlay shares with the draft bridge. */
export interface DraftLinksInjected {
    /** The action a click on this mention performs, or undefined when this build has none. */
    readonly actionFor: (link: ReferenceLink) => (() => ReferenceOutcome | Promise<ReferenceOutcome>) | undefined;
    /** The dock's own inspection verdicts: the bridge never re-asks for the same path. */
    readonly hooks: {
        readonly referenceInfo: ReferenceInfoSource;
    };
}
/** Overlay entry props: the composer runtime face plus the opener and the verdicts. */
export type DraftLinksProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<DraftLinksInjected>;
/**
 * Invisible bridge: opens the reference token a composer click lands in.
 * @param props - the injected opener and the dock's verdict source.
 * @returns nothing; this entry renders no DOM of its own.
 */
export declare function DraftLinks({ actionFor, useReferenceInfo }: DraftLinksProps): null;
