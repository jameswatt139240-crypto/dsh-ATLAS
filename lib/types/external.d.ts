/** The one sandbox mode that may DISCOVER new external paths. */
export declare const EXTERNAL_ADDING_MODE = "danger-full-access";
/** The sandbox modes this plugin understands; anything else is treated as narrow. */
export type SandboxModeName = 'read-only' | 'workspace-write' | 'danger-full-access';
/** What one session may do with out-of-workspace paths right now. */
export interface ExternalAccess {
    /** Whether this session may reference and search paths the ledger does not know yet. */
    readonly canDiscover: boolean;
    /** Ledger directories this session may reference INTO, as canonical paths. */
    readonly roots: readonly string[];
    /** Ledger paths this session may reference EXACTLY (files included). */
    readonly known: readonly string[];
}
/** The access a session with no resolved policy gets: ledger paths only. */
export declare const NO_EXTERNAL_DISCOVERY: ExternalAccess;
/**
 * Build one session's access from its resolved sandbox mode and the ledger.
 * @param mode - the resolved sandbox mode, or undefined when the host has no policy service.
 * @param roots - ledger directories associated with this workspace.
 * @param known - every ledger path associated with this workspace, files included.
 * @returns the access verdict for this session.
 */
export declare function externalAccess(mode: string | undefined, roots: readonly string[], known?: readonly string[]): ExternalAccess;
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
export declare function allowsExternal(access: ExternalAccess, absolute: string): boolean;
/**
 * Whether a path lies inside a directory (the directory itself counts).
 *
 * Compares canonical keys and requires a separator boundary, so a sibling whose
 * name merely starts the same (`…/b` vs `…/bc`) is never treated as inside.
 * @param root - the containing directory.
 * @param target - the candidate path.
 * @returns true when target is root or below it.
 */
export declare function isUnder(root: string, target: string): boolean;
/** The canonical spelling of one external path, as tokens and the ledger carry it. */
export declare function externalPath(absolute: string): string;
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
export declare function isAbsoluteReference(value: string): boolean;
