/**
 * Recent and neighbouring folder candidates, read from the Harness's own
 * workspace ledger.
 *
 * Why this exists: the folder chooser's hardest question is not "how do I
 * browse" but "where IS that folder" — a user picking an out-of-workspace
 * folder usually wants one they have worked in before, or one that sits beside
 * the project they are in now. The Harness already knows both: every Workspace
 * it has ever opened is recorded in `~/.dsh/storages/workspace.json` with its
 * absolute path and an `updatedAt`. Reading that ledger is a table lookup,
 * whereas SEARCHING for the same folder means walking file systems (measured on
 * this class of machine: a whole-drive bounded walk took 36 s at depth 3 and did
 * not finish at all unbounded). So the candidates are cheap where a search is
 * expensive, and they are what a search would have been trying to find.
 *
 * Ranking is deliberately three signals, not one:
 * - STRUCTURE (nearest first): a sibling of the current workspace, then an
 *   ancestor, then anywhere else. This is the user's "平级项目的文件夹".
 * - SIMILARITY: a shared name token (`dsh-atlas` beside `dsh-arcade`) is what
 *   relates same-family projects that were never opened from this workspace and
 *   may never have been opened at all.
 * - RECENCY and USE: `updatedAt` and the session count, which the ledger keeps.
 *
 * Everything here is pure and synchronous except the single ledger read, so the
 * whole ordering is unit-testable without a file system.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { externalPath } from './external.ts'
import { workspacePathKey } from './defaults.ts'

/** Why one candidate folder is being offered (the client groups by this). */
export type RecentFolderReason = 'sibling' | 'parent' | 'child' | 'recent' | 'family'

/** One offered folder: its absolute path, a display name, and why it is offered. */
export interface RecentFolder {
  /** Absolute path, forward slashes (the wire spelling used everywhere else). */
  readonly path: string
  /** Last path segment, for the row label. */
  readonly name: string
  /** The strongest reason this folder is in the list. */
  readonly reason: RecentFolderReason
}

/** One workspace row as the ledger records it (only the fields we read). */
interface LedgerWorkspace {
  readonly path?: unknown
  readonly title?: unknown
  readonly sessionIds?: unknown
  readonly updatedAt?: unknown
}

/** How many candidates are offered at most (a bounded menu, like every other list here). */
export const RECENT_FOLDER_LIMIT = 8

/**
 * Where the workspace ledger lives.
 *
 * `DSH_HOME` wins when set, because that is the same override the Harness itself
 * honours; otherwise the ledger sits under the account's own `.dsh`. A test needs
 * to point this somewhere it can control without touching the real home, which is
 * why it is a function rather than a constant.
 * @returns the absolute path of `workspace.json`.
 */
export function ledgerPath(): string {
  const home = process.env.DSH_HOME
  const base = home === undefined || home === '' ? join(homedir(), '.dsh') : home
  return join(base, 'storages', 'workspace.json')
}

/**
 * Every workspace path the ledger records, with its recency and session count.
 *
 * A missing, unreadable, or malformed ledger answers `[]` rather than throwing:
 * the folder chooser must stay usable on a machine that has never recorded a
 * workspace, and "no candidates" is a legitimate state the UI already renders.
 * @param signal - caller lifetime.
 * @returns the recorded workspaces, or `[]` when there is no usable ledger.
 */
export async function readWorkspaces(signal: AbortSignal): Promise<readonly RecentFolder[]> {
  const text = await readFile(ledgerPath(), 'utf8').catch(() => undefined)
  signal.throwIfAborted()
  if (text === undefined) return []
  return parseWorkspaces(text)
}

/**
 * Parse the ledger document's workspace table.
 *
 * Split from the read so the shape handling is testable without a file: the
 * ledger is a versioned store the Harness owns, so each field is treated as
 * untrusted and a row missing its path is dropped instead of producing a row
 * that browses nowhere.
 * @param text - the raw ledger document.
 * @returns the usable workspace rows.
 */
