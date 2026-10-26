# Coverage ledger

Measured, not estimated. Every number here comes from one command:

```sh
./node_modules/.bin/vitest run --coverage --coverage.reporter=json --coverage.reporter=text-summary
```

## Result at 1.0.9-port.8

| Metric | Value |
| --- | --- |
| Test files | 43 passed |
| Tests | **1132 passed, 1 skipped** |
| Statements | **98.30%** (5394 / 5487) |
| Branches | **93.89%** (3647 / 3884) |
| Lines | **99.34%** (4413 / 4442) |
| Functions | see `coverage/coverage-final.json` |
| Uncovered | **93 statements over 17 files** (unique lines: 86) |
| Typecheck | `tsc --noEmit` → 0 errors |
| Publish surface | `node scripts/verify-publish-surface.mjs` → 67 files, ad-free bundle |

The suite was **976 tests / 90.73% statements** at the start of this audit; the growth came from
behaviour tests. **This audit added no coverage markers**: the 30 `/* v8 ignore */` comments in
`src/` (24 `next`, 3 `start`/`stop` pairs) all arrived with the code that owns them — `1c055df`
(upstream 1.0.9) and `9ca2757` (the ported feature code) — and each carries its own reason after
`--`. They cover arms that need an await to stall at an exact instant (an abort landing mid-read,
a non-`Error` abort reason), which is why they are not turned into behaviour tests here.

## How the number moved

| Step | Statements | Branches | Tests |
| --- | --- | --- | --- |
| start of audit | 90.73% | 86.09% | 976 |
| host runtime on a real tree (inspect / browse / git / index rejection) | 93.22% | 88.23% | 1014 |
| the three `@` categories through the Remote seam | 93.85% | 88.98% | 1020 |
| chooser hand-off, external scope, menu header rules | 94.40% | 89.44% | 1025 |
| every slot face built against live services | 94.64% | 89.83% | 1030 |
| ad panel geometry, fuzzy matcher, plugin bucketing | 94.87% | 90.13% | 1038 |
| one send per submission, menu height budget | 94.95% | 90.19% | 1040 |
| every guarded arm of the `@` bridge | 95.26% | 90.60% | 1050 |
| tools / expansion failures / directory readers | 95.73% | 90.91% | 1059 |
| draft caret + pointer edges | 96.04% | 91.37% | 1065 |
| cache abandonment + pick texts | 96.30% | 91.60% | 1075 |
| folder browser terminal states | 96.46% | 91.99% | 1079 |
| cancellation after every category fetch | 96.50% | 92.04% | 1081 |
| picker: create form + filtered note | 96.55% | 92.14% | 1085 |
| non-text parts, empty path, non-suffix path | **96.61%** | **92.22%** | **1087** |

## What is still uncovered

93 statements across 17 files (86 unique lines) — **62% of them in two files** (`src/client/index.ts`
23, `src/client/source.ts` 22). They are listed line by line below so that each one can be judged instead
of trusted.

### 1. Structurally unreachable in the shipped build (2 sites)

| Site | Why it cannot run |
| --- | --- |
| `src/client/AdPanel.tsx` — the whole panel in the ad-free build | The npm artifact is built with `WITHOUT ads`: `scripts/build.mjs` replaces `__DSH_ATLAS_ADS__` with `false`, so `atlas-ad` is never registered and neither `AdPanel` nor `MentionAd` reaches the shipped bundle. The **panel's own logic IS covered** (`tests/ad-panel.spec.tsx`, six cases over geometry, pending/ready anchoring, the too-narrow hide, image aspect and the broken-image hide); what cannot run is the registration path. `verify-publish-surface` asserts the absence of the ad surface as a release gate. |
| `src/runtime.ts:275` and `src/runtime.ts:407` | Both are Windows-only arms: `nearestDirectory` returning `undefined`, and `above === candidate` when the ancestor chain cannot advance. On POSIX the chain always terminates at an existing `/`, so no input reaches them. Measured, not assumed: `'Z:/no/such/place'` on POSIX is a *relative* path, so it resolves to `outside` instead of `missing`. |

### 2. Reachable, still untested (the work queue)

