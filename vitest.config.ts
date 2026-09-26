import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const dsh = (relative) => fileURLToPath(new URL(`../deepseek-harness/${relative}`, import.meta.url))

const decoratorSyntax = /@(?:Remote|RemoteScope)\b/

/**
 * Pre-transform standard (stage-3) decorators with the TypeScript compiler:
 * vitest's esbuild pipeline does not accept the `@Remote` decorators the host
 * runtime uses, so decorator-bearing modules pass through `ts.transpileModule`
 * first — the same approach the harness's shared vitest config takes.
 */
function standardDecoratorPlugin() {
  return {
    name: 'dsh-at-file-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

/**
 * Inline ad images as data URLs under vitest, mirroring build.mjs's esbuild
 * dataurl loader for .jpg/.png. Vite serves assets as plain URLs in dev/test
 * regardless of assetsInlineLimit, which would break the no-runtime-request
 * guarantee asserted by the ad specs.
 */
function inlineAdAssets() {
  return {
    name: 'dsh-atlas-inline-ad-assets',
    enforce: 'pre' as const,
    load(id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.(jpe?g|png|webp)$/i.test(file)) return
      const mime = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg'
      const encoded = readFileSync(file).toString('base64')
      return 'export default "data:' + mime + ';base64,' + encoded + '"'
    },
  }
}
export default defineConfig({
  plugins: [inlineAdAssets(), standardDecoratorPlugin()],
  resolve: {
    alias: {
      // The published /client bundles are browser module-loader format and
      // crash under Node; tests resolve the same entries to their sources.
      '@deepseek-ai/dsh-client-store': dsh('packages/client/store/src/index.ts'),
      // The Harness's own file-address grammar: the sent-message reference
      // bridge spells it itself (no new runtime dependency), so its spec
      // compares the two implementations and fails if the grammar drifts.
      '@deepseek-ai/dsh-util-workspace-path': dsh('packages/util/workspace-path/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-input-trigger/client': dsh('packages/client/ui-input-trigger/src/client/index.ts'),
      '@deepseek-ai/dsh-client-connection/client': dsh('packages/client/connection/src/client/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      exclude: [
        // Pure type declarations: no runtime code exists to cover.
        'src/types.ts',
      ],
    },
  },
})
