/**
 * The dsh-atlas wire contracts, shared verbatim by the host manifests
 * (`ctx.typert.register` in typert.ts) and the client contributions
 * (`ctx.remote.$mount` in client/remote.ts). The `atFile` namespace keeps
 * workspace index search and plugin-owned settings access; the `atMention`
 * namespace serves the category pickers (skills, past chats, plugins).
 * File bytes never cross this boundary; the Host only marks validated
 * references at `agent/pre-step`.
 */
import { z } from 'zod'
import type { InvocationDescriptor, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Dual-form strict codec. Two Harness generations disagree on the strict-codec
 * shape: the installed build validates `codec.schema.parse`, while the source
 * checkout validates `codec.create()`. Carrying both fields satisfies either
 * validator — each ignores the other's field — and the wire format is
 * unchanged.
 */
interface StrictCodec {
  readonly mode: 'strict'
  readonly typeSymbol: string
  readonly create: () => TypertSchema
  readonly schema: TypertSchema
}

/**
 * Build one dual-form strict codec.
 * @param typeSymbol - generated schema identity (`<package>#<name>`).
 * @param schema - the schema validating this boundary value.
 * @returns a codec accepted by both Harness codec validators.
 */
function strictCodec(typeSymbol: string, schema: TypertSchema): StrictCodec {
  return { mode: 'strict', typeSymbol, create: () => schema, schema }
}

/** One indexed workspace entry (a file or a directory), with its display path. */
export interface FileEntry {
  readonly path: string
  readonly relative: string
  readonly kind: 'file' | 'dir'
}

/** Skill management tier (mirrors the sidebar Skill Manager grouping). */
export type SkillTier = 'system' | 'user' | 'project' | 'custom' | 'plugin'

/** One discoverable skill for the @skill mention picker. */
export interface SkillCandidate {
  readonly name: string
  readonly description: string
  /** Grouping tier (system/user/project/custom/plugin). */
  readonly tier: SkillTier
}

/** One discoverable past session for the @chat mention picker. */
export interface ChatCandidate {
  readonly sessionId: string
  readonly label: string
  /** Host-built `dsh-session:<...>` mention URI (the browser never encodes it). */
  readonly uri: string
  readonly cwd?: string
  readonly createdAt: number
}

/** One installed plugin entry for the @plugin mention picker. */
export interface PluginCandidate {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
}

/** One changed workspace path, as the built-in `@git` provider reports it. */
export interface GitChange {
  /** Repository-relative path; also the item id that travels in `@git/…`. */
  readonly path: string
  /** Porcelain status: `M`, `A`, `D`, `R`, `??`, … */
  readonly status: string
  /** Lines added against HEAD when Git could count them (absent for binaries). */
  readonly added?: number
  readonly removed?: number
}

/**
 * Read-only facts about one referenced workspace path. `size` comes from the
 * directory entry; the Host never opens the file to compute it, which is what
 * lets the dock price a reference without breaking "paths only, never content".
 */
export interface ReferenceInfo {
  /** The workspace-relative path as requested (no leading `@`, no line range). */
  readonly relative: string
  /** Whether the path resolves inside the workspace to an existing entry. */
  readonly exists: boolean
  /** Entry kind; present only when the path exists. */
  readonly kind?: 'file' | 'dir'
  /** Byte size of a file entry (directory-entry metadata only). */
  readonly size?: number
  /**
   * True when `relative` is an out-of-workspace path this session is allowed to
   * reference (`src/external.ts`). The dock marks those rows so an external
   * reference is never mistaken for a workspace one.
   */
  readonly outside?: true
}

/**
 * One out-of-workspace path the user has actually referenced, kept so the menu
 * can offer it again without searching anything.
 *
 * Only the path and its usage metadata are stored — never file content, and
 * never a directory listing.
 */
export interface ExternalRef {
  /** Canonical absolute path with forward slashes. */
  readonly path: string
  /** What it was referenced as; only directories can become search roots. */
  readonly kind: 'file' | 'dir'
  /** How many times it has been referenced. */
  readonly count: number
  /** Epoch milliseconds of the last reference. */
  readonly lastUsedAt: number
  /** Workspaces it was referenced from, most recent first (bounded). */
  readonly workspaces?: readonly string[]
}

/**
 * What one session may do with out-of-workspace paths, plus the folder rows
 * `@folder:` may offer. Computed by the Host (settings + the resolved sandbox
 * policy), never by the browser.
 */
export interface ExternalAccessScope {
  /** Whether this session may reference paths the ledger does not know yet. */
  readonly canDiscover: boolean
  /** Ledger directories this session may reference into (canonical paths). */
  readonly roots: readonly string[]
  /** Folder rows to offer, each an absolute path outside the workspace. */
  readonly folders: readonly string[]
}

/** One row of a one-level directory listing. */
export interface DirectoryEntry {
  readonly name: string
  readonly kind: 'file' | 'dir'
}

/** Why a directory could not be listed (the browser says which, in its own words). */
export type DirectoryRefusal = 'outside' | 'missing' | 'notDirectory'

/**
 * One bounded, one-level directory listing.
 *
 * `path` is the canonical spelling of the listed directory (forward slashes); it
 * carries a trailing separator ONLY when it is a drive root (`E:/`), so a child is
 * always `${path}/${name}` and nobody has to remember which case they are in.
 * `parent` is absent exactly at a drive root, where `drives` takes its place —
 * which is how a browser leaves the drive it started on.
 */
export interface DirectoryListing {
  readonly path: string
  readonly parent?: string
  readonly entries: readonly DirectoryEntry[]
  readonly truncated?: true
  readonly drives?: readonly string[]
  readonly error?: DirectoryRefusal
}

/** One file filter. Legacy string values remain accepted as exact, insensitive rules. */
export interface FileIgnoreRule {
  readonly kind: 'exact' | 'regex'
  readonly pattern: string
  readonly caseSensitive: boolean
}

/** Durable and wire-compatible input for one file filter. */
export type FileIgnoreRuleInput = string | FileIgnoreRule

/** File-name filters attached to one canonical workspace path. */
export interface WorkspaceIgnoreFiles {
  /** Canonical workspace directory path supplied by the Harness. */
  readonly workspace: string
  /** Additional basenames ignored only inside this workspace. */
  readonly ignoreFiles: FileIgnoreRuleInput[]
}

/** Recently referenced relative paths for one canonical workspace path. */
export interface WorkspaceRecentFiles {
  /** Canonical workspace directory path supplied by the Harness. */
  readonly workspace: string
  /** Relative paths, most recent first, capped at the plugin maximum. */
  readonly files: readonly string[]
}

/**
 * One cross-category usage counter. The key is `${kind}:${value}`, the same
 * mention-kind vocabulary the picker and the dock already share, so a category
 * added later is counted without a schema change.
 */
export interface UsageEntry {
  /** `${mentionKind}:${value}`, e.g. `file:src/a.ts`, `skill:blender`, `plugin:dsh-atlas`. */
  readonly key: string
  /** How many times the user picked this reference. */
  readonly count: number
  /** Last pick time (epoch ms); the tie-breaker when counts are equal. */
  readonly at: number
}

/** The `at-file` settings namespace's durable shape (host and client share it). */
export interface AtFileSettings {
  /** Whether the @file surface is enabled; false hides picker, dock, and reference injection. */
  readonly enabled: boolean
  /** Global Exact and Regex basename filters; legacy strings are insensitive Exact rules. */
  readonly ignoreFiles: FileIgnoreRuleInput[]
  /** Workspace-specific filters added to the global filters. */
  readonly workspaceIgnoreFiles: WorkspaceIgnoreFiles[]
  /** Per-workspace recently referenced paths (most recent first). */
  readonly recentFiles?: WorkspaceRecentFiles[]
  /** Whether @ tokens inserted through paste stay ordinary text. */
  readonly ignorePastedMentions?: boolean
  /** Whether the @skill picker and reference injection are enabled. */
  readonly enableSkills?: boolean
  /** Whether the @past-chats picker and snapshot injection are enabled. */
  readonly enableChats?: boolean
  /** Whether the @plugin picker and reference injection are enabled. */
  readonly enablePlugins?: boolean
  /** Maximum candidate rows returned by the past-chats picker. */
  readonly candidateLimit?: number
  /** Cross-category pick counters, highest count first (bounded by the plugin). */
  readonly usage?: readonly UsageEntry[]
  /** Out-of-workspace paths the user has referenced, most recent first (bounded). */
  readonly externalRefs?: readonly ExternalRef[]
  /**
   * What clicking a FOLDER reference does: open the right Sidebar, the OS file
   * manager, or both. Absent means `both` — the sidebar is the newer half and
   * the local opener is the behaviour that came first.
   */
  readonly folderOpen?: FolderOpenTarget
}

/** How a folder reference opens when it is clicked. */
export type FolderOpenTarget = 'both' | 'sidebar' | 'native'

/** One field update sent through the plugin-owned settings Remote. */
export type AtFileSettingsUpdate =
  | { readonly field: 'enabled'; readonly value: boolean }
  | { readonly field: 'ignoreFiles'; readonly value: FileIgnoreRuleInput[] }
  | { readonly field: 'workspaceIgnoreFiles'; readonly value: WorkspaceIgnoreFiles[] }
  | { readonly field: 'ignorePastedMentions'; readonly value: boolean }
  | { readonly field: 'enableSkills'; readonly value: boolean }
  | { readonly field: 'enableChats'; readonly value: boolean }
  | { readonly field: 'enablePlugins'; readonly value: boolean }
  | { readonly field: 'candidateLimit'; readonly value: number }
  | { readonly field: 'recentFiles'; readonly value: WorkspaceRecentFiles[] }
  | { readonly field: 'usage'; readonly value: UsageEntry[] }
  | { readonly field: 'externalRefs'; readonly value: ExternalRef[] }
  | { readonly field: 'folderOpen'; readonly value: FolderOpenTarget }

/** Wire codec: one session identity (branded string on the wire). */
export const sessionIdSchema = z.string().min(1)

/** Wire codec: one workspace entry (file or directory). */
export const fileEntrySchema = z.object({
  path: z.string().min(1),
  relative: z.string().min(1),
  kind: z.enum(['file', 'dir']),
}).readonly()

/** Wire codec: one discoverable skill row. */
export const skillCandidateSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  tier: z.enum(['system', 'user', 'project', 'custom', 'plugin']),
}).readonly()

