import type {
  AtFileSettings,
  ExternalRef,
  FileIgnoreRule,
  FileIgnoreRuleInput,
  WorkspaceIgnoreFiles,
  WorkspaceRecentFiles,
} from './contract.ts'

/** Directory basenames omitted from the picker unless the profile supplies its own list. */
export const DEFAULT_IGNORE_DIRS = [
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vs',
  '.vscode',
  '.fleet',
  '.history',
  '.metadata',
  '.settings',
  'node_modules',
  'bower_components',
  'vendor',
  'Pods',
  '.gradle',
  '.kotlin',
  '.cxx',
  '.externalNativeBuild',
  '.dart_tool',
  '.swiftpm',
  '.build',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.nx',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.angular',
  'build',
  'bin',
  'dist',
  'out',
  'target',
  'obj',
  'coverage',
  'DerivedData',
  'xcuserdata',
  'CMakeFiles',
  'cmake-build-debug',
  'cmake-build-release',
  'cmake-build-relwithdebinfo',
  'cmake-build-minsizerel',
  '_deps',
  '.godot',
  'Library',
  'Temp',
  'Logs',
  'Binaries',
  'Intermediate',
  'Saved',
  'DerivedDataCache',
] as const

/** File basenames omitted from the picker unless the Web setting replaces the list. */
export const DEFAULT_IGNORE_FILES = [
  'desktop.ini',
  'Thumbs.db',
  '.DS_Store',
] as const

/** Fresh settings defaults for Host and browser initialization. */
export function defaultAtFileSettings(): AtFileSettings {
  return {
    enabled: true,
    ignoreFiles: [...DEFAULT_IGNORE_FILES],
    workspaceIgnoreFiles: [],
    ignorePastedMentions: true,
    recentFiles: [],
  }
}

/** Trim rules and remove empty entries or duplicates with identical matching semantics. */
export function normalizeIgnoreFiles(values: readonly FileIgnoreRuleInput[]): FileIgnoreRuleInput[] {
  const seen = new Set<string>()
  const normalized: FileIgnoreRuleInput[] = []
  for (const value of values) {
    const rule = normalizeIgnoreRule(value)
    if (rule === undefined) continue
    const key = ignoreRuleKey(rule)
    if (seen.has(key)) continue
    seen.add(key)
    // Keep legacy strings as strings so existing settings documents and callers
    // remain stable. New structured rules retain their explicit shape.
    normalized.push(typeof value === 'string' && rule.kind === 'exact' && !rule.caseSensitive
      ? rule.pattern
      : rule)
  }
  return normalized
}

