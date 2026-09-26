/**
 * The dsh-atlas host Remote service (`ctx.atFile`, wire namespace `atFile`).
 * Registered as a TypertRemoteService so the Host Gateway's source-mode
 * discovery exports its @Remote methods to the Web client under
 * `/api/atFile/<method>` with zero generated artifacts: `search` takes the
 * resolved live Agent (the `agent` Typert lookup) and indexes its workspace.
 * File content never crosses this wire or the Host mention boundary; the
 * plugin only indexes and marks user-selected paths.
 */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ExternalAccess } from './external.ts';
import type { DirectoryListing, ExternalAccessScope } from './contract.ts';
import type { AtFileSettings, AtFileSettingsUpdate, ChatCandidate, FileEntry, GitChange, PluginCandidate, ReferenceInfo, SkillCandidate } from './contract.ts';
import type { ResolvedConfig } from './types.ts';
import { type AtlasRegistration, type AtlasRuntimeInfo } from './atlas.ts';
/** At-file workspace service: search the cwd index for the browser picker. */
export declare class AtFileRuntime extends TypertRemoteService {
    private readonly config;
    private readonly readSettings;
    private readonly writeSettings;
    /** The session's out-of-workspace access (see src/external.ts). */
    private readonly externalAccessFor;
    /** Host-side workspace index cache: { at, value } per cwd+filter key. */
    private readonly fileCache;
    /** In-flight index walks (concurrent windows share ONE workspace scan). */
    private readonly fileInFlight;
    /**
     * Register the service under the `atFile` key (the wire namespace).
     * @param ctx - owning cordis context.
     * @param config - resolved plugin configuration.
     * @param isEnabled - live settings read; false refuses the endpoint.
     */
    constructor(ctx: Context, config: ResolvedConfig, readSettings: () => AtFileSettings, writeSettings: (update: AtFileSettingsUpdate) => Promise<AtFileSettings>, 
    /** The session's out-of-workspace access (see src/external.ts). */
    externalAccessFor?: (agent: Agent) => ExternalAccess);
    /** One TTL for the workspace index cache (matches the client cache). */
    private static readonly FILE_CACHE_TTL_MS;
    /** Read the resolved durable settings through the plugin-owned wire. */
    getSettings(): AtFileSettings;
    /** Persist one settings field and return the resolved section. */
    updateSettings(update: AtFileSettingsUpdate): Promise<AtFileSettings>;
    /**
     * Index the addressed agent's workspace and return the bounded entry list.
     * The client caches the list per session and filters per keystroke.
     * @param agent - the live agent resolved from the `agentId` wire field; its
     *   session header owns the workspace cwd.
     * @param signal - caller lifetime; the walk races it.
     * @returns workspace-root-relative entries with their absolute paths.
     */
    search(agent: Agent, signal: AbortSignal): Promise<readonly FileEntry[]>;
    /**
     * Inspect referenced workspace paths: existence, kind, and byte size only.
     * The dock uses this to price a reference and to flag one that no longer
     * resolves. Entry metadata is the only thing read; file content stays unopened.
     * @param agent - the live agent resolved from the `agentId` wire field; its
     *   session header owns the workspace cwd.
     * @param targets - workspace-relative paths, already stripped of line ranges.
     * @param signal - caller lifetime.
     * @returns one row per requested path, in request order.
     */
    inspect(agent: Agent, targets: readonly string[], signal: AbortSignal): Promise<readonly ReferenceInfo[]>;
    /**
     * The out-of-workspace scope for one session, plus the folder rows `@folder:`
     * may offer for it.
     *
     * Two sources, both bounded and neither a search: the directories the ledger
     * already knows (usable in EVERY mode — they are paths the user referenced
     * themselves), and, only where the session may discover external paths, the
     * sibling directories of the workspace. That second list is one `opendir` of
     * one directory: it is how a plugin author reaches the DSH source tree next to
     * the workspace without any whole-disk walk.
     * @param agent - the live agent; its session header owns the workspace cwd.
     * @param signal - caller lifetime.
     * @returns the scope verdict and the folder rows to offer.
     */
    external(agent: Agent, signal: AbortSignal): Promise<ExternalAccessScope>;
    /**
     * One bounded, one-level listing of one directory, for the folder browser and
     * the folder tab.
     *
     * `''` means the session's workspace root, which is where a browser starts. A
     * workspace path is always allowed; an out-of-workspace one goes through the
     * SAME gate as a reference (`allowsExternal`), so browsing can never see a path
     * the session may not reference — and the refusal comes back as a reason rather
     * than a thrown error, because "this folder is outside the workspace" is a fact
     * the browser has to say in its own words instead of an exception.
     * @param agent - the live agent; its session header owns the workspace cwd.
     * @param path - absolute path, workspace-relative path, or `''` for the root.
     * @param signal - caller lifetime.
     * @returns the listing, or the reason it could not be produced.
     */
    list(agent: Agent, path: string, signal: AbortSignal): Promise<DirectoryListing>;
}
/** Host-side capability faces the atMention service forwards to. */
export interface MentionRuntimeDeps {
    /** List discoverable skills for the @skill picker (settings-gated). */
    listSkills(agent: Agent, signal: AbortSignal): Promise<readonly SkillCandidate[]>;
    /** List past-session candidates for the @chat picker (settings-gated). */
    listChats(agent: Agent, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]>;
    /** List installed plugin entries for the @plugin picker (settings-gated). */
    listPlugins(signal: AbortSignal): Promise<readonly PluginCandidate[]>;
}
/**
 * The dsh-atlas host Remote service (`ctx.atMention`, wire namespace
 * `atMention`). Registered as a TypertRemoteService so the Host Gateway
 * exports its @Remote methods to the Web client under
 * `/api/atMention/<method>`: skills and past chats resolve the live Agent
 * (the `agent` Typert lookup); plugins need no agent. Every method is a
 * thin pass-through to the wiring closures so the boundary stays unit-testable
 * without an assembled Cordis scope.
 */