/** Wire codec: one past-session candidate row. */
export const chatCandidateSchema = z.object({
  sessionId: z.string().min(1),
  label: z.string(),
  uri: z.string().min(1),
  cwd: z.string().optional(),
  createdAt: z.number(),
}).readonly()

/** Wire codec: one plugin inventory row. */
export const pluginCandidateSchema = z.object({
  entryId: z.string().min(1),
  moduleName: z.string().min(1),
  enabled: z.boolean(),
}).readonly()

/** Wire schema of one reference inspection row. */
export const referenceInfoSchema = z.object({
  relative: z.string(),
  exists: z.boolean(),
  kind: z.enum(['file', 'dir']).optional(),
  size: z.number().nonnegative().optional(),
  outside: z.literal(true).optional(),
}).readonly()

/** Wire schema of one ledger row for an out-of-workspace reference. */
export const externalRefSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
  count: z.number().int().nonnegative(),
  lastUsedAt: z.number().nonnegative(),
  workspaces: z.array(z.string()).optional(),
}).readonly()

/** Wire schema of one session's out-of-workspace scope. */
export const externalAccessScopeSchema = z.object({
  canDiscover: z.boolean(),
  roots: z.array(z.string()),
  folders: z.array(z.string()),
}).readonly()

/** Wire schema of one directory-listing row. */
export const directoryEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'dir']),
}).readonly()

