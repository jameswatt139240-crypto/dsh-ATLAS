import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { type ReferenceLink } from './reference-links.ts';
/** The attribute this bridge sets on a chip it can open (hover affordance hook). */
export declare const LINK_ATTRIBUTE = "data-dsh-atlas-link";
/** The attribute this bridge sets on a chip whose target is gone (stale styling hook). */
export declare const MISSING_ATTRIBUTE = "data-dsh-atlas-missing";
/** What a click on one reference did, as far as the chip is concerned. */
export type ReferenceOutcome = 'opened' | 'gone';
/** What the session's overlay shares with the bridge. */
export interface ReferenceLinksInjected {
    /**
     * The action a click on this mention performs, or undefined when this build
     * has none (an unknown provider, a provider that declared no `open`, a
     * session with no client scope). The same answer drives the hover affordance,
     * so a chip is never drawn as clickable unless clicking really does something.
     *
     * The outcome is what the chip has to show: a reference whose target no longer
     * exists is a normal state — the user deleted or renamed the file long after
     * the mention was sent — so the bridge marks that chip stale instead of
     * pretending the click opened something.
     */
    readonly actionFor: (link: ReferenceLink) => (() => ReferenceOutcome | Promise<ReferenceOutcome>) | undefined;
    /**
     * Map one composer chip's label to a workspace-relative path.
     *
     * A source that inserts chips may label them with a bare file name (the
     * sidebar plugin does: the chip shows `@index.ts` while it serializes to
     * `@src/client/index.ts`), so a bare name is resolved through the plugin's own
     * index before the click. `undefined` means the label alone cannot name one
     * file (two indexed paths answer to it), and the bridge then falls back to the
     * draft — never to a guess.
     */
    readonly resolveLabel: (label: string) => string | undefined;
}
/** Overlay entry props: the chat overlay's runtime face plus the opener. */
export type ReferenceLinksProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<ReferenceLinksInjected>;
/**
 * The openable mention of one chip element, or undefined.
 *
 * A `<button>` chip means the framework passed its reference actions and wires
 * the click itself; acting as well would open the resource twice. A chip of any
 * other kind (session, folder, skill-slash, command) is not ours to open.
 * @param chip - the chip element.
 * @returns the decoded action, or undefined when the bridge must not act.
 */
export declare function chipLink(chip: Element): ReferenceLink | undefined;
/** The visual body of a composer chip inside its host element. */
export declare function composerChipBody(host: Element): Element;
/**
 * The openable mention of one composer chip, or undefined.
 *
 * The label is the chip body's `title` (the framework renders the visible `@` as
 * a separate marker span, and uses a domain icon instead for some sources), with
 * the host's own text as the fallback. A label that is not a mention of ours — a
 * slash chip (`/skill`), an empty label, a provider handle — stays inert, exactly
 * as an inert sent chip does.
 *
 * Unlike a draft TOKEN, this is not checked against the Host first: the label is
 * another source's display text, not necessarily a workspace spelling the dock
 * inspected. `dsh-better-sidebar`, which inserts these chips, labels a chip with
 * the file's BASENAME while its serialization keeps the full relative path, so
 * the caller resolves a bare name through the plugin's own index before the
 * click, and the click itself discovers a vanished target the way a sent chip
 * does — the action reports `gone` and the chip is marked stale.
 * @param host - one `[data-composer-chip]` host element.
 * @param resolve - maps one chip label to a workspace-relative path.
 * @returns the decoded mention, or undefined when the bridge must not act.
 */
export declare function composerChipLink(host: Element, resolve?: (label: string) => string | undefined): ReferenceLink | undefined;
/**
 * The one draft token a bare chip label names, or undefined.
 *
 * A chip's full reference lives in its Lexical node, not in the DOM — but the
 * DRAFT keeps exactly what that source serializes (the whole mention), so a
 * label the index could not place is still recoverable when the draft holds
 * precisely one token with that basename. Two candidates mean the label cannot
 * say which one is meant, and the answer is then undefined: an inert chip beats
 * opening the wrong file.
 * @param draft - the composer's draft text.
 * @param label - the chip's visible label.
 * @returns the workspace-relative path the draft spells, or undefined.
 */
export declare function draftPathForLabel(draft: string, label: string): string | undefined;
/** Invisible bridge: opens the reference chips the product renders on click. */
export declare function ReferenceLinks({ actionFor, resolveLabel, useInput }: ReferenceLinksProps): null;
