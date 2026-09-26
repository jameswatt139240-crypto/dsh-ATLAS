/**
 * Pure display projections for the @file picker: the split of a relative path
 * into basename + directory for the picker rows. The Host validates selected
 * paths and adds existence-only reference markers at send time.
 */

/** The directory prefix of a forward-slash relative path ('' for root-level files). */
export function dirnameOf(relative: string): string {
  const at = relative.lastIndexOf('/')
  return at < 0 ? '' : relative.slice(0, at)
}

/** The basename of a forward-slash relative path. */
export function basenameOf(relative: string): string {
  const at = relative.lastIndexOf('/')
  return at < 0 ? relative : relative.slice(at + 1)
}

/**
 * Derive the canonical workspace path from an absolute file path and its
 * workspace-relative path (the index walk emits forward-slash relatives).
 */
export function workspaceFromAbsolute(absolute: string, relative: string): string {
  const normalized = absolute.replaceAll('\\', '/')
  const suffix = relative.replaceAll('\\', '/')
  if (!normalized.endsWith(suffix)) return normalized
  const prefix = normalized.slice(0, normalized.length - suffix.length)
  return prefix.replace(/\/+$/u, '')
}

/**
 * The canonical key one referenced path is looked up under.
 *
 * A verdict and the token it answers for do not always spell a path the same
 * way: the Host answers an out-of-workspace path in its own canonical spelling
 * (forward slashes) while the user typed the platform's (`@E:\…`), and a folder
 * mention may carry a trailing separator the path itself has not. Every verdict
 * map is keyed — and every lookup made — through this, so the answer is found
 * whichever spelling the draft used.
 * @param value - a referenced path in either separator spelling.
 * @returns the key both sides agree on.
 */
export function referenceKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '')
}

/**
 * One child path under one directory, safe at a drive root.
 *
 * A listing's `path` carries a trailing separator only when it IS a drive root
 * (`E:/`), so a plain `${path}/${name}` would produce `E://name` there. Both the
 * folder tab and the menu browser join paths through this.
 * @param path - the listing's own canonical path.
 * @param name - one entry name.
 * @returns the child's canonical path.
 */
export function childOf(path: string, name: string): string {
  return `${path.replace(/[/\\]+$/u, '')}/${name}`
}