/** Wire schema of one one-level directory listing. */
export const directoryListingSchema = z.object({
  path: z.string(),
  parent: z.string().optional(),
  entries: z.array(directoryEntrySchema),
  truncated: z.literal(true).optional(),
  drives: z.array(z.string()).optional(),
  error: z.enum(['outside', 'missing', 'notDirectory']).optional(),
}).readonly()

/** Wire schema of one directory target (`''` means the session workspace root). */
export const directoryTargetSchema = z.string().max(4096)

/** Strict wire codec for one structured file filter. */
export const fileIgnoreRuleSchema = z.object({
  kind: z.enum(['exact', 'regex']),
  pattern: z.string().min(1),
  caseSensitive: z.boolean(),
}).readonly().superRefine((rule, context) => {
  if (rule.kind !== 'regex') return
  try {
    new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i')
  } catch (error) {
    /* v8 ignore next -- RegExp construction throws an Error in supported runtimes. */
    const message = error instanceof Error ? error.message : 'Invalid regular expression'
    context.addIssue({ code: 'custom', message })
  }
})

/** Strict wire codec accepting both legacy strings and structured filters. */
export const fileIgnoreRuleInputSchema = z.union([z.string(), fileIgnoreRuleSchema])

/** Strict wire codec for one workspace-specific filter row. */
export const workspaceIgnoreFilesSchema = z.object({
  workspace: z.string().min(1),
  ignoreFiles: z.array(fileIgnoreRuleInputSchema),
}).readonly()