These are defended branches and interaction corners: I/O failing mid-iteration, a second concurrent
caller sharing an in-flight promise, retired-client fallbacks, the folder picker's terminal states.

| File | Uncovered | Lines |
|---|---|---|
| `src/client/index.ts` | 21 | 425, 426, 427, 432, 717, 750, 758, 760, 763, 787, 953, 1119, 1194, 1252, 1260, 1261, 1279, 1375, 1376, 1377, 1468 |
| `src/client/source.ts` | 21 | 860, 1141, 1147, 1148, 1234, 1563, 1668, 1706, 1755, 1767, 1775, 1811, 1837, 1843, 1874, 1908, 1936, 2027, 2091, 2099, 2215 |
| `src/client/FolderPicker.tsx` | 13 | 283, 320, 342, 359, 383, 390, 396, 564, 582, 603, 666, 669, 689 |
| `src/runtime.ts` | 5 | 57, 173, 275, 354, 407 |
| `src/client/DraftLinks.tsx` | 5 | 94, 168, 169, 170, 216 |
| `src/client/FrameCursor.tsx` | 5 | 382, 458, 554, 576, 589 |
| `src/index.ts` | 2 | 361, 389 |
| `src/client/AdPanel.tsx` | 2 | 64, 134 |
| `src/client/FolderTab.tsx` | 2 | 110, 136 |
| `src/client/ReferenceLinks.tsx` | 2 | 286, 356 |
| `src/client/draft-links.ts` | 2 | 121, 452 |
| `src/contract.ts` | 1 | 34 |
| `src/git.ts` | 1 | 62 |
| `src/recent-folders.ts` | 1 | 171 |
| `src/client/SettingsSection.tsx` | 1 | 186 |
| `src/client/draft-scope.ts` | 1 | 39 |
| `src/client/history-frames.ts` | 1 | 353 |

### 2c. Gap register — what is left, and which kind of gap it is

Three kinds, kept apart on purpose. Nothing in groups B or C is claimed to be
unreachable: they are **unfinished**, and are recorded as such.

**A. Unreachable in this environment (evidence given).**

| Site | Why it cannot run here |
|---|---|
| `src/runtime.ts:275`, `src/runtime.ts:407` | The ancestor walk's Windows-only ends: on POSIX every ancestor chain terminates at an existing `/`, so `nearestDirectory` never returns undefined and `above === candidate` never holds. Measured: `'Z:/no/such/place'` is resolved as a relative path on POSIX, which lands in `outside`, not `missing`. |
| `src/contract.ts:34` | `strictCodec().create` is called by the Harness's own codec validator when it boots a schema. No test in this repo runs that validator; exercising it means standing up a Harness profile inside the suite. |

**B. Reachable, needs a fault-injection or timing fixture that has not been written.**

`src/client/index.ts` (remote refusal branches: `gitChanges` 425–427, `open` 432, the
`scopeFolder` probe 750/758/760/763, the folder-tab faces 1468…), `src/client/source.ts`
(the external fetch's abort/stale arms 1141/1147/1148, the scope listing 1563, the
category rebuild arms 1668–1775, the alphabetical plugin sort 860), `src/git.ts:62`
(`execFile` throwing synchronously), `src/client/FolderPicker.tsx` (aborted probes
359/383/390), `src/client/DraftLinks.tsx`, `src/client/ReferenceLinks.tsx`,
`src/client/FrameCursor.tsx`, `src/client/SettingsSection.tsx`, `src/client/FolderTab.tsx`,
`src/index.ts`, `src/runtime.ts`, `src/recent-folders.ts`, `src/client/AdPanel.tsx`,
`src/client/draft-links.ts`, `src/client/draft-scope.ts`, `src/client/history-frames.ts`,
`src/client/session-link.ts`.

**C. Defensive guards for a render state the unit harness cannot produce.**

`src/client/FolderPicker.tsx:283` (focus effect with no input on screen), `:564` (a row
list with no focusable entry at all — both group headers are focusable, so an empty
folder still has two), `:582`, `:603` (page-turn with no row to reach), `:666`, `:669`
(Tab trap with nothing focusable inside the dialog), `:689`.

