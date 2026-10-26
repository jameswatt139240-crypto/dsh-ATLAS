# Pre-release audit — `@sidequest-007/dsh-atlas` 1.0.9-port.8

This is the audit the release was signed off against. Every number below is reproduced by the
command beside it; nothing here is carried forward from an earlier run.

## 1. The three gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `./node_modules/.bin/tsc --noEmit` | 0 errors |
| Tests | `./node_modules/.bin/vitest run` | **1135 passed, 1 skipped** (43 files) |
| Build | `npm run build` | `lib/index.js` 849.6 kB, `lib/client.js` 1.1 MB, banner `WITHOUT ads` |
| Publish surface | `npm run verify:publish` | `ok — 67 files, no internal artifacts, ad-free bundle` |
| Coverage | `vitest run --coverage` | statements **98.41%** (5400/5487), branches **94.00%** (3651/3884), lines **99.41%** (4416/4442) |

The build is deterministic: rebuilding leaves `git status` clean for `lib/`.

## 2. What was released, and where it lives

| Fact | Value |
|---|---|
| npm version | **1.0.9-port.8** |
| npm dist-tags | `latest: 1.0.9`, `port: 1.0.9-port.8` |
| Tarball shasum | `26e828c4de7b179f6a0e32d5c1923c26aefd5c23` |
| Tarball `fileCount` | 67 (= `tar tzf` 67) |
| Unpacked size | 3 100 546 B |
| git tag | `v1.0.9-port.8` → `d831ad512d8447c218ec9184e73b9b5747e5c46d` |
| Repository | `https://github.com/jameswatt139240-crypto/dsh-ATLAS` |
| CI runner | `.github/workflows/release.yml` — publishes with **OIDC** trusted publishing; **no npm token exists in this workspace** |

### Installation verification (from the registry, on a clean profile)

1. `npm pack @sidequest-007/dsh-atlas@1.0.9-port.8 --registry=https://registry.npmjs.org` →
   sha1 `26e828c4de7b179f6a0e32d5c1923c26aefd5c23`, matching `dist.shasum`; `tar tzf` = 67 files.
2. Fresh profile (`/tmp/dsh-npm8/profiles/fromnpm`, deps: `@deepseek-ai/dsh-base` and
   `@deepseek-ai/dsh-web-app` 0.2.0-rc.2 + atlas `1.0.9-port.8`) → `npm install` reported
   `added 460 packages`; the installed atlas version is `1.0.9-port.8`.
3. Booted `DSH_HOME=/tmp/dsh-npm8 dsh --profile fromnpm --port 3096 --no-open` →
   `dsh web: http://127.0.0.1:3096/?token=…`; the only atlas log line is the expected
   `[dsh-atlas] this profile's settings service has no namespace API; "at-file" runs on defaults`
   (this profile has no dsh-purge shim — the plugin degrades instead of failing).
4. Client bundle served as `plugins/??@sidequest-007/dsh-atlas/client.js&rev=ee75804c05fd` → 200,
   1 123 850 B, containing 24 hits of the ported feature markers (`atlas-history-palette`,
   `historyJumpFrames`, …).
   Note: the bare `plugins/@sidequest-007/dsh-atlas/client.js` path 404s — the batched `??` form
   with `&rev=` is what this shell serves.

## 3. Coverage: what 98.34% actually means

87 statements over 16 modules remain. They are listed line by line in
[`coverage.md`](./coverage.md), split into three kinds, and **the gap is not dressed up as a
waiver**:

1. **Structurally unreachable in the shipped build** — the ad panel's registration (the artifact is
   built with `__DSH_ATLAS_ADS__ = false`; its logic is covered, its registration cannot run), and
   two Windows-only arms in `src/runtime.ts` (`:275`, `:407`) that POSIX cannot reach — measured, not
   assumed.
2. **Reachable, still untested** — I/O failing mid-iteration, a second concurrent caller, retired
   client fallbacks, the folder picker's terminal states.
3. **Defensive render/frame guards** — branches that need a DOM state which cannot be constructed
   without mocking the code under test (e.g. `dialogRef` empty while a keydown arrives).

100% was **not** claimed. Writing `/* v8 ignore */` over reachable branches would have produced a
number that lies about the artifact, so those branches stay named with their line numbers instead.

## 4. Rollback

The published package is additive: `1.0.9` (the upstream release) is untouched on npm, so any
profile can return to it with

```
dsh plugin --profile web add @sidequest-007/dsh-atlas@1.0.9
```

and pin `dist-tags.port` back if a whole channel needs reverting
(`npm dist-tag add @sidequest-007/dsh-atlas@1.0.9 port`). Locally, `~/.dsh/profiles/web` was
upgraded with a stamped backup (`dsh-atlas-rollback-*.tgz` + `.origin`); `install-into-live.sh
--rollback <archive>` refuses an archive whose stamp does not match the target profile.
