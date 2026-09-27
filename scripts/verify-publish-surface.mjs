/**
 * Publish-surface gate.
 *
 * The npm tarball must carry the plugin runtime, its public docs, and the
 * README screenshots — and must NOT carry internal working files: this
 * repository's internal plan and evidence directory, AI-assistant instruction
 * files (`AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/`, `.cursor/`, `skills/`),
 * TypeScript sources, tests, or repository tooling.
 *
 * It also refuses a bundle that still inlines an ad banner, because the first
 * published version ships without ads. A deliberate ad-bearing release sets
 * `DSH_ATLAS_ALLOW_ADS=1` (and is built with `pnpm run build:ads`).
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The internal plan/evidence directory, named once. It is the ONE internal name
 * this published script has to spell out, because the check works by matching it.
 */
const INTERNAL_DIR = 'Eason'

/** Paths that must never appear in the tarball. */
const FORBIDDEN = [
  { pattern: new RegExp(`^${INTERNAL_DIR}/`, 'u'), why: 'internal plan and evidence' },
  { pattern: /^AGENTS\.md$/u, why: 'AI-assistant instructions' },
  { pattern: /^CLAUDE\.md$/u, why: 'AI-assistant instructions' },
  { pattern: /^\.agents\//u, why: 'AI-assistant workflows' },
  { pattern: /^\.claude\//u, why: 'AI-assistant workflows' },
  { pattern: /^\.cursor\//u, why: 'AI-assistant workflows' },
  { pattern: /^skills\//u, why: 'AI-assistant skills' },
  { pattern: /^src\//u, why: 'TypeScript sources are not runtime payload' },
  { pattern: /^tests\//u, why: 'test sources' },
  { pattern: /^scripts\//u, why: 'repository tooling' },
  { pattern: /\.map$/u, why: 'sourcemaps inline the TypeScript sources and local absolute paths' },
  { pattern: /^pnpm-/u, why: 'workspace manifests' },
  { pattern: /^tsconfig/u, why: 'repository tooling' },
  { pattern: /^vitest\.config/u, why: 'repository tooling' },
  { pattern: /^build\.mjs$/u, why: 'repository tooling' },
]

/** Paths the published payload must contain. */
const REQUIRED = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/invariant.js',
  'dsh.plugin.json',
  'cordis.patch.yml',
  'LICENSE',
  'LICENSE-ORIGINAL',
  'NOTICE',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  // Every image the READMEs reference, so the npm page cannot show a broken one.
  'assets/diagrams/atlas-overview.svg',
  'assets/diagrams/atlas-seam.svg',
  'assets/screenshots/menu-mixed.png',
  'assets/screenshots/file-mention-composer.png',
  'assets/screenshots/file-mention-settings.png',
]

/**
 * The file list `npm pack --dry-run --json` reports.
 *
 * Two shapes exist in the wild: npm <= 11 answers with an ARRAY of pack results,
 * while newer npm prints leading notices before the JSON and/or wraps the result
 * differently — the release job died on `packed[0].files` when the workflow
 * installed `npm@latest`. So: start at the first bracket, then accept either an
 * array, a `{ files }` object, or an object keyed by package name.
 * @returns the tarball's paths.
 */
function packedPaths() {
  const raw = execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const start = raw.search(/[[{]/u)
  if (start < 0) throw new Error(`npm pack --json printed no JSON: ${raw.slice(0, 200)}`)
  const parsed = JSON.parse(raw.slice(start))
  const results = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed.files) ? [parsed] : Object.values(parsed))
  const files = results.flatMap(result => (Array.isArray(result?.files) ? result.files : []))
  if (files.length === 0) throw new Error(`npm pack --json reported no files: ${raw.slice(0, 200)}`)
  return files.map(entry => entry.path)
}

const files = packedPaths()

const problems = []
for (const path of files) {
  const hit = FORBIDDEN.find(rule => rule.pattern.test(path))
  if (hit !== undefined) problems.push(`forbidden in tarball: ${path} (${hit.why})`)
}
for (const path of REQUIRED) {
  if (!files.includes(path)) problems.push(`missing from tarball: ${path}`)
}

const clientBundle = readFileSync('lib/client.js', 'utf8')
if (/data:image\/(?:webp|png|jpe?g)/u.test(clientBundle) && process.env.DSH_ATLAS_ALLOW_ADS !== '1') {
  problems.push('lib/client.js inlines an ad banner: build ad-free with `pnpm run build` before publishing, or set DSH_ATLAS_ALLOW_ADS=1 for a deliberate ad release')
}

// The bundles must not carry development-machine paths or assistant artifacts.
// The machine-specific markers are DERIVED, never spelled out: this catches the
// real home and parent directories without the published script naming them.
const LOCAL_MARKERS = [
  'deepseek-harness',
  'file:///',
  homedir().replaceAll('\\', '/'),
  dirname(dirname(fileURLToPath(import.meta.url))).replaceAll('\\', '/'),
]
for (const artifact of ['lib/index.js', 'lib/client.js', 'lib/invariant.js']) {
  const text = readFileSync(artifact, 'utf8')
  for (const marker of LOCAL_MARKERS) {
    if (text.includes(marker)) problems.push(`${artifact} leaks a local path marker: ${marker}`)
  }
}

// The studio naming invariant (see AGENTS.md): ONE identity in every place the
// framework keys on. A mismatch loads the host half while the client half silently
// never registers, so a consumer's `@` menu would simply lose this plugin.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const pluginManifest = JSON.parse(readFileSync('dsh.plugin.json', 'utf8'))
const IDENTITIES = [
  ['dsh.plugin.json', pluginManifest.name],
  ['cordis.patch.yml', /^\s*name:\s*'([^']+)'/mu.exec(readFileSync('cordis.patch.yml', 'utf8'))?.[1]],
  ['lib/client.js', /window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/u.exec(clientBundle)?.[1]],
  ['lib/invariant.js', /PACKAGE_NAME = "([^"]+)"/u.exec(readFileSync('lib/invariant.js', 'utf8'))?.[1]],
]
for (const [label, value] of IDENTITIES) {
  if (value !== pkg.name) problems.push(`naming invariant: ${label} declares ${String(value)}, package.json says ${pkg.name}`)
}

// ---- Description invariant: the same sentence, everywhere, saying the same thing.
//
// The product's one-line summary is duplicated on purpose (a reader lands on the
// npm card, the GitHub About, the README, or the diagram inside it) and that is
// exactly how it drifts: 1.0.3 updated the README and the diagram's aria-label
// while the line DRAWN inside the SVG still read a version from three releases
// earlier. This gate removes the duplication as a source of error: the metadata
// copy must be identical, every surface must carry the phrases that make the
// product legible, and the stale wording cannot come back.
const PLUGIN_DESCRIPTION = pluginManifest.description
if (PLUGIN_DESCRIPTION !== pkg.description) {
  problems.push(`description drift: dsh.plugin.json says ${JSON.stringify(PLUGIN_DESCRIPTION)}, package.json says ${JSON.stringify(pkg.description)}`)
}

/**
 * The tagline line of a README: the paragraph that opens with the product's
 * `**@ Last, All Sources.**` label, with Markdown emphasis stripped.
 */
function taglineOf(file) {
  const text = readFileSync(file, 'utf8')
  const line = text.split('\n').find(candidate => candidate.startsWith('**@ Last, All Sources.**'))
  if (line === undefined) throw new Error(`${file}: no "@ Last, All Sources." tagline line found`)
  return line.replaceAll('*', '').replaceAll('`', '')
}

const overviewSvg = readFileSync('assets/diagrams/atlas-overview.svg', 'utf8')
/** The tagline DRAWn inside the diagram: its text elements, in document order. */
const drawnLines = [...overviewSvg.matchAll(/<text[^>]*>([^<]*)<\/text>/gu)].map(match => match[1])
/** The product's one-line summary, as each surface spells it. */
const SURFACES = [
  ['package.json description', pkg.description, 'meta'],
  ['dsh.plugin.json description', PLUGIN_DESCRIPTION, 'meta'],
  ['README.md tagline', taglineOf('README.md'), 'en'],
  ['README.zh.md tagline', taglineOf('README.zh.md'), 'zh'],
  ['atlas-overview.svg aria-label', /aria-label="([^"]*)"/u.exec(overviewSvg)?.[1] ?? '', 'art'],
  ['atlas-overview.svg drawn line', drawnLines[1] ?? '', 'art'],
]
/**
 * Phrases each surface must carry, keyed by the SURFACE KIND rather than by one
 * loosened list. The product is bilingual but a surface never mixes, and the short
 * metadata line physically cannot carry every claim the README does - so the
 * metadata set is the promise, while the README/diagram sets add the visible
 * affordances ("clickable", "可点", the session jump).
 * @type {Record<string, readonly { test: RegExp, why: string }[]>}
 */
const PHRASES = {
  meta: [
    { test: /any plugin/iu, why: 'the seam: third parties register their own source' },
    { test: /Atlas/iu, why: 'the name the tagline hangs the promise on' },
    { test: /click/iu, why: 'you @ it, click it, jump' },
    { test: /jump/iu, why: 'a session link navigates, the newest thing it does' },
  ],
  en: [
    { test: /clickable/iu, why: 'a clickable link is the most visible thing the plugin does' },
    { test: /any plugin/iu, why: 'the seam: third parties register their own source' },
    { test: /click/iu, why: 'you @ it, click it, jump' },
    { test: /jump/iu, why: 'a session link navigates, the newest thing it does' },
    { test: /Atlas/iu, why: 'the name the tagline hangs the promise on' },
  ],
  /**
   * The artwork: both its spoken label and the line drawn inside it. The drawn
   * line IS the approved tagline, so it carries the promise ("click") rather than
   * the adjective the README adds in prose ("clickable").
   */
  art: [
    { test: /any plugin/iu, why: 'the seam: third parties register their own source' },
    { test: /Atlas/iu, why: 'the name the tagline hangs the promise on' },
    { test: /click/iu, why: 'you @ it, click it, jump' },
    { test: /jump/iu, why: 'a session link navigates, the newest thing it does' },
  ],
  zh: [
    { test: /可点/u, why: 'a clickable link is the most visible thing the plugin does' },
    { test: /任何插件/u, why: 'the seam: third parties register their own source' },
    { test: /@/u, why: 'the trigger is the whole product' },
    { test: /跳/u, why: 'a session link navigates, the newest thing it does' },
    { test: /Atlas/u, why: 'the name the tagline hangs the promise on' },
  ],
}
/** Wording that was deliberately retired and must not come back. */
const RETIRED = [
  { test: /@-able/u, why: 'the hyphenated compound was dropped for being hard to read' },
]
for (const [label, text, kind] of SURFACES) {
  if (text.trim() === '') {
    problems.push(`summary invariant: ${label} is empty`)
    continue
  }
  for (const phrase of PHRASES[kind]) {
    if (!phrase.test.test(text)) problems.push(`summary invariant: ${label} is missing /${phrase.test.source}/ (${phrase.why})`)
  }
  for (const retired of RETIRED) {
    if (retired.test.test(text)) problems.push(`summary invariant: ${label} carries retired wording /${retired.test.source}/ (${retired.why})`)
  }
  if (/any plugin can register its own\.?\s*$/iu.test(text)) {
    problems.push(`summary invariant: ${label} still carries an older tagline`)
  }
}

if (problems.length > 0) {
  console.error('[verify-publish-surface] FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`[verify-publish-surface] ok — ${files.length} files, no internal artifacts, ad-free bundle`)
