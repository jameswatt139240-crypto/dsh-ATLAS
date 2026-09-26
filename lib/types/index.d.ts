/**
 * dsh-atlas host plugin: mounts the `atFile` and `atMention` Typert
 * Remote services (workspace search + category pickers), registers their
 * strict Typert manifests and the settings namespace, mounts the official
 * cross-session snapshot service when the profile has not, and marks every
 * @ mention category (path, skill, past chat, plugin) at each agent's
 * pre-step boundary. The plugin never reads mentioned file contents. The
 * client half ships in the same package (`./client`); the web server serves
 * it under /plugins/dsh-atlas/client.js.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import z from '@deepseek-ai/schemastery';
import { type ReferenceExpansion } from './mention.ts';
import type { AtFileSettings, SkillTier } from './contract.ts';
import type { ResolvedConfig } from './types.ts';
/** Cordis plugin name (the Loader entry and client bundle id). */
export declare const name = "dsh-atlas";
/** Services required before load: the Typert registry, the settings provider, and the agent registry. */
export declare const inject: string[];
export { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES } from './defaults.ts';
/**
 * The public `@` seam surface, for a plugin that wants to register a source.
 *
 * `ctx.get('atlas')` is the handle; `AtlasSeam` is the shape to cast it to. A
 * provider's declaration uses `AtlasProvider`/`AtlasItem`, and both halves type
 * against the same `AtlasCallContext`.
 */
export type { AtlasCallContext, AtlasItem, AtlasProvider, AtlasRegistration, AtlasSeam } from './atlas.ts';
/** Host plugin configuration, validated at load by the Loader. */
export interface Config {
    /** Hard cap on indexed files per workspace; the walk stops and reports truncation. */
    maxIndexedFiles: number;
    /** Directory basenames the index walk skips entirely. */
    ignoreDirs: string[];
    /** When true, a recognized @skill mention also injects the skill body. */
    injectSkillBody: boolean;
}
/**
 * Configuration schema: deployment-varying bounds stay tunable from
 * the profile patch. The inferred schema type keeps the callable form accepting
 * partial input, so `Config({})` yields the defaults (what the Loader does
 * for Loader compositions).
 */
export declare const Config: z<Schemastery.ObjectS<{
    maxIndexedFiles: z<number, number>;
    ignoreDirs: z<string[], string[]>;
    injectSkillBody: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    maxIndexedFiles: z<number, number>;
    ignoreDirs: z<string[], string[]>;
    injectSkillBody: z<boolean, boolean>;
}>>;
/** Providers whose bundled skills are system skills (same set as the sidebar Skill Manager). */
export declare const SYSTEM_BUNDLED_PROVIDERS: Set<string>;
/**
 * Map a skill registry source (and its owning provider) onto the management
 * tiers shown by the sidebar Skill Manager: system / user / project / custom /
 * plugin. Bundled skills from the filesystem/badge providers are system;
 * bundled skills from any other provider come from a plugin's own tree.
 */
export declare function skillTier(source: string | undefined, provider: string | undefined): SkillTier;
/**
 * Build the settings-gated category expansions for one agent. Pure wiring:
 * the expansion behavior lives in src/references.ts (unit-tested).
 * @param ctx - the plugin context (service access).
 * @param agent - the addressed live agent.
 * @param resolved - resolved plugin configuration.
 * @param readSettings - live settings read.
 */
export declare function buildReferenceExpansion(ctx: Context, agent: {
    readonly id: unknown;
} & {
    readonly session: {
        readonly id: SessionId;
        readonly header: {
            readonly cwd?: string;
        };
    };
}, resolved: ResolvedConfig & {
    injectSkillBody: boolean;
}, readSettings: () => AtFileSettings): ReferenceExpansion;
/**
 * Mount the atFile/atMention services and the pre-step reference markers.
 * @param ctx - host cordis context.
 * @param config - validated plugin configuration (schema defaults applied).
 */
export declare function apply(ctx: Context, config?: Config): void;
