# Coverage ledger

Measured, not estimated. Every number here comes from one command:

```sh
./node_modules/.bin/vitest run --coverage --coverage.reporter=json --coverage.reporter=text-summary
```

## Result at 1.0.9-port.8

| Metric | Value |
| --- | --- |
| Test files | 42 passed |
| Tests | **1040 passed, 1 skipped** |
| Statements | **94.95%** (5210 / 5487) |
| Branches | **90.19%** (3503 / 3884) |
| Lines | **97.09%** (4313 / 4442) |
| Functions | see `coverage/coverage-final.json` |
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
| one send per submission, menu height budget | **94.95%** | **90.19%** | **1040** |

## What is still uncovered

247 statements across 28 files. They are listed line by line below so that each one can be
judged instead of trusted.

### 1. Structurally unreachable in the shipped build (2 sites)

| Site | Why it cannot run |
| --- | --- |
| `src/client/AdPanel.tsx` — the whole panel in the ad-free build | The npm artifact is built with `WITHOUT ads`: `scripts/build.mjs` replaces `__DSH_ATLAS_ADS__` with `false`, so `atlas-ad` is never registered and neither `AdPanel` nor `MentionAd` reaches the shipped bundle. The **panel's own logic IS covered** (`tests/ad-panel.spec.tsx`, six cases over geometry, pending/ready anchoring, the too-narrow hide, image aspect and the broken-image hide); what cannot run is the registration path. `verify-publish-surface` asserts the absence of the ad surface as a release gate. |
| `src/runtime.ts:275` and `src/runtime.ts:407` | Both are Windows-only arms: `nearestDirectory` returning `undefined`, and `above === candidate` when the ancestor chain cannot advance. On POSIX the chain always terminates at an existing `/`, so no input reaches them. Measured, not assumed: `'Z:/no/such/place'` on POSIX is a *relative* path, so it resolves to `outside` instead of `missing`. |

### 2. Reachable, still untested (the work queue)

These are defended branches (I/O failure mid-iteration, a second concurrent caller sharing an
in-flight promise, retired-client fallbacks) and interaction corners. None of them is exempt:
each has a test shape that would cover it, and the table is the queue.

| `src/client/index.ts` | 55 | 425, 426, 427, 432, 500, 501, 530, 544, 622, 636, 649, 662, 663, 680, 681, 685, 716, 717, 718, 719, 720, 750, 751, 753, 755, 756, 757, 758, 759, 760, 761, 762, 763, 764, 765, 787, 953, 1119, 1194, 1252, 1260, 1261, 1279, 1306, 1310, 1311, 1314, 1329, 1330, 1347, 1348, 1375, 1376, 1377, 1468 |
| `src/client/source.ts` | 54 | 475, 801, 860, 1021, 1031, 1032, 1073, 1083, 1084, 1141, 1145, 1147, 1148, 1234, 1462, 1467, 1468, 1469, 1502, 1503, 1563, 1668, 1706, 1755, 1766, 1767, 1768, 1775, 1795, 1800, 1810, 1811, 1812, 1837, 1843, 1874, 1876, 1908, 1927, 1936, 2023, 2024, 2025, 2027, 2090, 2091, 2099, 2104, 2108, 2116, 2165, 2168, 2206, 2215 |
| `src/client/FolderPicker.tsx` | 18 | 283, 320, 342, 359, 383, 390, 396, 550, 564, 582, 603, 666, 669, 689, 770, 773, 837, 840 |
| `src/client/MentionNavigator.tsx` | 16 | 104, 111, 234, 261, 282, 299, 305, 306, 307, 309, 310, 367, 371, 533, 536, 539 |
| `src/client/DraftLinks.tsx` | 14 | 72, 94, 145, 165, 166, 167, 168, 169, 170, 177, 179, 181, 194, 216 |
| `src/files.ts` | 10 | 234, 235, 236, 321, 322, 323, 327, 328, 332, 445 |
| `src/index.ts` | 10 | 193, 196, 319, 324, 342, 361, 366, 371, 374, 389 |
| `src/tools.ts` | 9 | 60, 118, 124, 127, 142, 144, 155, 170, 180 |
| `src/mention.ts` | 7 | 230, 254, 255, 260, 261, 266, 267 |
| `src/client/draft-links.ts` | 7 | 118, 119, 120, 121, 208, 261, 452 |
| `src/runtime.ts` | 5 | 57, 173, 275, 354, 407 |
| `src/client/AdPanel.tsx` | 5 | 64, 134, 156, 157, 161 |
| `src/client/FrameCursor.tsx` | 5 | 382, 458, 554, 576, 589 |
| `src/client/FolderTab.tsx` | 4 | 105, 110, 136, 168 |
| `src/references.ts` | 3 | 72, 172, 283 |
| `src/client/FilesDock.tsx` | 3 | 122, 127, 152 |
| `src/client/MenuIcons.tsx` | 3 | 78, 129, 141 |
| `src/client/SettingsSection.tsx` | 3 | 163, 164, 186 |
| `src/client/icons.tsx` | 3 | 170, 251, 252 |
| `src/git.ts` | 2 | 62, 146 |
| `src/recent-folders.ts` | 2 | 144, 171 |
| `src/client/ReferenceLinks.tsx` | 2 | 286, 356 |
| `src/client/session-link.ts` | 2 | 49, 95 |
| `src/contract.ts` | 1 | 34 |
| `src/external.ts` | 1 | 71 |
| `src/client/draft-scope.ts` | 1 | 39 |
| `src/client/history-frames.ts` | 1 | 353 |
| `src/client/model.ts` | 1 | 26 |

## Why 100% was not claimed

The audit's rule was: a line is either **covered by a test that asserts behaviour**, or **named in
this file with a reason that can be falsified**. Writing `/* v8 ignore */` over a reachable branch
would have produced a 100% that lies about the artifact, so the remaining reachable branches stay
listed above with their line numbers.

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