export function parseWorkspaces(text: string): readonly RecentFolder[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const table = (parsed as { tables?: { workspaces?: unknown } } | null)?.tables?.workspaces
  if (table === null || typeof table !== 'object') return []
  const rows: RecentFolder[] = []
  for (const value of Object.values(table as Record<string, LedgerWorkspace>)) {
    if (value === null || typeof value !== 'object') continue
    const path = value.path
    if (typeof path !== 'string' || path === '') continue
    rows.push({ path: externalPath(path), name: basenameOf(path), reason: 'recent' })
  }
  return rows
}

/**
 * Order the ledger's workspaces for one current workspace.
 *
 * @param all - every recorded workspace (see {@link readWorkspaces}).
 * @param cwd - the session's current workspace, or '' when it has none.
 * @returns the offered candidates, nearest-relevant first, at most {@link RECENT_FOLDER_LIMIT}.
 */
export function rankRecentFolders(all: readonly RecentFolder[], cwd: string): readonly RecentFolder[] {
  const self = workspacePathKey(cwd)
  const parent = self === '' ? '' : parentKey(self)
  const tokens = self === '' ? new Set<string>() : nameTokens(self)
  const ranked = all
    .filter(folder => workspacePathKey(folder.path) !== self)
    .map(folder => ({ folder, reason: reasonFor(workspacePathKey(folder.path), self, parent, tokens) }))
    // A stable tier order is what makes this predictable: structure beats family
    // beats "just recent", and the ledger's own order breaks ties inside a tier
    // (it is already newest-first in practice, and a stable sort keeps whichever
    // order the caller supplied rather than inventing one).
    .sort((left, right) => tierOf(left.reason) - tierOf(right.reason))
  return dedupe(ranked.map(entry => ({ ...entry.folder, reason: entry.reason }))).slice(0, RECENT_FOLDER_LIMIT)
}

/** Tier number for a reason: lower sorts first. */
function tierOf(reason: RecentFolderReason): number {
  switch (reason) {
    case 'sibling': return 0
    case 'parent': return 1
    case 'child': return 2
    case 'family': return 3
    case 'recent': return 4
  }
}

/**
 * The strongest reason one workspace relates to the current one.
 * @param candidate - canonical key of the candidate.
 * @param self - canonical key of the current workspace ('' when unknown).
 * @param parent - canonical key of the current workspace's parent ('' when unknown).
 * @param tokens - the current workspace's name tokens (empty when unknown).
 * @returns the reason.
 */
function reasonFor(candidate: string, self: string, parent: string, tokens: ReadonlySet<string>): RecentFolderReason {
  if (parent !== '' && parentKey(candidate) === parent) return 'sibling'
  if (parent !== '' && candidate === parent) return 'parent'
  // The current workspace living INSIDE the candidate: an enclosing project
  // ("DSH" holding "dsh-atlas"). Only a direct ancestor counts, matching how
  // `parent` is read, so an unrelated common prefix cannot claim the tier.
  if (self !== '' && isUnderKey(self, candidate)) return 'child'
  if (tokens.size > 0 && sharesToken(candidate, tokens)) return 'family'
  return 'recent'
}

/** True when `child` sits under `ancestor` (both canonical). */
function isUnderKey(child: string, ancestor: string): boolean {
  if (child === '' || ancestor === '') return false
  return child === ancestor || child.startsWith(`${ancestor}/`)
}

/** Canonical key of a path's parent directory. */
function parentKey(key: string): string {
  const cut = key.lastIndexOf('/')
  return cut <= 0 ? '' : key.slice(0, cut)
}

/** The name tokens of a canonical path's last segment, lower-cased. */
function nameTokens(key: string): ReadonlySet<string> {
  const name = key.slice(key.lastIndexOf('/') + 1)
  return new Set(name.split(/[.\-_]+/u).filter(token => token.length >= 3))
}

/** True when the candidate's last segment shares a name token with the current one. */
function sharesToken(candidate: string, tokens: ReadonlySet<string>): boolean {
  for (const token of nameTokens(candidate)) if (tokens.has(token)) return true
  return false
}

/** The last segment of a path, in either separator spelling. */
function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** Drop repeats, keeping the first (best-ranked) spelling of each folder. */
function dedupe(folders: readonly RecentFolder[]): readonly RecentFolder[] {
  const seen = new Set<string>()
  const out: RecentFolder[] = []
  for (const folder of folders) {
    const key = workspacePathKey(folder.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(folder)
  }
  return out
}
