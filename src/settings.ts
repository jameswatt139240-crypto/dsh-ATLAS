/**
 * The `at-file` settings namespace: the durable enable switch, pasted-mention
 * policy, and file-name filters managed from the Web settings page. Registered with the settings
 * provider at plugin load; the runtime reads the owner scope's live value on
 * every call, so changes take effect without a restart.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { AtFileSettings, ExternalRef, UsageEntry, WorkspaceRecentFiles } from './contract.ts'
import type { FileIgnoreRule } from './contract.ts'
import { DEFAULT_IGNORE_FILES } from './defaults.ts'

/** The branded namespace name (the Web allowlist must list the same string). */
export const AT_FILE_NAMESPACE = 'at-file'

/**
 * Schemastery schema of the `at-file` namespace section. The trailing cast only
 * bridges schemastery's `ObjectT` inference — which carries an index signature
 * and mutable arrays — to the readonly interface the wire codec shares; every
 * field is still validated at runtime.
 */
export const AtFileSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  ignoreFiles: z.array(z.union([
    z.string(),
    z.object({
      kind: z.union(['exact', 'regex'] as const),
      pattern: z.string(),
      caseSensitive: z.boolean(),
    }) as z<FileIgnoreRule>,
  ])).default([...DEFAULT_IGNORE_FILES]),
  workspaceIgnoreFiles: z.array(z.object({
    workspace: z.string(),
    ignoreFiles: z.array(z.union([
      z.string(),
      z.object({
        kind: z.union(['exact', 'regex'] as const),
        pattern: z.string(),
        caseSensitive: z.boolean(),
      }) as z<FileIgnoreRule>,
    ])),
  })).default([]),
  ignorePastedMentions: z.boolean().default(true),
  enableSkills: z.boolean().default(true),
  enableChats: z.boolean().default(true),
  enablePlugins: z.boolean().default(true),
  candidateLimit: z.natural().min(1).max(200).default(50),
  // Both history fields must be declared here or the Host schema strips them on
  // write (the Web surface has no editor for them; the plugin owns them).
  recentFiles: z.array(z.object({
    workspace: z.string(),
    files: z.array(z.string()),
  }) as z<WorkspaceRecentFiles>).default([]),
  usage: z.array(z.object({
    key: z.string(),
    count: z.number(),
    at: z.number(),
  }) as z<UsageEntry>).default([]),
  // The out-of-workspace ledger (see src/external.ts): paths the user referenced
  // under full access, offered again in narrower modes. Declared here or the
  // Host schema strips it on write.
  externalRefs: z.array(z.object({
    path: z.string(),
    kind: z.union(['file', 'dir'] as const),
    count: z.number(),
    lastUsedAt: z.number(),
    workspaces: z.array(z.string()).default([]),
  }) as z<ExternalRef>).default([]),
  // Clicking a folder reference: the right Sidebar, the OS file manager, or both.
  folderOpen: z.union(['both', 'sidebar', 'native'] as const).default('both'),
}) as unknown as z<AtFileSettings>

/**
 * Register the namespace with the settings provider and return its owner scope.
 * @param ctx - the plugin context carrying the settings provider.
 * @returns the owner scope backing the runtime's live enable check.
 */
export function registerAtFileSettings(ctx: Context): SettingsScope<AtFileSettings> {
  return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: 'live' })
}
