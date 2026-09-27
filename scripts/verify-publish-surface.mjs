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
 * The masthead of a README: the `**@ Last, All Sources.**` label, the tagline line
 * directly under it, and the intro line under that, with Markdown emphasis
 * stripped. The approved masthead is exactly this shape - label, tagline, intro -
 * in both languages, so each part is addressable.
 */
function mastheadOf(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex(line => line.startsWith('**@ Last, All Sources.**'))
  if (start < 0) throw new Error(`${file}: no "@ Last, All Sources." masthead found`)
  return {
    all: lines.slice(start, start + 5).filter(line => line.trim() !== '').join('\n').replaceAll('*', '').replaceAll('`', ''),
    /** The tagline line itself, which must BE the approved sentence. */
    tagline: lines
      .slice(start + 1, start + 4)
      .map(line => line.trim())
      .find(line => line !== '')
      ?.replaceAll('*', '').replaceAll('`', '') ?? '',
  }
}

/** The Chinese brand line, which rides in both READMEs' mastheads. */
const BRAND_LINE = '一 @ 即达'

const overviewSvg = readFileSync('assets/diagrams/atlas-overview.svg', 'utf8')
/**
 * The tagline DRAWn inside the diagram. Found by CONTENT rather than by index: the
 * wordmark is drawn as `<tspan>` runs, so a naive "second text element" would pick
 * up a tspan instead of the tagline.
 */
const drawnLine = [...overviewSvg.matchAll(/<text[^>]*>([^<]*)<\/text>/gu)]
  .map(match => match[1])
  .find(text => text.includes('All Sources')) ?? ''
const readmeEn = mastheadOf('README.md')
const readmeZh = mastheadOf('README.zh.md')
/** The product's one-line summary, as each surface spells it. */
const SURFACES = [
  ['package.json description', pkg.description, 'meta'],
  ['dsh.plugin.json description', PLUGIN_DESCRIPTION, 'meta'],
  ['README.md masthead', readmeEn.all, 'en', 'clean'],
  ['README.zh.md masthead', readmeZh.all, 'zh'],
  ['atlas-overview.svg aria-label', /aria-label="([^"]*)"/u.exec(overviewSvg)?.[1] ?? '', 'art', 'clean'],
  ['atlas-overview.svg drawn line', drawnLine, 'art', 'clean'],
]
/**
 * The approved tagline, asserted on the tagline LINE itself: the label above it and
 * the intro below it are different sentences, so a whole-masthead `includes` would
 * pass even if the tagline line had been replaced.
 */
const TAGLINES = [
  ['README.md masthead', readmeEn.tagline, 'One @ . Jump anywhere.'],
  ['README.zh.md masthead', readmeZh.tagline, '一 @ 即达。'],
]
/**
 * Phrases each surface must carry, keyed by the SURFACE KIND. The product is
 * bilingual but a surface never mixes the two languages; the short metadata line
 * physically cannot carry every claim the README does, so each kind states what
 * THAT kind of surface must promise.
 * @type {Record<string, readonly { test: RegExp, why: string }[]>}
 */
const PHRASES = {
  meta: [
    { test: /jump anywhere/iu, why: 'the promise itself, spelled the approved way' },
  ],
  en: [
    { test: /jump anywhere/iu, why: 'the promise itself, spelled the approved way' },
    { test: /clickable/iu, why: 'a clickable link is the most visible thing the plugin does' },
  ],
  /**
   * The artwork: the spoken label and the line drawn inside it. The drawn line IS
   * the approved tagline, so this kind carries the promise rather than the prose.
   */
  art: [
    { test: /jump anywhere/iu, why: 'the promise itself, spelled the approved way' },
  ],
  zh: [
    { test: /任何插件/u, why: 'the seam: third parties register their own category' },
    { test: /其余交给\s*Atlas/u, why: 'what the tagline delegates to the plugin' },
    { test: /可点/u, why: 'a clickable link is the most visible thing the plugin does' },
    { test: /跳/u, why: 'a session link navigates, the newest thing it does' },
    { test: /@/u, why: 'the trigger is the whole product' },
  ],
}
/** Wording that was deliberately retired and must not come back. */
const RETIRED = [
  { test: /@-able/u, why: 'the hyphenated compound was dropped for being hard to read' },
  { test: /Atlas does the rest/iu, why: 'replaced by the shorter "One @ . Jump anywhere." masthead' },
]
/**
 * The Chinese brand line is EXPECTED in the Chinese masthead and merely tolerated
 * in the English one (it is the same brand line, asserted by {@link TAGLINES}); any
 * other Han character in an English surface is a real mix-up.
 */
const HAN = /\p{Script=Han}/gu
const BRAND_HAN = new Set([...BRAND_LINE.replaceAll(' ', '')])
for (const [label, text, kind, hanRule] of SURFACES) {
  // The Chinese phrases are looked for with the brand line removed, or a line that
  // is mostly Han would satisfy them by itself.
  const checked = hanRule === 'exempt-brand' ? text.replace(BRAND_LINE, '') : text
  if (checked.trim() === '') {
    problems.push(`summary invariant: ${label} is empty`)
    continue
  }
  for (const phrase of PHRASES[kind]) {
    if (!phrase.test.test(checked)) problems.push(`summary invariant: ${label} is missing /${phrase.test.source}/ (${phrase.why})`)
  }
  for (const retired of RETIRED) {
    if (retired.test.test(checked)) problems.push(`summary invariant: ${label} carries retired wording /${retired.test.source}/ (${retired.why})`)
  }
  // `hanRule === 'clean'` means "this surface is entirely English": the only Han
  // characters it may contain are the brand line's own.
  if (hanRule === 'clean' && (checked.match(HAN) ?? []).some(char => !BRAND_HAN.has(char))) {
    problems.push(`summary invariant: ${label} mixes Han characters into a non-Chinese surface`)
  }
  if (/any plugin can register its own\.?\s*$/iu.test(checked)) {
    problems.push(`summary invariant: ${label} still carries an older tagline`)
  }
}
for (const [label, actual, expected] of TAGLINES) {
  if (actual !== expected) {
    problems.push(`summary invariant: ${label} tagline is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

if (problems.length > 0) {
  console.error('[verify-publish-surface] FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`[verify-publish-surface] ok — ${files.length} files, no internal artifacts, ad-free bundle`)
