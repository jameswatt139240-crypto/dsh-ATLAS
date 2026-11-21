/**
 * The durable side of the `at-file` section.
 *
 * Newer harness releases dropped the plugin-owned settings namespace: their
 * settings service projects each plugin's own Config into a form and has no
 * `register(namespace, schema)`, so a plugin that only ever wrote through that
 * namespace silently ran on defaults — and the out-of-workspace ledger, the
 * pick counters and the recent-file lists had nowhere to live. This store is
 * the answer: one small JSON document under the harness home, written
 * atomically, validated through the same schema the namespace used, so the
 * section keeps its value across restarts on both kinds of profile.
 *
 * It is runtime DATA, not configuration: the harness home owns it, the plugin
 * never edits the profile's patch to store it.
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AtFileSettings } from './contract.ts'
import { AtFileSettingsSchema } from './settings.ts'

/** The document's on-disk shape; `version` leaves room for a migration. */
interface SettingsDocument {
  version: 1
  settings: AtFileSettings
}

/** The harness home this profile uses, as far as the plugin can tell. */
export function harnessHome(ctx: Context): string {
  const profile = (ctx as unknown as { profileContext?: { home?: unknown } }).profileContext
  if (profile !== undefined && typeof profile.home === 'string' && profile.home !== '') return profile.home
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** The file that holds the `at-file` section for one harness home. */
export function settingsFile(home: string): string {
  return join(home, 'atlas', 'at-file.json')
}

/** Defaults applied to an empty section — exactly what the namespace would answer. */
function defaults(): AtFileSettings {
  return AtFileSettingsSchema({} as AtFileSettings)
}

/**
 * Read the section, or the defaults when the file is absent or unreadable.
 * A corrupt document is reported once and replaced on the next write; it never
 * takes the plugin down.
 * @param file - absolute path of the settings document.
 * @returns the validated section.
 */
export function readDurableSettings(file: string): AtFileSettings {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return defaults()
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    const section = pickSection(parsed)
    return AtFileSettingsSchema(section as AtFileSettings)
  } catch (error) {
    console.warn(`[dsh-atlas] ignoring unreadable settings at ${file}: ${String(error)}`)
    return defaults()
  }
}

/**
 * The section inside a document, tolerating both the wrapped shape this module
 * writes and a bare section copied from an older release's hand-edited file.
 * @param parsed - the document's parsed JSON.
 * @returns the candidate section.
 */
function pickSection(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object') return {}
  const document = parsed as Partial<SettingsDocument> & Record<string, unknown>
  if (document.version === 1 && document.settings !== null && typeof document.settings === 'object') {
    return document.settings
  }
  if ('settings' in document || 'version' in document) return {}
  return document
}

/** One durable document for one harness home. */
export interface DurableSettings {
  /** Absolute path of the document this store reads and writes. */
  readonly file: string
  /** The section as it stands on disk (defaults when there is nothing yet). */
  load(): AtFileSettings
  /** Replace the section, atomically and in order with other saves. */
  save(settings: AtFileSettings): Promise<void>
}

/**
 * Build the store for the profile behind `ctx`.
 * @param ctx - the plugin context; only its profile home is consulted.
 * @returns a store whose saves are serialized and whose failures are reported,
 *   not thrown: a read-only home must not break the composer.
 */
export function createDurableSettings(ctx: Context): DurableSettings {
  const file = settingsFile(harnessHome(ctx))
  const directory = dirname(file)
  /** The tail of the write chain, so two saves never interleave. */
  let pending: Promise<void> = Promise.resolve()
  return {
    file,
    load: () => readDurableSettings(file),
    save: (settings) => {
      pending = pending.then(async () => {
        const document: SettingsDocument = { version: 1, settings }
        const temporary = `${file}.${String(process.pid)}.tmp`
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
          await rename(temporary, file)
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {})
          console.warn(`[dsh-atlas] could not save settings to ${file}: ${String(error)}`)
        }
      })
      return pending
    },
  }
}
