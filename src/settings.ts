/**
 * The `at-file` settings namespace: the durable enable switch, pasted-mention
 * policy, and file-name filters managed from the Web settings page. Registered with the settings
 * provider at plugin load; the runtime reads the owner scope's live value on
 * every call, so changes take effect without a restart.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AtFileSettings, ExternalRef, UsageEntry, WorkspaceRecentFiles } from './contract.ts'
import type { FileIgnoreRule } from './contract.ts'
import { DEFAULT_IGNORE_FILES } from './defaults.ts'
import { createDurableSettings, type DurableSettings } from './store.ts'

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
  // Session history jump: the F1 palette and the F2 roaming gesture. Declared
  // here or the Host schema strips each write (the Web surface edits them).
  historyJump: z.boolean().default(true),
  // A-33: the ladder IS the page's turn ruler by default — one stop per turn,
  // the same unit the right-side rail draws, so the readout's total and the
  // ruler's tick count are the same number. `'message'` keeps the finer walk
  // (every prompt AND the answer) for users who want to stop inside a turn.
  historyJumpFrames: z.union(['message', 'turn'] as const).default('turn'),
  historyJumpReuseMode: z.union(['replace', 'append'] as const).default('replace'),
  // A-19 item 3: opt-in only. Following the scroll redefines what "the previous
  // message to reuse" means, so it must never be the default.
  historyJumpSmartFollow: z.boolean().default(false),
}) as unknown as z<AtFileSettings>

/**
 * The settings surface this plugin consumes: the `at-file` namespace's live
 * value and a writer for it.
 *
 * Stated here rather than imported because the published settings service types
 * a composition EDITOR (`describe`/`update`/`mutate` over the profile's own
 * entries), while this plugin owns a namespace of its own. The namespace API the
 * runtime still answers — `register(namespace, schema, { applies: 'live' })` —
 * is what this shape names, and {@link registerAtFileSettings} probes for it
 * instead of assuming it, so a profile without it degrades to defaults instead
 * of failing the whole plugin at load.
 */
export interface AtFileSettingsScope {
  /** The namespace's current value, defaults applied. */
  get(): AtFileSettings
  /** Merge one patch into the namespace and persist it. */
  update(patch: Partial<AtFileSettings>): Promise<void>
}

/** The one method of the settings service this plugin registers through. */
interface NamespaceRegistrar {
  register?<T>(namespace: string, schema: unknown, options?: { applies?: 'live' }): AtFileSettingsScope
}

/**
 * A scope over this plugin's own document, used when the service offers no
 * namespace API. The value starts at the schema defaults and every update is
 * written to the harness home, so switches, filters, history knobs and the
 * out-of-workspace ledger survive a restart instead of living only in memory.
 * @param store - the document this profile keeps its section in.
 * @returns a scope backed by that document.
 */
function durableScope(store: DurableSettings): AtFileSettingsScope {
  let current: AtFileSettings | undefined
  const value = (): AtFileSettings => (current ??= store.load())
  return {
    get: value,
    update: async (patch) => {
      // Re-validate the merge: a patch from the wire must not smuggle a field the
      // schema would reject, and the defaults stay applied to anything absent.
      const next = AtFileSettingsSchema({ ...value(), ...patch } as AtFileSettings)
      current = next
      await store.save(next)
    },
  }
}

/**
 * Register the namespace with the settings provider and return its owner scope.
 * @param ctx - the plugin context carrying the settings provider.
 * @returns the owner scope backing the runtime's live enable check.
 */
export function registerAtFileSettings(ctx: Context): AtFileSettingsScope {
  const registrar = ctx.settings as unknown as NamespaceRegistrar
  if (typeof registrar.register !== 'function') {
    const store = createDurableSettings(ctx)
    console.warn(`[dsh-atlas] this profile's settings service has no namespace API; "${AT_FILE_NAMESPACE}" is kept in ${store.file}`)
    const scope = durableScope(store)
    // A document carried over from an older profile can say `enabled: false`, and
    // then every host method refuses while the client simply shows nothing — the
    // one failure mode that looks exactly like "this plugin does nothing". Say it
    // once at load, with the file to edit, instead of leaving it silent.
    if (!scope.get().enabled) {
      console.warn(`[dsh-atlas] "${AT_FILE_NAMESPACE}" is switched OFF in ${store.file}; the "@" categories, history jump and folder picker stay idle until it is turned back on`)
    }
    return scope
  }
  return registrar.register<AtFileSettings>(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: 'live' })
}
