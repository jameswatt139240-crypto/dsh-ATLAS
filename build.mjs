/**
 * Single-file client + ESM host build for dsh-atlas.
 *
 * The web server serves exactly one file per plugin
 * (/plugins/<package name>/client.js), so the client half is one CJS bundle
 * wrapped in the ModuleLoader factory handshake; @deepseek-ai/dsh-* and react
 * stay external (the profile's healed node_modules and the app's module system
 * provide them). The host half is plain ESM for Node, externalizing
 * @deepseek-ai/dsh-* plus cordis while bundling schemastery (the Loader
 * validates Config against the schema).
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

/**
 * The client-module id, which is the PACKAGE NAME — `dsh-client-modules`
 * registers one record per package (`graphRow(packageName, …)`, "entry id
 * (package name)") and locates the package by matching the Loader entry name
 * against the manifest's `name`. Deriving it here means an npm scope change
 * (studio naming: `@sidequest-007/dsh-atlas`) can never leave the bundle announcing
 * an id nobody asked for — which is exactly how the client half silently
 * stopped loading once.
 */
const packageName = JSON.parse(readFileSync('package.json', 'utf8')).name

/**
 * Strip development-machine absolute paths from a bundle. esbuild heads each
 * inlined module with a `// <source path>` comment, which for a linked
 * workspace dependency is a local absolute path (`// D:/…/vendor/x.ts`). Those
 * never belong in a published artifact, so each such comment keeps only the
 * basename. Line count is preserved, so the local sourcemap stays usable.
 * @param file - bundle path relative to the package root.
 */
function scrubLocalPaths(file) {
  const text = readFileSync(file, 'utf8')
  const cleaned = text.replace(/^\/\/ [A-Za-z]:[^\n]*$/gm, line => `// ${line.split(/[\\/]/).pop()}`)
  if (cleaned !== text) writeFileSync(file, cleaned)
}

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

/**
 * Ad build switch. The default build carries NO ad: the panel module and its
 * banner images are replaced by stubs, so neither the ad code nor the image
 * bytes reach lib/client.js. Run `node build.mjs --ads` (or set
 * DSH_ATLAS_ADS=1) to produce the ad-bearing variant.
 */
const adsEnabled = process.argv.includes('--ads') || process.env.DSH_ATLAS_ADS === '1'

/** Replace the ad panel and its banner images with stubs in an ad-free build. */
const dropAdsPlugin = {
  name: 'dsh-atlas/drop-ads',
  setup(build) {
    // esbuild compiles these filters with Go's regexp (RE2): no `u` flag, and
    // only the syntax RE2 accepts.
    build.onResolve({ filter: /(^|\/)AdPanel\.tsx$/ }, args => ({ path: args.path, namespace: 'dsh-atlas-stub' }))
    build.onResolve({ filter: /(^|\/)ads\/[^/]+\.(webp|png|jpg|jpeg)$/ }, args => ({ path: args.path, namespace: 'dsh-atlas-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'dsh-atlas-stub' }, args => ({
      contents: /AdPanel\.tsx$/.test(args.path) ? 'export function MentionAd() { return null }' : 'export default ""',
      loader: 'js',
    }))
  },
}

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/invariant.ts'],
  outfile: 'lib/invariant.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [...dshExternal, 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  loader: {
    // Ad images inline as data URLs so the single-file client stays self-contained
    // and the ad never needs a runtime fetch (zero impact on warm/match). An
    // ad-free build never reaches these loaders: dropAdsPlugin stubs them out.
    '.jpg': 'dataurl',
    '.png': 'dataurl',
    '.webp': 'dataurl',
  },
  define: { __DSH_ATLAS_ADS__: adsEnabled ? 'true' : 'false' },
  plugins: adsEnabled ? [] : [dropAdsPlugin],
  logLevel: 'info',
})

console.log(adsEnabled
  ? '[dsh-atlas] client bundle: WITH the ad panel'
  : '[dsh-atlas] client bundle: WITHOUT ads (default)')

import { execFileSync } from 'node:child_process'
// Windows has no extensionless .bin shim; run the TypeScript compiler through
// the Node binary so the same build.mjs works on POSIX and Windows.
for (const artifact of ['lib/index.js', 'lib/invariant.js', 'lib/client.js']) scrubLocalPaths(artifact)
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })

if (!adsEnabled) {
  // The ad-free payload should not even carry the panel's type surface: tsc
  // emits one .d.ts per source file, so the stub build drops that declaration.
  rmSync('lib/types/client/AdPanel.d.ts', { force: true })
}