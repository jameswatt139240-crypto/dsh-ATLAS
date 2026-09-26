# Contributing to dsh-atlas

A **Side Quest** (工作室：支线任务, **Side Quest Labs**) project: npm scope `@sidequest-007/*`, repository [`jameswatt139240-crypto/dsh-ATLAS`](https://github.com/jameswatt139240-crypto/dsh-ATLAS), while the DSH plugin id keeps the ecosystem's unscoped `dsh-*` form.

Thanks for looking. This file is short on purpose: it says what a change has to pass, and what the one real obstacle is.

## The obstacle: this repository builds against a DSH source checkout

`devDependencies` are `link:` entries into a DeepSeek Harness **source checkout**, expected at `../deepseek-harness` beside this repository. That is deliberate — it is how the plugin is tested against the same source the Harness itself is built from — but it means a plain `git clone` is **not** buildable on its own:

```sh
git clone https://github.com/jameswatt139240-crypto/dsh-ATLAS
git clone <dsh source checkout> ../deepseek-harness   # or repoint the links in package.json
cd dsh-ATLAS
pnpm install
```

The framework packages are also published on npm (for example `@deepseek-ai/dsh-client-ui-conversation@0.1.6-alpha.1`), so repointing `package.json` at those versions works too — it is just not the configuration this repository is verified in. If you do that and `pnpm run check` stays green, that is a result worth an issue on its own.

## The ladder every change must pass

```sh
pnpm run check
```

which is, in order:

1. `pnpm run typecheck` — `tsc --noEmit`
2. `pnpm run test` — vitest; node-env specs, plus jsdom specs for the browser half
3. `pnpm run build` — esbuild → `lib/` (the ad-free build; `lib/` is committed)
4. `pnpm run verify:publish` — the publish-surface gate

**`lib/` is committed.** A user's profile installs this package with `link:` or from git and runs no build, so a source change that is not rebuilt into `lib/` simply does not ship. `pnpm run check` rebuilds it for you; commit the result with the source.

## Conventions this repository actually enforces

- **Comments and JSDoc are English; product copy is Chinese.** User-visible strings live in `src/client/locales.ts` (the `zh` dictionary) with the English `en` entry beside it.
- **Never read a referenced file.** The Host validates paths/categories and injects markers; it never opens a referenced file and never lists a referenced directory. `atFile/inspect` returns entry metadata only (`stat`). If a change needs file content, it belongs in the agent's tools, not here.
- **The token grammar is shared, not copied.** `@[^\s@]+`, the category handles, and the line-range spelling are one implementation in `src/tokens.ts`, mirrored deliberately by the Host scan and the client dock. Change one, change all.
- **Client plugins are one file.** The web server serves exactly one artifact per client plugin: `lib/client.js`. Styles are the injected string in `src/client/styles.ts`; no CSS artifacts.
- **Providers are not special-cased.** The menu, the injection, and the click-through learn about a provider only through what it declared on the `ctx.atlas` seam. Nothing in this package enumerates providers.
- **A user-visible promise needs a spec beside it.** Every claim the READMEs make about behaviour (link colouring, the "Missing" state, the keyboard gestures, the cost badge) is covered by a test in `tests/`. Documentation that drifts from behaviour is treated as a bug, not as prose.

## Reporting a bug

Include: what you did, what happened, what you expected, and the browser console output if the client half is involved (`[dsh-atlas] …` lines are ours). If the Host half is involved, the `dsh` process output. A screenshot of the composer is worth a lot for anything about the menu or the draft.

## License

By contributing you agree your changes are licensed under this repository's terms: **MIT** (see `LICENSE`). Files carried over from [`dsh-at-file`](https://github.com/FSMargoo/dsh-at-file) keep that project's MIT copyright notice, preserved in `LICENSE-ORIGINAL`; `NOTICE` maps which files came from it.