export declare class AtMentionRuntime extends TypertRemoteService {
    private readonly deps;
    /**
     * Register the service under the `atMention` key (the wire namespace).
     * @param ctx - owning cordis context.
     * @param deps - settings-gated capability closures wired in apply().
     */
    constructor(ctx: Context, deps: MentionRuntimeDeps);
    /** List discoverable skills for the @skill picker. */
    listSkills(agent: Agent, signal: AbortSignal): Promise<readonly SkillCandidate[]>;
    /** List past-session candidates for the @chat picker. */
    listChats(agent: Agent, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]>;
    /** List installed plugin entries for the @plugin picker. */
    listPlugins(signal: AbortSignal): Promise<readonly PluginCandidate[]>;
}
/**
 * The `@` seam's Host-half service (`ctx.atlas`, wire namespace `atlas`).
 *
 * The seam has two halves because DSH plugins do: the browser half answers
 * `list` for the open menu, while this half answers `resolve` when a committed
 * reference becomes model-visible text. This service reports the facts a
 * provider's `testedOn` claim is judged against, and is where the Host-half
 * provider registry lands as the seam grows.
 */
export declare class AtlasRuntime extends TypertRemoteService {
    private readonly readVersion;
    /** The Host half of the seam: provides `resolve`, the injection-side callback. */
    private readonly registry;
    /**
     * Register the service under the `atlas` key (the wire namespace).
     * @param ctx - owning cordis context.
     * @param readVersion - how to establish the running DSH version; injectable so
     *   an unresolvable install stays testable.
     */
    constructor(ctx: Context, readVersion?: () => string | undefined);
    /**
     * The running Harness facts for the version gate.
     * @returns the version when established, otherwise an empty record.
     */
    private facts;
    /**
     * Register one provider's injection half. This is a plain local call (not a
     * wire endpoint): the provider authorizes us by calling it, and the returned
     * disposer withdraws it.
     * @param candidate - the provider declaration, which must carry `resolve`.
     * @returns the disposer that withdraws the registration.
     */
    register(candidate: unknown): () => void;
    /** The live injection-side registrations, in registration order. */
    registrations(): readonly AtlasRegistration[];
    /**
     * Report the running Harness facts.
     * @param signal - caller lifetime.
     * @returns the version when it could be established, otherwise an empty record
     *   (an unknown version must never read as a matching one).
     */
    runtime(signal: AbortSignal): AtlasRuntimeInfo;
    /**
     * The addressed workspace's changed paths — the built-in `@git` provider's
     * candidate list. The browser half filters this per keystroke, so the answer
     * is the whole bounded list rather than a server-side search.
     * @param agent - the live agent resolved from the `agentId` wire field.
     * @param signal - caller lifetime.
     * @returns the changes, or an empty list outside a Git workspace.
     */
    gitChanges(agent: Agent, signal: AbortSignal): Promise<readonly GitChange[]>;
}
