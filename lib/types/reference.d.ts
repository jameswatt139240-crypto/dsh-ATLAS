import type { ReferenceInfo } from './contract.ts';
import { type ExternalAccess } from './external.ts';
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
export declare function inspectReferences(cwd: string, targets: readonly string[], signal: AbortSignal, access?: ExternalAccess): Promise<readonly ReferenceInfo[]>;
