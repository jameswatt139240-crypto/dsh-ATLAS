# Security

## Reporting

Open a private report through [GitHub Security Advisories](https://github.com/jameswatt139240-crypto/dsh-ATLAS/security/advisories/new).
Please do not file a public issue for a suspected vulnerability.

Expect an acknowledgement within a few days. This is a single-maintainer
project, so timelines are best-effort rather than contractual.

## What this plugin can and cannot reach

dsh-ATLAS runs inside the DeepSeek Harness host and is bound by the host's
permission model. Three points matter for anyone reviewing it:

- **The Host never opens a referenced file to price it.** A mention carries a
  path, a kind, and a byte size; the token estimate is `size / 4` for a whole
  file and `lines × 12` for a line range. Reading the content is the model's
  job, through an ordinary filesystem tool, after the reference is injected.
- **Paths outside the workspace require the host's external-access grant.**
  `allowsExternal` gates every absolute path that escapes the project root, so
  a narrow-permission session cannot use this plugin as a way around it.
- **What gets injected is a marker, not content.** `<workspace-reference>`,
  `<external-reference>` and their siblings name the target; they do not
  inline file bodies.

Declared capabilities: `shell`, `dynamic-code`, `fs-read`. The `shell` grant
exists because the bundled `@git` category runs `git` to list refs and diffs.

## Dependencies

`lib/` is committed build output. It includes the DeepSeek Harness client
runtime, which embeds [Schemastery](https://github.com/shigma/schemastery) —
the source of the `new Function` in `lib/index.js` that static scanners flag as
dynamic execution. That call evaluates a schema's own declared callback string
at schema-construction time and is the upstream library's long-standing
behaviour; this project does not add any `eval`, `new Function`, or `vm` usage
of its own. `src/` contains none.
