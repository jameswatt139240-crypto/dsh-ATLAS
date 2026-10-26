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
import { allowsExternal, externalPath, isUnder, type ExternalAccess } from './external.ts'

/**
 * Inspect reference paths: workspace-relative ones, plus the absolute
 * out-of-workspace ones this session is allowed to reference.
 *
 * Paths that escape the workspace, are external without access, or do not exist
 * come back with `exists: false` rather than being dropped, so the dock can
 * attribute the failure to the exact token the user typed. An absolute path that
 * lands inside the workspace is a workspace path, not an external one, so it is
 * inspected exactly like its relative spelling.
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
 * external path. An absolute path inside the workspace is the workspace case,
 * not the external one.
 * @param cwd - the session workspace root (absolute).
 * @param target - one path as typed.
 * @param signal - caller lifetime.
 * @param access - the session's out-of-workspace access, or undefined to refuse external paths.
 * @returns the row for this target.
 */
async function inspectOne(cwd: string, target: string, signal: AbortSignal, access?: ExternalAccess): Promise<ReferenceInfo> {
  const external = isAbsolute(target)
  const absolute = external ? target : resolve(cwd, target)
  // An absolute path that points INSIDE the workspace is a workspace path that
  // merely happens to be spelled absolutely: on Linux a session rooted at
  // `/mnt/share` names the same folder as `/mnt/share/proj` and as `proj`, and a
  // Windows session rooted at `E:/proj` names the same tree as `E:/proj/src` and
  // `src`. The external gate must therefore not apply to it — exactly as
  // `list`/`browse` already rule it (`src/runtime.ts`). Without this bypass the
  // two spellings of one folder disagreed: the relative one resolved, the
  // absolute one was refused, and the dock painted the reference stale.
  const inside = external && isUnder(cwd, absolute)
  if (external && !inside && (access === undefined || !allowsExternal(access, target))) {
    return { relative: target, exists: false }
  }
  const confined = pathRelative(cwd, absolute)
  if (!external && (confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined))) {
    return { relative: target, exists: false }
  }
  signal.throwIfAborted()
  const info = await stat(absolute).catch(() => undefined)
  signal.throwIfAborted()
  if (info === undefined) return { relative: target, exists: false }
  const marked = external && !inside ? { outside: true as const, relative: externalPath(absolute) } : {}
  return info.isDirectory()
    ? { relative: target, exists: true, kind: 'dir', ...marked }
    : { relative: target, exists: true, kind: 'file', size: info.size, ...marked }
}