/** Strict wire codec for one workspace's recent-file list. */
export const workspaceRecentFilesSchema = z.object({
  workspace: z.string().min(1),
  files: z.array(z.string().min(1)).max(30),
}).readonly()

/** Strict wire codec for one cross-category usage counter. */
export const usageEntrySchema = z.object({
  key: z.string().min(1),
  count: z.number().int().min(1),
  at: z.number().nonnegative(),
}).readonly()

/** Strict wire codec for the running Harness facts the atlas seam gates on. */
export const atlasRuntimeSchema = z.object({
  dshVersion: z.string().min(1).optional(),
}).readonly()

/** Strict wire codec for the resolved at-file settings section. */
export const atFileSettingsSchema = z.object({
  enabled: z.boolean(),
  ignoreFiles: z.array(fileIgnoreRuleInputSchema),
  workspaceIgnoreFiles: z.array(workspaceIgnoreFilesSchema),
  ignorePastedMentions: z.boolean().default(true),
  enableSkills: z.boolean().default(true),
  enableChats: z.boolean().default(true),
  enablePlugins: z.boolean().default(true),
  candidateLimit: z.number().int().min(1).max(200).default(50),
  recentFiles: z.array(workspaceRecentFilesSchema).default([]),
  usage: z.array(usageEntrySchema).default([]),
  // What a click on a FOLDER reference does. This field is a WIRE value, not
  // just a storage one: the update verb and its resolved reply both cross this
  // codec, so a field missing here can never be written back or read again —
  // the client would silently keep showing the default.
  folderOpen: z.enum(['both', 'sidebar', 'native']).default('both'),
}).readonly()

/** Strict wire codec for one field update. */
export const atFileSettingsUpdateSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('enabled'), value: z.boolean() }).readonly(),
  z.object({ field: z.literal('ignoreFiles'), value: z.array(fileIgnoreRuleInputSchema) }).readonly(),
  z.object({
    field: z.literal('workspaceIgnoreFiles'),
    value: z.array(workspaceIgnoreFilesSchema),
  }).readonly(),
  z.object({ field: z.literal('ignorePastedMentions'), value: z.boolean() }).readonly(),
  z.object({ field: z.literal('enableSkills'), value: z.boolean() }).readonly(),
  z.object({ field: z.literal('enableChats'), value: z.boolean() }).readonly(),
  z.object({ field: z.literal('enablePlugins'), value: z.boolean() }).readonly(),
  z.object({ field: z.literal('candidateLimit'), value: z.number().int().min(1).max(200) }).readonly(),
  z.object({ field: z.literal('recentFiles'), value: z.array(workspaceRecentFilesSchema) }).readonly(),
  z.object({ field: z.literal('usage'), value: z.array(usageEntrySchema) }).readonly(),
  z.object({ field: z.literal('folderOpen'), value: z.enum(['both', 'sidebar', 'native']) }).readonly(),
])

/**
 * The built-in `@git` provider's shared facts.
 *
 * Both halves declare them: the browser half because the registry demands a
 * governance declaration for every registration, the Host half because it
 * answers `resolve`. Keeping one copy means a provider cannot end up with two
 * different `testedOn` claims depending on which half speaks first.
 */
export const GIT_PROVIDER_ID = 'git'
/** What the built-in @git source reaches for: the git process, and no file read. */
export const GIT_SCOPES: readonly string[] = ['process:git']
/**
 * The DSH builds this plugin's built-in providers have actually been exercised
 * on. The seam compares it for equality, so bumping it is part of the release
 * checklist — an unlisted build is reported as unverified, never as verified.
 */
export const BUILTIN_TESTED_ON: readonly string[] = ['0.1.5-rc.1']

/** Strict wire codec for one changed workspace path (the built-in `@git` source). */
export const gitChangeSchema = z.object({
  path: z.string().min(1),
  status: z.string().min(1),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
}).readonly()

/** The live agent lookup parameter (shared by both namespaces). */
const agentLookupParameter = {
  name: 'agent',
  wire: 'agentId',
  source: 'lookup',
  lookup: 'agent',
  // The type symbol must equal the agent lookup provider's wire identity
  // exactly — the gateway's strict path rejects a mismatched symbol.
  codec: strictCodec('@deepseek-ai/dsh-session/types#SessionId', sessionIdSchema),
} as const

