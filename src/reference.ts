/**
 * Read-only inspection of referenced workspace paths, used by the browser dock
 * to price a reference (approximate context cost) and to flag references that no
 * longer resolve. Only directory-entry metadata crosses back: existence, kind,
 * and byte size. File content is never opened here — that promise is the whole
 * point of the plugin's reference model.
 */
import { isAbsolute, relative as pathRelative, resolve, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import type { ReferenceInfo } from './contract.ts'
import { allowsExternal, externalPath, type ExternalAccess } from './external.ts'

/**
 * Inspect reference paths: workspace-relative ones, plus the absolute
 * out-of-workspace ones this session is allowed to reference.
 *
 * Paths that escape the workspace, are external without access, or do not exist
 * come back with `exists: false` rather than being dropped, so the dock can
 * attribute the failure to the exact token the user typed.
 * @param cwd - the session workspace root (absolute).
 * @param targets - paths as typed, already stripped of line ranges.
 * @param signal - caller lifetime.
 * @param access - the session's out-of-workspace access, or undefined to refuse external paths.
 * @returns one row per target, in request order.
 */
export async function inspectReferences(
  cwd: string,
  targets: readonly string[],
  signal: AbortSignal,
  access?: ExternalAccess,
): Promise<readonly ReferenceInfo[]> {
  const out: ReferenceInfo[] = []
  for (const target of targets) {
    signal.throwIfAborted()
    out.push(await inspectOne(cwd, target, signal, access))
  }
  return out
}

/**
 * Inspect one target, confined to the workspace unless it is an allowed
 * external path.
 * @param cwd - the session workspace root (absolute).
 * @param target - one path as typed.
 * @param signal - caller lifetime.
 * @param access - the session's out-of-workspace access, or undefined to refuse external paths.
 * @returns the row for this target.
 */
async function inspectOne(cwd: string, target: string, signal: AbortSignal, access?: ExternalAccess): Promise<ReferenceInfo> {
  const external = isAbsolute(target)
  if (external && (access === undefined || !allowsExternal(access, target))) {
    return { relative: target, exists: false }
  }
  const absolute = external ? target : resolve(cwd, target)
  const confined = pathRelative(cwd, absolute)
  if (!external && (confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined))) {
    return { relative: target, exists: false }
  }
  signal.throwIfAborted()
  const info = await stat(absolute).catch(() => undefined)
  signal.throwIfAborted()
  if (info === undefined) return { relative: target, exists: false }
  const marked = external ? { outside: true as const, relative: externalPath(absolute) } : {}
  return info.isDirectory()
    ? { relative: target, exists: true, kind: 'dir', ...marked }
    : { relative: target, exists: true, kind: 'file', size: info.size, ...marked }
}
