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
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
// Type-only: brings the `ctx.typert` Context merge into this program.
import type {} from '@deepseek-ai/dsh-typert-registry'
// Type-only: brings the `ctx.settings` and `ctx.agents` Context merges in.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: brings the `ctx.sessionReferenceResolver` Context merge in.
import type {} from '@deepseek-ai/dsh-session-reference'
import { encodeSessionReferenceUri, SessionReferenceResolver } from '@deepseek-ai/dsh-session-reference'
import { AtFileRuntime, AtlasRuntime, AtMentionRuntime, type MentionRuntimeDeps } from './runtime.ts'
import { TYPERT_MANIFEST } from './typert.ts'
import { registerAtFileSettings } from './settings.ts'
import { mentionPreStep, type ReferenceExpansion } from './mention.ts'
import {
  expandChatMentions,
  expandAtlasMentions,
  expandPluginMentions,
  expandSkillMentions,
  type ChatResolver,
} from './references.ts'
import {
  DEFAULT_IGNORE_DIRS,
  MAX_USAGE_ENTRIES,
  externalLedgerFor,
  normalizeExternalRefs,
  normalizeIgnoreFiles,
  normalizeWorkspaceIgnoreFiles,
  normalizeWorkspaceRecentFiles,
  recordExternalRef,
} from './defaults.ts'
import { externalAccess, type ExternalAccess } from './external.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerMentionTools } from './tools.ts'
import type { AtFileSettings, AtFileSettingsUpdate, ChatCandidate, PluginCandidate, SkillCandidate, SkillTier } from './contract.ts'
import type { ResolvedConfig } from './types.ts'

/** Cordis plugin name (the Loader entry and client bundle id). */
export const name = 'dsh-atlas'

/** Services required before load: the Typert registry, the settings provider, and the agent registry. */
export const inject = ['typert', 'settings', 'agents']

export { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES } from './defaults.ts'
/**
 * The public `@` seam surface, for a plugin that wants to register a source.
 *
 * `ctx.get('atlas')` is the handle; `AtlasSeam` is the shape to cast it to. A
 * provider's declaration uses `AtlasProvider`/`AtlasItem`, and both halves type
 * against the same `AtlasCallContext`.
 */
export type { AtlasCallContext, AtlasItem, AtlasProvider, AtlasRegistration, AtlasSeam } from './atlas.ts'

/** Host plugin configuration, validated at load by the Loader. */
export interface Config {
  /** Hard cap on indexed files per workspace; the walk stops and reports truncation. */
  maxIndexedFiles: number
  /** Directory basenames the index walk skips entirely. */
  ignoreDirs: string[]
  /** When true, a recognized @skill mention also injects the skill body. */
  injectSkillBody: boolean
}

/**
 * Configuration schema: deployment-varying bounds stay tunable from
 * the profile patch. The inferred schema type keeps the callable form accepting
 * partial input, so `Config({})` yields the defaults (what the Loader does
 * for Loader compositions).
 */
export const Config = z.object({
  maxIndexedFiles: z.natural().min(1).default(2000),
  ignoreDirs: z.array(z.string()).default([...DEFAULT_IGNORE_DIRS]),
  injectSkillBody: z.boolean().default(false),
})

/** Providers whose bundled skills are system skills (same set as the sidebar Skill Manager). */
export const SYSTEM_BUNDLED_PROVIDERS = new Set(['filesystem', 'dsh-badge'])

/** Host-side TTL for past-chat candidate scans (the resolver is per-agent). */
const CHAT_CACHE_TTL_MS = 30_000

/** Per-agent+query past-chat candidate cache: { at, value }. */
const chatCache = new Map<string, { at: number; value: readonly ChatCandidate[] }>()

/** In-flight past-chat scans (concurrent windows share ONE host scan). */
const chatInFlight = new Map<string, Promise<readonly ChatCandidate[]>>()

/** Host-side TTL for skill discovery scans (the registry discovery is per-agent). */
const SKILL_CACHE_TTL_MS = 30_000

/** Per-agent skill candidate cache: { at, value }. */
const skillCache = new Map<string, { at: number; value: readonly SkillCandidate[] }>()

/** In-flight skill scans (concurrent windows share ONE host scan). */
const skillInFlight = new Map<string, Promise<readonly SkillCandidate[]>>()

/** Host-side TTL for the plugin inventory read. */
const PLUGIN_CACHE_TTL_MS = 30_000

/** Plugin candidate cache: { at, value } (the inventory is process-global). */
let pluginCache: { at: number; value: readonly PluginCandidate[] } | undefined

/** In-flight plugin read (concurrent windows share one inventory read). */
let pluginInFlight: Promise<readonly PluginCandidate[]> | undefined