/** Convert one legacy or structured setting value into its canonical rule. */
export function normalizeIgnoreRule(value: FileIgnoreRuleInput): FileIgnoreRule | undefined {
  if (typeof value === 'string') {
    const pattern = value.trim()
    return pattern === '' ? undefined : { kind: 'exact', pattern, caseSensitive: false }
  }
  const pattern = value.pattern.trim()
  if (pattern === '') return undefined
  const rule: FileIgnoreRule = {
    kind: value.kind,
    pattern,
    caseSensitive: value.caseSensitive,
  }
  if (rule.kind === 'regex') {
    try {
      new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i')
    } catch (error) {
      /* v8 ignore next -- RegExp construction throws an Error in supported runtimes. */
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid regular expression "${rule.pattern}": ${message}`)
    }
  }
  return rule
}

/** Stable identity for one rule, including matching semantics. */
export function ignoreRuleKey(value: FileIgnoreRuleInput): string {
  const rule = normalizeIgnoreRule(value)
  if (rule === undefined) return ''
  const pattern = rule.kind === 'exact' && !rule.caseSensitive ? rule.pattern.toLowerCase() : rule.pattern
  return JSON.stringify([rule.kind, pattern, rule.caseSensitive])
}

/** Compile rules once for a bounded directory walk. */
export function compileIgnoreRules(values: readonly FileIgnoreRuleInput[]): readonly FileIgnoreRule[] {
  return normalizeIgnoreFiles(values).map(value => normalizeIgnoreRule(value) as FileIgnoreRule)
}

/** Stable comparison key for one canonical workspace path. */
export function workspacePathKey(value: string): string {
  const slashed = value.replace(/\\/gu, '/')
  const withoutTrailing = slashed === '/' || /^[a-z]:\/$/iu.test(slashed)
    ? slashed
    : slashed.replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(withoutTrailing) || withoutTrailing.startsWith('//')
    ? withoutTrailing.toLowerCase()
    : withoutTrailing
}

/** Merge duplicate workspace rows and normalize every file-name list. */
export function normalizeWorkspaceIgnoreFiles(
  entries: readonly WorkspaceIgnoreFiles[],
): WorkspaceIgnoreFiles[] {
  const order: string[] = []
  const byWorkspace = new Map<string, WorkspaceIgnoreFiles>()
  for (const entry of entries) {
    const key = workspacePathKey(entry.workspace)
    if (key === '') continue
    const current = byWorkspace.get(key)
    if (current === undefined) order.push(key)
    byWorkspace.set(key, {
      workspace: current?.workspace ?? entry.workspace,
      ignoreFiles: normalizeIgnoreFiles([
        ...(current?.ignoreFiles ?? []),
        ...entry.ignoreFiles,
      ]),
    })
  }
  return order.map(key => byWorkspace.get(key) as WorkspaceIgnoreFiles)
}

/** Workspace-local file-name filters for one canonical cwd. */
export function workspaceIgnoreFilesFor(
  entries: readonly WorkspaceIgnoreFiles[],
  workspace: string,
): FileIgnoreRuleInput[] {
  const key = workspacePathKey(workspace)
  const entry = normalizeWorkspaceIgnoreFiles(entries)
    .find(candidate => workspacePathKey(candidate.workspace) === key)
  return entry?.ignoreFiles ?? []
}

/** Effective file-name filters for one workspace: global rules plus local additions. */
export function effectiveIgnoreFiles(settings: AtFileSettings, workspace: string): FileIgnoreRuleInput[] {
  return normalizeIgnoreFiles([
    ...settings.ignoreFiles,
    ...workspaceIgnoreFilesFor(settings.workspaceIgnoreFiles ?? [], workspace),
  ])
}

/** Stable cache key covering every file-name filter setting. */
export function ignoreFilesSettingsKey(settings: AtFileSettings): string {
  const global = normalizeIgnoreFiles(settings.ignoreFiles).map(ignoreRuleKey).sort()
  const workspaces = normalizeWorkspaceIgnoreFiles(settings.workspaceIgnoreFiles ?? [])
    .map(entry => ({
      workspace: workspacePathKey(entry.workspace),
      ignoreFiles: entry.ignoreFiles.map(ignoreRuleKey).sort(),
    }))
    .sort((left, right) => left.workspace.localeCompare(right.workspace))
  return JSON.stringify({ global, workspaces })
}

/** Maximum recently referenced files kept per workspace. */
export const MAX_RECENT_FILES = 20

/**
 * Normalize the durable recent-file rows: deduplicate workspaces, drop empty
 * lists, trim whitespace, and keep files most-recent-first.
 */
export function normalizeWorkspaceRecentFiles(values: readonly WorkspaceRecentFiles[]): WorkspaceRecentFiles[] {
  const seen = new Set<string>()
  const normalized: WorkspaceRecentFiles[] = []
  for (const row of values) {
    const key = workspacePathKey(row.workspace)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const files: string[] = []
    for (const raw of row.files) {
      const relative = raw.trim()
      if (relative === '' || files.includes(relative)) continue
      files.push(relative)
      if (files.length >= MAX_RECENT_FILES) break
    }
    if (files.length > 0) normalized.push({ workspace: row.workspace, files })
  }
  return normalized
}

/** The recent-file list for one workspace (most recent first). */
export function recentFilesFor(settings: AtFileSettings, workspace: string): readonly string[] {
  const key = workspacePathKey(workspace)
  const row = normalizeWorkspaceRecentFiles(settings.recentFiles ?? [])
    .find(candidate => workspacePathKey(candidate.workspace) === key)
  return row?.files ?? []
}

/**
 * Record one referenced relative path in the workspace's recent list (moves
 * it to the front). Returns the next durable `recentFiles` value.
 */
export function recordRecentFile(
  settings: AtFileSettings,
  workspace: string,
  relative: string,
): WorkspaceRecentFiles[] {
  const trimmed = relative.trim()
  const normalized = normalizeWorkspaceRecentFiles(settings.recentFiles ?? [])
  const key = workspacePathKey(workspace)
  const next: WorkspaceRecentFiles[] = []
  let merged = false
  for (const row of normalized) {
    if (workspacePathKey(row.workspace) !== key) {
      next.push(row)
      continue
    }
    merged = true
    const files = [trimmed, ...row.files.filter(file => file !== trimmed)].slice(0, MAX_RECENT_FILES)
    next.push({ workspace: row.workspace, files })
  }
  if (!merged && trimmed !== '') next.push({ workspace, files: [trimmed] })
  return next
}

/** Cross-category usage rows as stored in settings. */
type UsageRows = NonNullable<AtFileSettings['usage']>
/** One cross-category usage row. */
type UsageRow = UsageRows[number]

/** Maximum out-of-workspace references kept in the durable ledger. */
export const MAX_EXTERNAL_REFS = 100

/** How many workspaces one ledger row remembers (most recent first). */
export const MAX_EXTERNAL_WORKSPACES = 8

/**
 * Normalize the durable out-of-workspace ledger: drop empty paths, deduplicate
 * by canonical path key (keeping the highest count and the newest use), and sort
 * most-recently-used first.
 * @param values - raw ledger rows from settings.
 * @returns the normalized ledger, bounded by the plugin maximum.
 */
export function normalizeExternalRefs(values: readonly ExternalRef[] | undefined): ExternalRef[] {
  const byPath = new Map<string, ExternalRef>()
  for (const value of values ?? []) {
    const path = value.path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
    const key = workspacePathKey(path)
    if (key === '') continue
    const current = byPath.get(key)
    if (current === undefined) {
      byPath.set(key, {
        path,
        kind: value.kind,
        count: Math.max(0, Math.trunc(value.count)),
        lastUsedAt: Math.max(0, value.lastUsedAt),
        ...(value.workspaces === undefined || value.workspaces.length === 0
          ? {}
          : { workspaces: [...value.workspaces].slice(0, MAX_EXTERNAL_WORKSPACES) }),
      })
      continue
    }
    byPath.set(key, {
      ...current,
      // A directory wins over a file: only directories can become search roots.
      kind: current.kind === 'dir' || value.kind === 'dir' ? 'dir' : 'file',
      count: current.count + Math.max(0, Math.trunc(value.count)),
      lastUsedAt: Math.max(current.lastUsedAt, value.lastUsedAt),
      ...(current.workspaces === undefined && value.workspaces === undefined
        ? {}
        : { workspaces: [...new Set([...(current.workspaces ?? []), ...(value.workspaces ?? [])])].slice(0, MAX_EXTERNAL_WORKSPACES) }),
    })
  }
  return [...byPath.values()]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt || left.path.localeCompare(right.path))
    .slice(0, MAX_EXTERNAL_REFS)
}

/**
 * Record one out-of-workspace reference into the ledger (moves it to the front
 * and counts the use). Callers pass the already-normalized ledger.
 * @param settings - live settings.
 * @param path - canonical absolute path with forward slashes.
 * @param kind - what the path is.
 * @param workspace - the workspace it was referenced from.
 * @param now - epoch milliseconds of this use.
 * @returns the next durable `externalRefs` value.
 */
export function recordExternalRef(
  settings: AtFileSettings,
  path: string,
  kind: 'file' | 'dir',
  workspace: string,
  now: number,
): ExternalRef[] {
  const trimmed = path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  const rows = normalizeExternalRefs(settings.externalRefs)
  if (trimmed === '') return rows
  const key = workspacePathKey(trimmed)
  const current = rows.find(row => workspacePathKey(row.path) === key)
  const workspaces = [workspace, ...(current?.workspaces ?? [])]
    .filter(entry => entry !== '')
    .filter((entry, index, all) => all.findIndex(other => workspacePathKey(other) === workspacePathKey(entry)) === index)
    .slice(0, MAX_EXTERNAL_WORKSPACES)
  const updated: ExternalRef = {
    path: trimmed,
    kind: current?.kind === 'dir' || kind === 'dir' ? 'dir' : kind,
    count: (current?.count ?? 0) + 1,
    lastUsedAt: now,
    ...(workspaces.length === 0 ? {} : { workspaces }),
  }
  return normalizeExternalRefs([updated, ...rows.filter(row => workspacePathKey(row.path) !== key)])
}

/**
 * The ledger directories a session may reference into while it may not discover
 * new external paths: directories referenced from this workspace first, then the
 * rest of the ledger (so a path used in another workspace still works).
 * @param settings - live settings.
 * @param workspace - the session workspace root.
 * @returns candidate root directories, most relevant first.
 */
export function externalRootsFor(settings: AtFileSettings, workspace: string): readonly string[] {
  return externalLedgerFor(settings, workspace).roots
}

/**
 * Every ledger path a narrow session may reference EXACTLY (files included),
 * this workspace's entries first.
 * @param settings - live settings.
 * @param workspace - the session workspace root.
 * @returns ledger paths, most relevant first.
 */
export function externalKnownFor(settings: AtFileSettings, workspace: string): readonly string[] {
  return externalLedgerFor(settings, workspace).known
}

/**
 * Split the ledger into the two things the access gate needs: directories that
 * may be referenced INTO, and every path that may be referenced EXACTLY.
 * Entries referenced from this workspace come first in both lists.
 * @param settings - live settings.
 * @param workspace - the session workspace root.
 * @returns the roots and the known paths for this workspace.
 */
export function externalLedgerFor(
  settings: AtFileSettings,
  workspace: string,
): { roots: readonly string[]; known: readonly string[] } {
  const key = workspacePathKey(workspace)
  const rows = normalizeExternalRefs(settings.externalRefs)
  const mine = (row: ExternalRef): boolean => (row.workspaces ?? []).some(entry => workspacePathKey(entry) === key)
  const here = rows.filter(mine)
  const elsewhere = rows.filter(row => !mine(row))
  const ordered = [...here, ...elsewhere]
  return {
    roots: ordered.filter(row => row.kind === 'dir').map(row => row.path),
    known: ordered.map(row => row.path),
  }
}

/** Maximum cross-category usage counters kept (the most-picked win). */
export const MAX_USAGE_ENTRIES = 200

/**
 * Normalize the durable usage rows: drop blanks, collapse duplicate keys to the
 * highest count, and order by count then recency.
 * @param values - the stored rows.
 * @returns the bounded rows, most-picked first.
 */
export function normalizeUsage(values: UsageRows): UsageRow[] {
  const byKey = new Map<string, UsageRow>()
  for (const entry of values) {
    const key = entry.key.trim()
    if (key === '' || entry.count < 1) continue
    const current = byKey.get(key)
    if (current === undefined || entry.count > current.count) {
      byKey.set(key, { key, count: entry.count, at: entry.at })
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || b.at - a.at)
    .slice(0, MAX_USAGE_ENTRIES)
}

/**
 * Record one pick in the cross-category usage counters: the key is
 * `${mentionKind}:${value}`, so every category the picker understands counts
 * through the same path.
 * @param settings - the live settings value.
 * @param key - the `${kind}:${value}` pick key.
 * @param now - the pick time (epoch ms); injectable for deterministic tests.
 * @returns the next durable `usage` value, most-picked first.
 */
export function recordUsage(
  settings: AtFileSettings,
  key: string,
  now: number = Date.now(),
): UsageRow[] {
  const trimmed = key.trim()
  const current = normalizeUsage(settings.usage ?? [])
  if (trimmed === '') return current
  const seen = current.find(entry => entry.key === trimmed)
  const updated: UsageRow = { key: trimmed, count: (seen?.count ?? 0) + 1, at: now }
  return [updated, ...current.filter(entry => entry.key !== trimmed)]
    .sort((a, b) => b.count - a.count || b.at - a.at)
    .slice(0, MAX_USAGE_ENTRIES)
}
