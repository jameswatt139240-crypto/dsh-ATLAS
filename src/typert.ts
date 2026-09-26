/**
 * The hand-written host Typert manifest for the atFile and atMention Remote
 * namespaces. Registered through `ctx.typert.register` in the plugin body,
 * it claims every wire endpoint through the strict registry — the same path
 * generated `./typert` artifacts use — so the Host Gateway resolves search,
 * settings, and category picks without consulting the `@Remote` marker
 * table. That marker independence matters in the harness's source-launch
 * development environment, where the tsx-loaded gateway and a profile-loaded
 * plugin bundle can hold separate copies of the decorator module state.
 */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { AT_FILE_INVOCATIONS, AT_MENTION_INVOCATIONS, ATLAS_INVOCATIONS } from './contract.ts'

/** The host manifest: one package, two service namespaces (strict codecs shared with the client). */
export const TYPERT_MANIFEST: TypertContribution = {
  package: 'dsh-atlas',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'atFile',
        exportName: 'AtFileRuntime',
        description: 'Workspace path search and durable settings for the @file picker.',
        tags: [],
        members: [
          {
            kind: 'method',
            name: 'search',
            signature: 'search(agent: Agent, signal: AbortSignal): Promise<readonly FileEntry[]>',
          },
          {
            kind: 'method',
            name: 'inspect',
            signature: 'inspect(agent: Agent, targets: readonly string[], signal: AbortSignal): Promise<readonly ReferenceInfo[]>',
          },
          {
            kind: 'method',
            name: 'getSettings',
            signature: 'getSettings(): AtFileSettings',
          },
          {
            kind: 'method',
            name: 'updateSettings',
            signature: 'updateSettings(update: AtFileSettingsUpdate): Promise<AtFileSettings>',
          },
          {
            kind: 'method',
            name: 'external',
            signature: 'external(agent: Agent, signal: AbortSignal): Promise<ExternalAccessScope>',
          },
          {
            kind: 'method',
            name: 'list',
            signature: 'list(agent: Agent, path: string, signal: AbortSignal): Promise<DirectoryListing>',
          },
        ],
        types: [],
      },
      {
        key: 'atMention',
        exportName: 'AtMentionRuntime',
        description: 'Category pickers for @ mentions: skills, past chats, and plugins.',
        tags: [],
        members: [
          {
            kind: 'method',
            name: 'listSkills',
            signature: 'listSkills(agent: Agent, signal: AbortSignal): Promise<readonly SkillCandidate[]>',
          },
          {
            kind: 'method',
            name: 'listChats',
            signature: 'listChats(agent: Agent, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]>',
          },
          {
            kind: 'method',
            name: 'listPlugins',
            signature: 'listPlugins(signal: AbortSignal): Promise<readonly PluginCandidate[]>',
          },
        ],
        types: [],
      },
      {
        key: 'atlas',
        exportName: 'AtlasRuntime',
        description: 'Host half of the @ data-source seam: the running facts a provider\'s compatibility claim is judged against, and the built-in @git source\'s candidate list.',
        tags: [],
        members: [
          {
            kind: 'method',
            name: 'runtime',
            signature: 'runtime(signal: AbortSignal): AtlasRuntimeInfo',
          },
          {
            kind: 'method',
            name: 'gitChanges',
            signature: 'gitChanges(agent: Agent, signal: AbortSignal): Promise<readonly GitChange[]>',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [...AT_FILE_INVOCATIONS, ...AT_MENTION_INVOCATIONS, ...ATLAS_INVOCATIONS],
}