/**
 * Map a skill registry source (and its owning provider) onto the management
 * tiers shown by the sidebar Skill Manager: system / user / project / custom /
 * plugin. Bundled skills from the filesystem/badge providers are system;
 * bundled skills from any other provider come from a plugin's own tree.
 */
export function skillTier(source: string | undefined, provider: string | undefined): SkillTier {
  if (source === 'user-dsh' || source === 'user-agents') return 'user'
  if (source === 'project-dsh' || source === 'project-agents') return 'project'
  if (source === 'bundled') {
    return provider !== undefined && SYSTEM_BUNDLED_PROVIDERS.has(provider) ? 'system' : 'plugin'
  }
  return 'custom'
}

/** The `ctx.skills` service face this plugin needs (structural; optional). */
interface SkillsServiceFace {
  list(options: { cwd?: string; signal?: AbortSignal }): Promise<readonly {
    name: string
    description: string
    source?: string
    provider?: string
  }[]>
  get(name: string, options: { cwd?: string; signal?: AbortSignal }): Promise<{ body?: string } | undefined>
}

/** One `ctx.pluginInventory` row this plugin consumes (extra Harness fields are ignored). */
interface PluginInventoryEntry {
  readonly moduleName: string
  readonly enabled: boolean
}

/**
 * The `ctx.pluginInventory` service face this plugin needs (structural; optional).
 * The Harness gateway declares `@Remote('list') async list()`, so `list()` MUST be
 * awaited; the sync arm stays accepted because this face is structural and a stub
 * may return the snapshot directly.
 */
interface PluginInventoryFace {
  list(): { entries: readonly PluginInventoryEntry[] } | Promise<{ entries: readonly PluginInventoryEntry[] }>
}

/**
 * Build the settings-gated category expansions for one agent. Pure wiring:
 * the expansion behavior lives in src/references.ts (unit-tested).
 * @param ctx - the plugin context (service access).
 * @param agent - the addressed live agent.
 * @param resolved - resolved plugin configuration.
 * @param readSettings - live settings read.
 */
export function buildReferenceExpansion(
  ctx: Context,
  agent: { readonly id: unknown } & {
    readonly session: { readonly id: SessionId; readonly header: { readonly cwd?: string } }
  },
  resolved: ResolvedConfig & { injectSkillBody: boolean },
  readSettings: () => AtFileSettings,
): ReferenceExpansion {
  const expandChats = async (messages: Parameters<ReferenceExpansion['expandChats']>[0], signal: AbortSignal) => {
    if (!readSettings().enableChats) return undefined
    const resolver = ctx.get('sessionReferenceResolver') as ChatResolver | undefined
    if (resolver === undefined) return undefined
    return expandChatMentions(agent as never, resolver, messages, signal)
  }
  const expandSkills = async (messages: Parameters<ReferenceExpansion['expandSkills']>[0], signal: AbortSignal) => {
    if (!readSettings().enableSkills) return []
    const skills = ctx.get('skills') as SkillsServiceFace | undefined
    if (skills === undefined) return []
    const cwd = agent.session.header.cwd
    const summaries = await skills.list({ cwd, signal })
    const known = new Set(summaries.map(summary => summary.name))
    return expandSkillMentions(messages, name => known.has(name), signal, resolved.injectSkillBody
      ? async name => (await skills.get(name, { cwd, signal }))?.body
      : undefined)
  }
  const expandPlugins = async (messages: Parameters<ReferenceExpansion['expandPlugins']>[0], signal: AbortSignal) => {
    if (!readSettings().enablePlugins) return []
    const inventory = ctx.get('pluginInventory') as PluginInventoryFace | undefined
    if (inventory === undefined) return []
    const snapshot = await inventory.list()
    const enabled = new Set(snapshot.entries.filter(entry => entry.enabled).map(entry => entry.moduleName))
    return expandPluginMentions(messages, moduleName => enabled.has(moduleName), signal)
  }
  // The @ data-source seam: a registered provider's `resolve` supplies the body,
  // and we only place it in the step. Nothing is read or persisted on our side.
  const expandAtlas = async (
    messages: Parameters<ReferenceExpansion['expandChats']>[0],
    signal: AbortSignal,
  ) => {
    const runtime = ctx.get('atlas') as AtlasRuntime | undefined
    if (runtime === undefined) return []
    return expandAtlasMentions(
      messages,
      { sessionId: agent.session.id, cwd: agent.session.header.cwd, signal },
      providerId => runtime.registrations().find(entry => entry.id === providerId),
    )
  }
  return { expandChats, expandSkills, expandPlugins, expandAtlas }
}