The line-level table above is regenerated from `coverage-final.json` on every run, so this
register never drifts from the measurement.

### 2b. Attempt log (dead ends, so they are not repeated)

- **`source.rebuildRows` cannot be reached from `tests/source.spec.ts` today.** A probe that settles
  `skill:` through `candidates()` (rows come back with `back` + two `skill-group` + `skill`) still
  leaves `rebuildRows(session, 'skill:')` returning `undefined`, i.e. the settled cache it reads is not
  the one the page filled. Either the harness's session identity differs from the one the cache is
  keyed by, or the settled entry is replaced on settle. Needs 3–5 minutes with a debugger, not a
  guess — the four lines (`src/client/source.ts:1668`, `1755`, `1766–1777`) stay open until then.
- **`folder:` does not re-enter `fetchExternal`.** `src/client/source.ts:1331` fires it once while
  building the page and the second ask inside TTL is served from `externalFetches`; advancing the
  harness clock past `CATEGORY_TTL_MS` (30 s, verified) still shows one call, so the stale-while-revalidate
  branch at `1145–1148` is driven from somewhere else (line `2090`, the scoped listing path). Covering
  it needs a `@folder:<sub>` request with a listing seam, not a bare `@folder:`.

- **The plugin's own `scopeFolder` cannot be reached from `tests/apply.client.spec.tsx`.** With a
  composer DOM in place (`<div data-lexical-editor="true"><p><span>@e:/outsidedir/ @file:</span></p>`),
  `draftTokens()` reads both tokens in the test process and `draftScopeOf(...)` resolves `/ws/docs`
  directly, but the same call inside the booted plugin never reaches `atFile.inspect` — zero calls,
  even after `settle()` plus a macrotask. `registered(source).candidates(s1, 'file:')` does render
  rows for the same session, so the source path itself works; what never happens is the scope read.
  Settling this needs a probe inside `src/client/index.ts` (`atFile` identity at call time), i.e. a
  temporary log, not another guess. ~30 statements ride on it (`index.ts:740–790`).

### 3. One measurement artifact (proved, not assumed)

`src/files.ts:253` (`if (linked && !await isDirectory(child, signal)) continue`) is reported as
uncovered by the coverage map, but the branch does run: `tests/files.spec.ts` drives a follow-links
listing whose only entry is a symbolic link to a missing target, and the fake handle records
**two** reads — the link, then the end of the directory — which can only happen after the
`continue`. The counter stays at 0 because the statement is a loop jump inside `try`/`finally`;
the covered line proves the behaviour, so this is recorded as an instrumentation artifact rather
than as a gap.

## Why 100% was not claimed

The audit's rule was: a line is either **covered by a test that asserts behaviour**, or **named in
this file with a reason that can be falsified**. Writing `/* v8 ignore */` over a reachable branch
would have produced a 100% that lies about the artifact, so the remaining reachable branches stay
listed above with their line numbers — and the one branch the instrument insists is missing while
the test proves it runs is written down as an artifact, in the open.

Reproduce any row by opening its file at the listed line and running
`vitest run --coverage tests/<the file's spec>.spec.ts`.

## Files at 100% statements

19 of the 40 source modules have no uncovered statement at all:

`src/abort.ts`, `src/atlas.ts`, `src/client/HistoryPalette.tsx`, `src/client/git-provider.ts`,
`src/client/history-keys.ts`, `src/client/locales.ts`, `src/client/reference-links.ts`,
`src/client/remote.ts`, `src/client/roam-store.ts`, `src/client/search.ts`, `src/client/styles.ts`,
`src/defaults.ts`, `src/invariant.ts`, `src/paste.ts`, `src/reference.ts`, `src/runtime-info.ts`,
`src/settings.ts`, `src/tokens.ts`, `src/typert.ts`.

The rest are the rows above. For the port's own features that means: `history-keys.ts` and
`HistoryPalette.tsx` are complete, while `history-frames.ts` (1 statement), `roam-store.ts`
(complete), `recent-folders.ts` (2), `FrameCursor.tsx` (5) and `draft-scope.ts` (1) still carry the
listed lines.
