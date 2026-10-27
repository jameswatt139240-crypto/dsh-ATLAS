# Releasing

The release is a chain of gates, and each one answers a question the previous one
cannot. A version is "done" only when the last gate has run — for the version that is
actually on npm, not for the tree you built it from.

```bash
pnpm run check      # typecheck + vitest + build + verify:publish (the four local gates)
git tag v<version> && git push origin v<version>       # CI publishes through OIDC
./scripts/verify-registry-install.sh <version>         # ← the gate after publishing
```

## What each gate proves, and what it cannot

| Gate | Proves | Cannot see |
|---|---|---|
| `tsc --noEmit` | the source type-checks against the installed harness types | anything about the artifact |
| `vitest run` | behaviour, in jsdom and in fake hosts | the shipped bundle |
| `build` | `lib/` was produced, ads stripped by default | whether `lib/` is CURRENT |
| `verify-publish-surface` | `files` covers `lib/` + manifest + docs, no internal artifacts in the tarball | whether the host loads it |
| CI `publish` (OIDC) | the registry accepted the tarball | whether that tarball runs |
| **`verify-registry-install.sh`** | the published tarball installs **from the public registry** into a fresh profile, a host boots with it, the plugin registers, and the client bundle the host serves equals the package's own `lib/client.js` | host-version compatibility across versions; UI behaviour (that is the headless functional lane) |

The last row is not ceremony. `1.0.9-port.6` shipped with `lib/index.js` still at
commit `9ca2757`, missing the instance-level cache fix from `397f9da`: typecheck green,
1135 tests green, `build` green, `verify:publish` green — and every user got the stale
cache. Only installing from the registry and asking a real host what it serves can see
that.

## The acceptance gate

`scripts/verify-registry-install.sh <version>` (~90 s, exits non-zero on any failure):

1. reads `https://registry.npmjs.org/<pkg>/<version>`, tolerating CDN propagation
   (retries for 5 minutes — a 404 right after publishing is normal, not a failure);
2. downloads the tarball, and checks `sha1 == dist.shasum`, `tar` entries ==
   `fileCount`, the version inside the package, and that `lib/index.js`,
   `lib/client.js`, `lib/invariant.js` are all present and non-empty;
3. scaffolds a profile with the host's OWN template
   (`dsh acceptance --from-default-profile web`) — no copy of anybody's live profile —
   and asserts it does **not** start with the package in its dependencies;
4. installs through the user's own path, `dsh plugin --profile acceptance add
   <pkg>@<version>`, with `npm_config_registry` and `--registry` forced to the public
   registry so a lagging mirror cannot answer for it;
5. boots a host on `:3095`, reads the boot payload, and asserts the plugin is registered
   and the served client bundle equals the packaged `lib/client.js` — allowing exactly
   the two edits the host makes to every module it serves (the trailing
   `sourceMappingURL` is rewritten to the batch route, and a `"\n;"` separator follows
   the module body).

Run it locally against a version you just published, or against any older version to
check that it still installs:

```bash
./scripts/verify-registry-install.sh 1.0.9-port.9
./scripts/verify-registry-install.sh 1.0.9-port.9 --keep     # leave the host up on :3095
DSH_HOME=/tmp/my-check ACCEPTANCE_PORT=3099 ./scripts/verify-registry-install.sh 1.0.9
```

CI runs it as the `acceptance` job in `.github/workflows/release.yml`, after `publish`,
with the harness CLI and pnpm pinned. It runs even when `publish` skipped the upload
because the version was already on npm — the question is "does the published version
load", which is worth asking of any version.

## Dist-tags

A prerelease never takes `latest`. `1.0.9-port.9` publishes under the `port` dist-tag;
`latest` stays on the stable line. Installing a port build therefore means naming it:

```bash
dsh plugin --profile web add @sidequest-007/dsh-atlas@1.0.9-port.9
```

## Rollback

The package is inert until a profile installs it, so rollback is a version change:

```bash
dsh plugin --profile web add @sidequest-007/dsh-atlas@1.0.9   # back to the published 1.0.9
```

For the local port profile there is a second, faster path: `install-into-live.sh` writes
a stamped archive before it touches anything, and refuses a `--rollback` whose archive
came from a different profile:

```bash
./install-into-live.sh --rollback /home/ubuntu/dsh-atlas-rollback-<timestamp>.tgz
```

npm versions are immutable: a bad release is superseded, never edited. `npm dist-tag
add @sidequest-007/dsh-atlas@<old> port` moves the tag back.