/**
 * Mount the atFile/atMention services and the pre-step reference markers.
 * @param ctx - host cordis context.
 * @param config - validated plugin configuration (schema defaults applied).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = Config(config ?? {})
  // The durable enable switch: the runtime and the boundary read its live
  // value per call, so toggling it in the Web settings takes effect immediately.
  const settings = registerAtFileSettings(ctx)
  const readSettings = () => settings.get()
  const writeSettings = async (update: AtFileSettingsUpdate) => {
    if (update.field === 'enabled') {
      await settings.update({ enabled: update.value })
    } else if (update.field === 'ignoreFiles') {
      await settings.update({ ignoreFiles: normalizeIgnoreFiles(update.value) })
    } else if (update.field === 'workspaceIgnoreFiles') {
      await settings.update({
        workspaceIgnoreFiles: normalizeWorkspaceIgnoreFiles(update.value),
      })
    } else if (update.field === 'enableSkills') {
      await settings.update({ enableSkills: update.value })
    } else if (update.field === 'enableChats') {
      await settings.update({ enableChats: update.value })
    } else if (update.field === 'enablePlugins') {
      await settings.update({ enablePlugins: update.value })
    } else if (update.field === 'candidateLimit') {
      await settings.update({ candidateLimit: update.value })
    } else if (update.field === 'recentFiles') {
      await settings.update({ recentFiles: normalizeWorkspaceRecentFiles(update.value) })
    } else if (update.field === 'usage') {
      // Cross-category pick counters: highest count first, tail dropped.
      await settings.update({
        usage: [...update.value]
          .sort((a, b) => b.count - a.count || b.at - a.at)
          .slice(0, MAX_USAGE_ENTRIES),
      })
    } else if (update.field === 'externalRefs') {
      // The out-of-workspace ledger: deduplicated by canonical path, newest first.
      await settings.update({ externalRefs: normalizeExternalRefs(update.value) })
    } else if (update.field === 'folderOpen') {
      await settings.update({ folderOpen: update.value })
    } else {
      await settings.update({ ignorePastedMentions: update.value })
    }
    return settings.get()
  }
  // The web profile's dsh-base does not mount the official cross-session
  // snapshot service; mount it here when absent so @past chats resolve.
  if (ctx.get('sessionReferenceResolver') === undefined) {
    ctx.plugin(SessionReferenceResolver, {})
  }
  // Out-of-workspace references (see src/external.ts). The verdict is the HOST's:
  // the resolved sandbox mode for this session decides whether it may discover
  // external paths at all, and the ledger supplies the ones a narrower mode may
  // still use. No `sandboxPolicy` service (an older host) means ledger only.
  const sandboxPolicy = ctx.get('sandboxPolicy') as
    | { resolve(request?: { session?: unknown }): { mode?: string } }
    | undefined
  const externalAccessFor = (agent: Agent): ExternalAccess => {
    const cwd = agent.session.header.cwd ?? ''
    const mode = sandboxPolicy?.resolve({ session: agent.session })?.mode
    const ledger = externalLedgerFor(readSettings(), cwd)
    return externalAccess(mode, ledger.roots, ledger.known)
  }
  new AtFileRuntime(ctx, resolved, readSettings, writeSettings, externalAccessFor)
  const mentionDeps: MentionRuntimeDeps = {
    listSkills: async (agent, signal): Promise<readonly SkillCandidate[]> => {
      if (!readSettings().enableSkills) return []
      const skills = ctx.get('skills') as SkillsServiceFace | undefined
      if (skills === undefined) return []
      // The first skill discovery scans every provider tree and can take a
      // while; cache per agent for a TTL so repeated @skill: opens are instant.
      const cacheKey = String(agent.id)
      const cached = skillCache.get(cacheKey)
      if (cached !== undefined && Date.now() - cached.at < SKILL_CACHE_TTL_MS) {
        return cached.value
      }
      const inflight = skillInFlight.get(cacheKey)
      if (inflight !== undefined) return inflight
      const run = async (): Promise<readonly SkillCandidate[]> => {
        const summaries = await skills.list({ cwd: agent.session.header.cwd, signal })
        const mapped = summaries.map(summary => ({
          name: summary.name,
          description: summary.description,
          tier: skillTier(summary.source, summary.provider),
        }))
        skillCache.set(cacheKey, { at: Date.now(), value: mapped })
        return mapped
      }
      const promise = run()
      skillInFlight.set(cacheKey, promise)
      void promise.then(
        () => { if (skillInFlight.get(cacheKey) === promise) skillInFlight.delete(cacheKey) },
        () => { if (skillInFlight.get(cacheKey) === promise) skillInFlight.delete(cacheKey) },
      )
      return promise
    },
    listChats: async (agent, query, limit, signal): Promise<readonly ChatCandidate[]> => {
      if (!readSettings().enableChats) return []
      const resolver = ctx.get('sessionReferenceResolver') as {
        listCandidates(agent: unknown, query: string, limit: number, signal: AbortSignal): Promise<readonly {
          sessionId: string
          label: string
          cwd?: string
          createdAt: number
        }[]>
      } | undefined
      if (resolver === undefined) return []
      // The candidate scan can be slow; cache per agent+query for a TTL so
      // repeated @chat: opens and instant collapse rebuilds skip the round-trip.
      const cacheKey = `${String(agent.id)}|${query}`
      const cached = chatCache.get(cacheKey)
      if (cached !== undefined && Date.now() - cached.at < CHAT_CACHE_TTL_MS) {
        return cached.value
      }
      const inflight = chatInFlight.get(cacheKey)
      if (inflight !== undefined) return inflight
      const run = async (): Promise<readonly ChatCandidate[]> => {
        const candidates = await resolver.listCandidates(agent, query, limit, signal)
        const mapped = candidates.map(candidate => ({
        sessionId: candidate.sessionId,
        label: candidate.label,
        // The resolver face is structural; the branded SessionId lives on the
        // wire value and the encoder accepts it at runtime.
        uri: encodeSessionReferenceUri(candidate.sessionId as never),
        ...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
        createdAt: candidate.createdAt,
      }))
        chatCache.set(cacheKey, { at: Date.now(), value: mapped })
        return mapped
      }
      const promise = run()
      chatInFlight.set(cacheKey, promise)
      void promise.then(
        () => { if (chatInFlight.get(cacheKey) === promise) chatInFlight.delete(cacheKey) },
        () => { if (chatInFlight.get(cacheKey) === promise) chatInFlight.delete(cacheKey) },
      )
      return promise
    },
    listPlugins: async (signal): Promise<readonly PluginCandidate[]> => {
      if (!readSettings().enablePlugins) return []
      const inventory = ctx.get('pluginInventory') as PluginInventoryFace | undefined
      if (inventory === undefined) return []
      const cached = pluginCache
      if (cached !== undefined && Date.now() - cached.at < PLUGIN_CACHE_TTL_MS) {
        return cached.value
      }
      const inflight = pluginInFlight
      if (inflight !== undefined) return inflight
      const run = async (): Promise<readonly PluginCandidate[]> => {
        const snapshot = await inventory.list()
        const value = snapshot.entries.map(entry => ({
          entryId: entry.moduleName,
          moduleName: entry.moduleName,
          enabled: entry.enabled,
        }))
        pluginCache = { at: Date.now(), value }
        return value
      }
      const promise = run()
      pluginInFlight = promise
      void promise.then(
        () => { if (pluginInFlight === promise) pluginInFlight = undefined },
        () => { if (pluginInFlight === promise) pluginInFlight = undefined },
      )
      return promise
    },
  }
  new AtMentionRuntime(ctx, mentionDeps)
  // The @ data-source seam's Host half: the facts a provider's `testedOn` claim
  // is judged against, and the landing point for the Host-half provider registry.
  new AtlasRuntime(ctx)
  // Strict endpoint registration: the gateway resolves atFile/* and
  // atMention/* from these manifests, independent of decorator marker state.
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => { void dispose() }
  }, 'dsh-atlas: typert manifest')

  // Model-facing on-demand tools for the mentioned categories: the chat that
  // used a @past-chat / @plugin reference can query it later.
  ctx.effect(() => {
    const disposers = registerMentionTools(ctx, readSettings) ?? []
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-atlas: mention tools')

  // Mark @ references for every agent, at its pre-step boundary. The
  // listener lives on the agent's scope (the event is agent-scoped), so it
  // registers per created agent and withdraws with it. The boundary logic is
  // `mentionPreStep` (unit-tested); this is the scoped lifecycle glue.
  /* v8 ignore start -- agent-scoped registration glue; the boundary behavior is mentionPreStep and the event plumbing is harness-owned. */
  /* v8 ignore next -- callback executes only for live Harness Agent creation. */
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => {
      const stop = agent.ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
        return mentionPreStep(
          agent,
          () => settings.get().enabled,
          messages,
          signal,
          next,
          () => settings.get().ignorePastedMentions ?? true,
          buildReferenceExpansion(ctx, agent, resolved, readSettings),
          externalAccessFor(agent),
          // Every external path that actually reaches the model is remembered, so
          // a narrower mode can offer it again without searching anything.
          mention => {
            const cwd = agent.session.header.cwd ?? ''
            void writeSettings({
              field: 'externalRefs',
              value: recordExternalRef(readSettings(), mention.relative, mention.kind, cwd, Date.now()),
            }).catch(() => undefined)
          },
        )
      })
      return () => { stop() }
    }, 'dsh-atlas: pre-step references')
  })
  /* v8 ignore stop */
}