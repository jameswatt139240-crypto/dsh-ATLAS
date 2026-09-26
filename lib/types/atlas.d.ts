/**
 * The `@` data-source seam — one contract, validated per half.
 *
 * ATLAS defines the capability (this file), third-party plugins provide it, and
 * the `@` menu is the single consumer, the same three-layer split the official
 * `dsh-shell` seam uses. A provider hands over a declaration plus its callbacks;
 * it never hands over its data, and this registry never reaches for anything the
 * provider did not explicitly declare.
 *
 * The seam has two halves because DSH plugins do: the browser half answers
 * `list` while the menu is open, and the Host half answers `resolve` when a
 * committed reference is turned into model-visible text. A plugin may register
 * either half; `id` ties them together. Registration IS the authorization — a
 * plugin that never registers is invisible here.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types';
/** One selectable row a provider offers to the menu. */
export interface AtlasItem {
    /** Provider-owned id, handed back to `resolve` verbatim; token-safe. */
    readonly id: string;
    /** Menu title. */
    readonly title: string;
    /** One-line preview shown in the list only; never injected on its own. */
    readonly preview?: string;
    /** Compact right-hand badge (severity, count, status). */
    readonly badge?: string;
}
/** What a provider learns about the call it is answering. */
export interface AtlasCallContext {
    readonly sessionId: SessionId;
    /**
     * The answered session's workspace directory, when the Host knows it. A
     * provider that reaches outside the conversation (the built-in `@git` source
     * runs Git there) must not guess it.
     */
    readonly cwd?: string;
    /** Superseded when the query changes or the menu closes. */
    readonly signal: AbortSignal;
}
/**
 * One registered data source.
 *
 * `list` runs while the menu is open and must stay cheap; `resolve` runs once,
 * after the user commits, and may be expensive. `scopes` and `testedOn` are the
 * governance layer the framework does not provide: what the provider will reach
 * for, and which DSH versions it has actually been proven on.
 */
/**
 * What a provider's `open` may report back.
 *
 * `'gone'` says the item's target no longer exists — the menu then draws the
 * mention's chip as stale rather than as a link, which is the honest answer to a
 * click that could not open anything. `'opened'`, or no return value at all,
 * means the click did its thing.
 */
export type AtlasOpenOutcome = 'opened' | 'gone';
export interface AtlasProvider {
    /** The `@<id>` handle; unique across providers. */
    readonly id: string;
    readonly display: string;
    /** Browser half: candidates for the open menu. Required when registering a `list` half. */
    list?(query: string, ctx: AtlasCallContext): Promise<readonly AtlasItem[]>;
    /**
     * Browser half: open ONE of this provider's items for the user — the click
     * action of a committed `@atlas:<id>/<item>` mention in an already sent
     * message. Optional, and deliberately the provider's own business: an item id
     * means whatever the provider says it means, so the menu never interprets one
     * (a `@git` item happens to be a workspace path, a `@docs` item would be a
     * URL). A provider without this callback contributes an inert chip that is
     * never drawn as clickable.
     *
     * Returning `'gone'` is how a provider tells the menu its item no longer
     * exists, so the chip can be drawn stale instead of as a live link. Anything
     * else (including the usual `void`) means the click did its thing.
     */
    open?(item: string, ctx: AtlasCallContext): AtlasOpenOutcome | void | Promise<AtlasOpenOutcome | void>;
    /** Host half: the model-visible text for one committed item. */
    resolve?(item: AtlasItem, ctx: AtlasCallContext): Promise<string>;
    /** What this provider reaches for; `[]` means it reaches nothing external. */
    readonly scopes: readonly string[];
    /** DSH versions this provider was verified against. */
    readonly testedOn: readonly string[];
}
/** One accepted provider, with the registry's own verdict attached. */
export interface AtlasRegistration {
    readonly id: string;
    readonly display: string;
    readonly scopes: readonly string[];
    readonly testedOn: readonly string[];
    /**
     * Whether the running DSH version appears in `testedOn`. False also when the
     * runtime version is unknown: an unproven claim must never read as proven.
     */
    readonly verified: boolean;
    readonly provider: AtlasProvider;
}
/** The running Harness facts the registry needs for its version gate. */
export interface AtlasRuntimeInfo {
    /** The DSH version of this session, when the Host could report it. */
    readonly dshVersion?: string;
}
/** Which half a registry instance accepts. */
export interface AtlasHalf {
    /** Require and keep `list` (the browser/menu half). */
    readonly list: boolean;
    /**
     * Keep the optional `open` callback (the browser/menu half only). Optional so
     * an existing registry keeps its meaning: absent means a declaration carrying
     * `open` is refused rather than silently never called.
     */
    readonly open?: boolean;
    /** Require and keep `resolve` (the Host/injection half). */
    readonly resolve: boolean;
}
/**
 * The handle the seam publishes as `ctx.get('atlas')`.
 *
 * Both halves publish this same shape, so a provider author writes one
 * declaration either way — which callbacks it must carry depends on the half it
 * is registering into, and the registry says so by throwing.
 */
export interface AtlasSeam {
    /**
     * Accept one provider declaration for the half this handle belongs to.
     * @param candidate - the declaration.
     * @returns the disposer that withdraws it.
     */
    register(candidate: unknown): () => void;
}
/**
 * Validate one candidate declaration, naming the first field that fails.
 * @param candidate - the value handed to `register`.
 * @param half - which callbacks this registry requires.
 * @returns the same value typed as a provider.
 */
export declare function validateAtlasDeclaration(candidate: unknown, half: AtlasHalf): AtlasProvider;
/**
 * Validate one item a provider returned.
 * @param item - the value from `list`.
 * @returns the same value typed as an item.
 */
export declare function validateAtlasItem(item: unknown): AtlasItem;
/**
 * The `@` seam's registry: accepts declarations for one half, enforces the
 * governance rules, and hands the accepted providers to that half's consumer.
 */
export declare class AtlasRegistry {
    private readonly registrations;
    private readonly readRuntime;
    private readonly half;
    /**
     * @param readRuntime - the running Harness facts used by the version gate;
     *   accepted as a thunk (read at verdict time) or as a plain record.
     * @param half - which callbacks this instance requires (defaults to both).
     */
    constructor(readRuntime?: (() => AtlasRuntimeInfo) | AtlasRuntimeInfo, half?: AtlasHalf);
    /**
     * Accept one provider declaration.
     * @param candidate - the declaration handed over by a plugin.
     * @returns the disposer that withdraws it.
     */
    register(candidate: unknown): () => void;
    /** Every accepted provider, in registration order. */
    entries(): readonly AtlasRegistration[];
    /**
     * One accepted provider by handle.
     * @param id - the provider handle.
     * @returns the registration, or undefined when nothing claimed it.
     */
    get(id: string): AtlasRegistration | undefined;
    /**
     * Re-read the version verdict for one stored registration.
     *
     * The verdict is deliberately not a snapshot: the browser learns the running
     * version asynchronously and a plugin may register before it lands, so a
     * registration made a moment too early must not stay unverified forever.
     * @param entry - the stored registration.
     * @returns the same registration with the current verdict.
     */
    private judge;
}