/** The atFile Remote namespace's strict invocation descriptors. */
export const AT_FILE_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: 'dsh-atlas#atFile/search',
    service: 'atFile',
    namespace: 'atFile',
    method: 'search',
    invocation: { kind: 'direct' },
    parameters: [agentLookupParameter],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#FileEntry[]', z.array(fileEntrySchema)),
  },
  {
    id: 'dsh-atlas#atFile/getSettings',
    service: 'atFile',
    namespace: 'atFile',
    method: 'getSettings',
    invocation: { kind: 'direct' },
    parameters: [],
    result: strictCodec('dsh-atlas#AtFileSettings', atFileSettingsSchema),
  },
  {
    id: 'dsh-atlas#atFile/updateSettings',
    service: 'atFile',
    namespace: 'atFile',
    method: 'updateSettings',
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'update',
        wire: 'update',
        source: 'json',
        codec: strictCodec('dsh-atlas#AtFileSettingsUpdate', atFileSettingsUpdateSchema),
      },
    ],
    result: strictCodec('dsh-atlas#AtFileSettings', atFileSettingsSchema),
  },
  {
    id: 'dsh-atlas#atFile/inspect',
    service: 'atFile',
    namespace: 'atFile',
    method: 'inspect',
    invocation: { kind: 'direct' },
    parameters: [
      agentLookupParameter,
      {
        name: 'targets',
        wire: 'targets',
        source: 'json',
        codec: strictCodec('dsh-atlas#ReferenceTargets', z.array(z.string())),
      },
    ],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#ReferenceInfo[]', z.array(referenceInfoSchema)),
  },
  {
    id: 'dsh-atlas#atFile/external',
    service: 'atFile',
    namespace: 'atFile',
    method: 'external',
    invocation: { kind: 'direct' },
    parameters: [agentLookupParameter],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#ExternalAccessScope', externalAccessScopeSchema),
  },
  {
    id: 'dsh-atlas#atFile/list',
    service: 'atFile',
    namespace: 'atFile',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [
      agentLookupParameter,
      {
        name: 'path',
        wire: 'path',
        source: 'json',
        codec: strictCodec('dsh-atlas#DirectoryTarget', directoryTargetSchema),
      },
    ],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#DirectoryListing', directoryListingSchema),
  },
]

/** The atMention Remote namespace's strict invocation descriptors. */
export const AT_MENTION_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: 'dsh-atlas#atMention/listSkills',
    service: 'atMention',
    namespace: 'atMention',
    method: 'listSkills',
    invocation: { kind: 'direct' },
    parameters: [agentLookupParameter],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#SkillCandidate[]', z.array(skillCandidateSchema)),
  },
  {
    id: 'dsh-atlas#atMention/listChats',
    service: 'atMention',
    namespace: 'atMention',
    method: 'listChats',
    invocation: { kind: 'direct' },
    parameters: [
      agentLookupParameter,
      {
        name: 'query',
        wire: 'query',
        source: 'json',
        codec: strictCodec('dsh-atlas#ChatQuery', z.string()),
      },
      {
        name: 'limit',
        wire: 'limit',
        source: 'json',
        codec: strictCodec('dsh-atlas#ChatLimit', z.number().int().min(1).max(200)),
      },
    ],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#ChatCandidate[]', z.array(chatCandidateSchema)),
  },
  {
    id: 'dsh-atlas#atMention/listPlugins',
    service: 'atMention',
    namespace: 'atMention',
    method: 'listPlugins',
    invocation: { kind: 'direct' },
    parameters: [],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#PluginCandidate[]', z.array(pluginCandidateSchema)),
  },
]

/**
 * The atlas seam's own invocations — the Host half of the @ data-source seam.
 * `runtime` reports the facts a provider's `testedOn` claim is judged against;
 * the Host-half provider registry lands here as the seam grows.
 */
export const ATLAS_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: 'dsh-atlas#atlas/runtime',
    service: 'atlas',
    namespace: 'atlas',
    method: 'runtime',
    invocation: { kind: 'direct' },
    parameters: [],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#AtlasRuntimeInfo', atlasRuntimeSchema),
  },
  {
    // The built-in @git provider is the seam's worked example: its candidate
    // list lives in the browser but the repository lives on the Host, so the
    // menu half reads through this endpoint instead of touching the disk.
    id: 'dsh-atlas#atlas/gitChanges',
    service: 'atlas',
    namespace: 'atlas',
    method: 'gitChanges',
    invocation: { kind: 'direct' },
    parameters: [agentLookupParameter],
    cancellation: { parameter: 'signal' },
    result: strictCodec('dsh-atlas#GitChange[]', z.array(gitChangeSchema)),
  },
]
