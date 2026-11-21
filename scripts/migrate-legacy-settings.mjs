#!/usr/bin/env node
/**
 * Move the `at-file` section out of a harness home's removed `settings.yaml`
 * into the document this plugin reads now (`<home>/atlas/at-file.json`).
 *
 * Newer harness releases dropped the plugin-owned settings namespace, so the
 * section that releases up to 1.2.0 wrote into `settings.yaml` (or the
 * `settings-legacy.yaml` that release renamed it to) is no longer read. This
 * copies it once. It is a development-side tool: the plugin itself never parses
 * YAML, and it keeps working when this script was never run.
 *
 * Usage: node scripts/migrate-legacy-settings.mjs [--home <dir>] [--dry]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const homeFlag = argv.indexOf('--home')
const home = homeFlag >= 0 && argv[homeFlag + 1] !== undefined
  ? argv[homeFlag + 1]
  : (process.env.DSH_HOME ?? join(homedir(), '.dsh'))

const target = join(home, 'atlas', 'at-file.json')
const legacyFiles = [join(home, 'settings.yaml'), join(home, 'settings-legacy.yaml')]

/** Fields this migration only fills when the target's own copy is empty. */
const LEDGER_FIELDS = ['externalRefs', 'recentFiles', 'usage']

const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : undefined

const source = legacyFiles.find(path => existsSync(path))
if (source === undefined) {
  console.log(`nothing to migrate: no settings.yaml or settings-legacy.yaml under ${home}`)
  process.exit(0)
}

const document = parse(readFileSync(source, 'utf8')) ?? {}
const section = document['at-file']
if (section === undefined || section === null || typeof section !== 'object') {
  console.log(`nothing to migrate: ${source} has no at-file section`)
  process.exit(0)
}

const settings = existing?.settings ?? {}
// Data only. A switch copied out of a profile that no longer reads it is a trap:
// `enabled: false` makes every host method refuse, and the composer simply looks
// like it has no plugin, so the migrated document starts switched on.
if (existing === undefined) settings.enabled = true
for (const field of LEDGER_FIELDS) {
  const mine = settings[field]
  const theirs = section[field]
  if (!Array.isArray(theirs) || theirs.length === 0) continue
  if (Array.isArray(mine) && mine.length > 0) continue
  settings[field] = theirs
  console.log(`filled ${field}: ${String(theirs.length)} row(s)`)
}

const payload = `${JSON.stringify({ version: 1, settings }, null, 2)}\n`
const counts = Object.fromEntries(
  Object.entries(section).map(([key, value]) => [key, Array.isArray(value) ? `${String(value.length)} row(s)` : typeof value]),
)
console.log(`source: ${source}`)
console.log(`target: ${target}`)
console.log(`fields: ${JSON.stringify(counts)}`)
if (dry) {
  console.log('dry run: nothing written')
  process.exit(0)
}

mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
writeFileSync(`${target}.migrating`, payload, { mode: 0o600 })
renameSync(`${target}.migrating`, target)
console.log('written')
