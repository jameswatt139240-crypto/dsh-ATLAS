/**
 * The running Harness facts the `@` seam's version gate needs.
 *
 * The gate can only judge a provider's `testedOn` claim against a real version,
 * so the Host reports its own. Reading is best-effort by design: an unresolvable
 * or malformed package must yield `undefined` — never a guess — because an
 * unproven provider has to keep reading as unproven.
 */
import { createRequire } from 'node:module'

/** The package whose version identifies the running Harness. */
const DSH_PACKAGE = '@deepseek-ai/dsh/package.json'

/**
 * The anchors to try, in order, when locating the running Harness manifest.
 *
 * `entry` — the process's own entry point — is the Harness that is actually up,
 * and it is the only anchor whose answer can be trusted when the plugin's own
 * module graph reaches a *different* Harness build. That is the normal shape of
 * a linked development install: the profile loads the plugin from the checkout
 * while the running CLI comes from the global install, so a plugin-anchored
 * lookup resolves the checkout (or nothing at all) and every `testedOn` claim
 * would be judged against the wrong version. `self` stays as the fallback for
 * launches where the entry point is a loader rather than the Harness.
 * @param entry - `process.argv[1]`, or undefined when the process has none.
 * @param self - this module's own URL.
 * @returns the anchors, most trustworthy first.
 */
export function versionAnchors(entry: string | undefined, self: string): readonly string[] {
  return entry === undefined || entry === '' ? [self] : [entry, self]
}

/**
 * Read the first anchor that yields a manifest, or rethrow the last failure.
 * @param anchors - candidate anchors, most trustworthy first.
 * @param read - how to read the manifest at one anchor.
 * @returns the manifest text from the first anchor that had one.
 */
export function readFirstAvailable(
  anchors: readonly string[],
  read: (anchor: string) => string,
): string {
  let failure: unknown
  for (const anchor of anchors) {
    try {
      return read(anchor)
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/**
 * Read the installed DSH version.
 * @param resolvePackageJson - how to locate the package manifest; injectable so
 *   the failure paths are testable without a broken install.
 * @returns the version string, or undefined when it cannot be established.
 */
export function readDshVersion(
  resolvePackageJson: () => string = defaultResolve,
): string | undefined {
  try {
    const raw = resolvePackageJson()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    // Either the Harness package is not resolvable from any anchor (a source
    // launch) or its manifest is unreadable: both mean "version unknown", not
    // "matches".
    return undefined
  }
}

/** Locate and read the DSH manifest through the Node resolver. */
function defaultResolve(): string {
  return readFirstAvailable(versionAnchors(process.argv[1], import.meta.url), manifestAt)
}

/** Read the DSH manifest as resolved from one anchor (a path or file URL). */
function manifestAt(anchor: string): string {
  const require = createRequire(anchor)
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a JSON manifest has no ESM import form.
  return require('node:fs').readFileSync(require.resolve(DSH_PACKAGE), 'utf8') as string
}
