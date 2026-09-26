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
export declare function versionAnchors(entry: string | undefined, self: string): readonly string[];
/**
 * Read the first anchor that yields a manifest, or rethrow the last failure.
 * @param anchors - candidate anchors, most trustworthy first.
 * @param read - how to read the manifest at one anchor.
 * @returns the manifest text from the first anchor that had one.
 */
export declare function readFirstAvailable(anchors: readonly string[], read: (anchor: string) => string): string;
/**
 * Read the installed DSH version.
 * @param resolvePackageJson - how to locate the package manifest; injectable so
 *   the failure paths are testable without a broken install.
 * @returns the version string, or undefined when it cannot be established.
 */
export declare function readDshVersion(resolvePackageJson?: () => string): string | undefined;
