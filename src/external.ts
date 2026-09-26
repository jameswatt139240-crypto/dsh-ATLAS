/**
 * Out-of-workspace references (the "external roots" rule).
 *
 * The framework does NOT forbid them: `dsh-fs-sandbox` fences WRITES only
 * (`read-only` denies every mutation, `workspace-write` confines writes to the
 * workspace and the platform temp areas, `danger-full-access` fences nothing),
 * the workspace-files service accepts absolute paths, and
 * `session.openWorkspacePath` never checks containment. "No path outside the
 * workspace" is therefore THIS plugin's rule, and this module is where it is
 * relaxed — deliberately, and behind a gate:
 *
 * - `danger-full-access` (the product's 「完全权限」 preset): any existing
 *   absolute path may be referenced, and using one records it in the durable
 *   ledger so it can be offered again without any search.
 * - every narrower mode: only paths that ledger already holds, i.e. paths the
 *   user referenced themselves while in full access. Nothing new becomes
 *   visible and no search widens.
 *
 * The verdict is computed on the HOST (settings plus `ctx.sandboxPolicy`), never
 * in the browser: the client renders what the host allows and nothing more.
 */
import { workspacePathKey } from './defaults.ts'

/** The one sandbox mode that may DISCOVER new external paths. */
export const EXTERNAL_ADDING_MODE = 'danger-full-access'

/** The sandbox modes this plugin understands; anything else is treated as narrow. */
export type SandboxModeName = 'read-only' | 'workspace-write' | 'danger-full-access'

/** What one session may do with out-of-workspace paths right now. */
export interface ExternalAccess {
  /** Whether this session may reference and search paths the ledger does not know yet. */
  readonly canDiscover: boolean
  /** Ledger directories this session may reference INTO, as canonical paths. */
  readonly roots: readonly string[]
  /** Ledger paths this session may reference EXACTLY (files included). */
  readonly known: readonly string[]
}

/** The access a session with no resolved policy gets: ledger paths only. */
export const NO_EXTERNAL_DISCOVERY: ExternalAccess = { canDiscover: false, roots: [], known: [] }

/**
 * Build one session's access from its resolved sandbox mode and the ledger.
 * @param mode - the resolved sandbox mode, or undefined when the host has no policy service.
 * @param roots - ledger directories associated with this workspace.
 * @param known - every ledger path associated with this workspace, files included.
 * @returns the access verdict for this session.
 */
export function externalAccess(
  mode: string | undefined,
  roots: readonly string[],
  known: readonly string[] = [],
): ExternalAccess {
  return { canDiscover: mode === EXTERNAL_ADDING_MODE, roots, known }
}

/**
 * Whether one absolute path may be referenced under this access.
 *
 * A discovering session may reference anything that exists; a narrow one only
 * what the ledger already holds — the exact paths the user referenced before
 * (files included) and anything inside the ledger's directories.
 * @param access - the session's access verdict.
 * @param absolute - an absolute candidate path.
 * @returns true when the path is allowed.
 */
export function allowsExternal(access: ExternalAccess, absolute: string): boolean {
  if (access.canDiscover) return true
  const key = workspacePathKey(absolute)
  if (key === '') return false
  if (access.known.some(entry => workspacePathKey(entry) === key)) return true
  return access.roots.some(root => isUnder(root, absolute))
}

/**
 * Whether a path lies inside a directory (the directory itself counts).
 *
 * Compares canonical keys and requires a separator boundary, so a sibling whose
 * name merely starts the same (`…/b` vs `…/bc`) is never treated as inside.
 * @param root - the containing directory.
 * @param target - the candidate path.
 * @returns true when target is root or below it.
 */
export function isUnder(root: string, target: string): boolean {
  const rootKey = workspacePathKey(root)
  const targetKey = workspacePathKey(target)
  if (rootKey === '' || targetKey === '') return false
  if (targetKey === rootKey) return true
  return targetKey.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`)
}

/** The canonical spelling of one external path, as tokens and the ledger carry it. */
export function externalPath(absolute: string): string {
  return absolute.replace(/\\/gu, '/')
}

/**
 * Whether one path is absolute rather than workspace-relative.
 *
 * Both halves need this: the host decides whether a reference escapes the
 * workspace at all, and the browser half must not look an absolute path up in a
 * workspace-relative index (it would never be there). A drive-relative spelling
 * (`E:foo`) is NOT absolute — it names nothing stable, so it stays a relative
 * path and is refused by the host's own confinement test.
 * @param value - a path as typed, picked, or recorded.
 * @returns true for `E:/…`, `E:\…`, `/…`, or a UNC `\\server\share`.
 */
export function isAbsoluteReference(value: string): boolean {
  return /^[a-z]:[/\\]/iu.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}
