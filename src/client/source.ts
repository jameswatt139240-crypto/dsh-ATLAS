/**
 * The '@' input-trigger source: turns the ui-input-trigger pipeline into the
 * category-based mention picker. An empty query shows the category rows
 * (files, folders, skills, past chats, plugins); typing without choosing
 * shows a mixed result list that prioritizes files/folders/skills while the
 * category rows stay pinned; `file:`, `folder:`, `skill:`, `chat:`,
 * `plugin:` prefixes enter one category. Picks land plain-text tokens that
 * the Host's pre-step boundary validates and expands into sourced references.
 * Pure factory over injected deps: the browser bundle wires the real Remotes
 * and clock, tests wire stubs.
 */
import type { InputTriggerCandidate, InputTriggerSource, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { basenameOf, childOf, dirnameOf, workspaceFromAbsolute } from './model.ts'
import { rankFiles } from './search.ts'
import { menuIconKind } from './icons.tsx'
import type { ChatCandidate, FileEntry, PluginCandidate, SkillCandidate } from './remote.ts'
import type { DirectoryListing, ExternalAccessScope, UsageEntry } from '../contract.ts'
import { externalPath, isAbsoluteReference } from '../external.ts'
import type { AtlasItem, AtlasRegistration } from '../atlas.ts'
import type { SkillTier } from '../contract.ts'
import { decodeDraftReference, type ReferenceLink } from './reference-links.ts'
import { isCancellation } from '../abort.ts'
import { PASTED_MENTION_MARKER } from '../paste.ts'

declare module '@deepseek-ai/dsh-client-ui-input-trigger/client' {
  interface InputTriggerCandidate {
    /** Source-owned stable value when the visible name is only a display label. */
    readonly value?: string
    /** Indexed path kind used by source-owned keyboard navigation. */
    readonly atFileKind?: FileEntry['kind']
    /** Routing kind for the category state machine and the dock. */
    readonly mentionKind?: MentionKind
    /** Host-built `dsh-session:` URI for one chat candidate row. */
    readonly chatUri?: string
    /** Stable collapse key for group header rows (chat:/skill:). */
    readonly groupKey?: string
    /** Recent-file rows may be pickable before the workspace index settles. */
    readonly recent?: boolean
  }
}

/** One mention row kind the picker and the dock both understand. */
export type MentionKind = 'category' | 'back' | 'file' | 'dir' | 'skill' | 'chat' | 'plugin' | 'provider' | 'chat-group' | 'skill-group' | 'plugin-group' | 'section-header'
  | 'dir-group' | 'folder-choose' | 'browse-up' | 'browse-dir' | 'browse-file' | 'browse-drive' | 'browse-note'

/** Owner source name (the lexicon and decoration routing key). */
export const SOURCE_NAME = 'atlas'

/** Design cap on visible picker rows (the menu height is maximized by CSS). */
export const MAX_CANDIDATES = 20

/** How many provider rows one mixed search may contribute in total. */
export const PROVIDER_MIX_LIMIT = 6

/** How long one session's index stays hot before the next menu open refetches. */
export const INDEX_TTL_MS = 30_000

/** How long the per-session skill list and the global plugin list stay hot. */
export const CATEGORY_TTL_MS = 30_000

/** One preloaded page of past-chat candidates (menu height is 12; 20 gives headroom). */
export const CHAT_PAGE = 20

/** One category key (folder rows are routed as dir mentions). */
export type CategoryKey = 'file' | 'folder' | 'skill' | 'chat' | 'plugin' | 'provider'

/** One selectable category row. */
export interface CategoryDef {
  readonly key: CategoryKey
  /** The draft prefix that enters this category (`@skill:` etc.). */
  readonly prefix: string
  /** Built-in Chinese label, used when no locale binder is wired. */
  readonly name: string
  /** Locale key of the displayed label (see client/locales.ts). */
  readonly nameKey: string
  /** Single-letter shortcut shown in the menu and accepted after `@`. */
  readonly shortcut: string
  /** English name prefix matched for completion (e.g. `pl` → plugin). */
  readonly english: string
  /**
   * Set on rows built from a registered `@` seam provider: it is the provider
   * handle whose `list` fills the category and whose `resolve` the pick routes to.
   */
  readonly providerId?: string
}

/** Locale binder shape shared by the row builders (dictionary key → copy). */
export type Translate = (key: string, params?: Record<string, string>) => string

/** The five categories, shown in menu order. */
export const CATEGORIES: readonly CategoryDef[] = [
  { key: 'file', prefix: 'file:', name: '文件', nameKey: 'cat.file', shortcut: 'F', english: 'file' },
  { key: 'folder', prefix: 'folder:', name: '文件夹', nameKey: 'cat.folder', shortcut: 'D', english: 'folder' },
  { key: 'skill', prefix: 'skill:', name: 'Skill', nameKey: 'cat.skill', shortcut: 'S', english: 'skill' },
  { key: 'chat', prefix: 'chat:', name: '过去的聊天', nameKey: 'cat.chat', shortcut: 'C', english: 'chat' },
  { key: 'plugin', prefix: 'plugin:', name: '插件', nameKey: 'cat.plugin', shortcut: 'P', english: 'plugin' },
]

/**
 * One category's displayed label in the bound locale.
 * @param category - the category definition.
 * @param t - optional locale binder; absent keeps the built-in Chinese copy.
 * @returns the localized category name.
 */
/** The label one category row shows. */
function categoryLabel(category: CategoryDef, t?: Translate): string {
  // A provider names itself: `display` is the label it declared, and there is no
  // locale entry to look up. Routing it through a key printed the raw key
  // (`cat.provider.git`) whenever the dictionary had nothing for that provider.
  if (category.providerId !== undefined) return category.name
  return t?.(category.nameKey) ?? category.name
}

/**
 * The glyph for one category row. Provider rows reuse the plugin glyph: they are
 * plugin-supplied sources, and a per-provider icon is not ours to invent.
 * @param category - the category definition.
 * @returns the icon kind the built-in icon set understands.
 */
function categoryGlyph(category: CategoryDef): 'file' | 'folder' | 'skill' | 'chat' | 'plugin' {
  if (category.providerId !== undefined || category.key === 'provider') return 'plugin'
  return category.key as 'file' | 'folder' | 'skill' | 'chat' | 'plugin'
}

/**
 * Build the menu categories for the currently registered `@` seam providers.
 *
 * These are dynamic rows: a provider that registers while the app runs shows up
 * on the next menu open, and one that disposes disappears with it. A provider
 * claims a shortcut letter when it can — the first letter of its id, upper-cased,
 * and only while no built-in category (or an earlier provider) already answers to
 * it. A letter that means two things is worse than no letter, and the explicit
 * `@<id>:` prefix always works either way.
 * @param providers - the live registrations from the seam registry.
 * @returns one category definition per provider, in registration order.
 */
export function providerCategories(
  providers: readonly { readonly id: string; readonly display: string }[],
): readonly CategoryDef[] {
  const taken = new Set(CATEGORIES.map(category => category.shortcut.toLowerCase()))
  return providers.map((provider) => {
    const letter = provider.id.slice(0, 1).toLowerCase()
    const shortcut = /^[a-z]$/u.test(letter) && !taken.has(letter) ? letter.toUpperCase() : ''
    if (shortcut !== '') taken.add(letter)
    return {
      key: 'provider' as const,
      providerId: provider.id,
      prefix: `${provider.id}:`,
      name: provider.display,
      nameKey: `cat.provider.${provider.id}`,
      shortcut,
      english: provider.id,
    }
  })
}

/** Per-session fetch cache: the shared promise, its abort handle, and the settled snapshot. */
interface CategoryCache<T> {
  readonly promise: Promise<readonly T[]>
  readonly abort: AbortController
  /** Settled snapshot backing synchronous reads; unset while in flight. */
  settled?: readonly T[]
  /** Monotonic clock reading at fetch start (TTL base). */
  readonly at: number
}

/** Everything the source needs that the browser bundle supplies (tests stub). */
export interface MentionSourceDeps {
  /** Search the addressed session's workspace index (Remote wrapper). */
  search(sessionId: SessionId, signal: AbortSignal): Promise<readonly FileEntry[]>
  /** List discoverable skills for the addressed session (Remote wrapper). */
  listSkills?(sessionId: SessionId, signal: AbortSignal): Promise<readonly SkillCandidate[]>
  /** List past-session candidates for the addressed session (Remote wrapper). */
  listChats?(sessionId: SessionId, query: string, limit: number, signal: AbortSignal): Promise<readonly ChatCandidate[]>
  /** List installed plugins (Remote wrapper). */
  listPlugins?(signal: AbortSignal): Promise<readonly PluginCandidate[]>
  /** Monotonic clock for index freshness (default Date.now). */
  now?: () => number
  /** Locale binder for time/tier labels (defaults to zh copy). */
  t?: (key: string, params?: Record<string, string>) => string
  /** Record one referenced path into the session workspace's recent list. */
  onRecent?(sessionId: SessionId, relative: string): void
  /** Record one pick in the cross-category usage counters. */
  onUsage?(sessionId: SessionId, kind: string, value: string): void
  /** The live cross-category pick counters (highest count first). */
  usage?(): readonly UsageEntry[]
  /**
   * The live `@` seam providers. Called on every menu request; a provider that
   * is not registered here is never listed, so registration stays the gate.
   */
  atlasProviders?(): readonly AtlasRegistration[]
  /** The session workspace's recent-file list for one workspace, most recent first. */
  recentFiles?(sessionId: SessionId, workspace: string): readonly string[]
  /**
   * The Host's out-of-workspace scope for one session: whether it may discover
   * external paths, and the external folders `@folder:` may offer. The Host owns
   * this verdict (settings plus the resolved sandbox policy); the source only
   * renders what it returns.
   */
  external?(sessionId: SessionId, signal: AbortSignal): Promise<ExternalAccessScope>
  /**
   * One bounded, one-level directory listing (the folder browser's data). The Host
   * gates an out-of-workspace path exactly as it gates a reference, and answers a
   * refusal as a reason, so a missing member simply means "no browser here".
   */
  list?(sessionId: SessionId, path: string, signal: AbortSignal): Promise<DirectoryListing>
  /**
   * The folder the composer's DRAFT is scoped by (R-05): the nearest folder
   * reference typed before the active category token. `@e:/work/docs/ @file:` therefore
   * lists that folder's files — the scope is positional, so no connective word is
   * needed. Undefined when the draft names none, which is this view's behaviour
   * before the scope existed.
   */
  scopeFolder?(sessionId: SessionId, signal: AbortSignal): Promise<string | undefined>
  /**
   * Open the product's own folder chooser for one draft token span, answering
   * whether this build has one. The chooser is asynchronous (a native or in-app
   * dialog), so it takes over the insertion itself; a `false` answer lets the
   * source fall back to its own in-menu walk.
   */
  chooseFolder?(sessionId: SessionId, span: TokenSpan): boolean
  /**
   * The click action for one mention of the draft, or undefined when this build
   * has none. Used by {@link InputTriggerSource.openReference}: a client that
   * activates a reference token in the composer asks its owning source to open
   * it, and the plugin answers with the same action the sent-message bridge uses.
   */
  actionFor?(sessionId: SessionId, link: ReferenceLink): (() => void) | undefined
}

/** The registered source plus the cache teardown the wiring layer owns. */
export interface MentionSource {
  readonly source: InputTriggerSource
  /** Drop every per-session cache and path map (connection reset). */
  invalidateAll(): void
  /** Drop one session's out-of-workspace scope (a sent reference may have grown the ledger). */
  invalidateExternal(sessionId: SessionId): void
  /** Toggle one group header's collapse state for a session (menu re-tracks). */
  toggleGroup(sessionId: SessionId, key: string): void
  /** Whether a group header is currently collapsed for a session. */
  isCollapsed(sessionId: SessionId, key: string): boolean
  /**
   * Rebuild the candidate rows for one category query synchronously from the
   * settled caches (instant collapse without a refetch). Returns undefined
   * when the needed cache is not settled yet — callers fall back to a refresh.
   */
  rebuildRows(sessionId: SessionId, query: string): readonly MentionCandidate[] | undefined
}

/**
 * The trigger contract's icon slot: a built-in glyph token or an icon
 * component. Our rows carry already-rendered Tabler elements, so the cast at
 * each assignment keeps the running renderer behavior byte-identical while
 * satisfying the contract type.
 */
type CandidateIcon = NonNullable<InputTriggerCandidate['icon']>

/** One picker row with a stable value and routing kind. */
interface MentionCandidate extends InputTriggerCandidate {
  readonly value: string
  readonly mentionKind: MentionKind
  /** Set on provider rows: whose `resolve` the committed reference routes to. */
  readonly providerId?: string
  /** Set on the Tab-completion hint, which is the row the highlight belongs on. */
  readonly completionHint?: true
}

/** Resolve the active category from a `file:`-style query prefix. */
export function categoryOfQuery(query: string, providers: readonly CategoryDef[] = []): CategoryDef | undefined {
  return [...CATEGORIES, ...providers].find(category => query.startsWith(category.prefix))
}

/**
 * The always-pinned category rows for the empty/mixed view.
 * @param t - locale binder.
 * @param providers - the live `@` seam providers, appended after the built-ins.
 * @returns the category rows in menu order.
 */
export function categoryRows(t?: Translate, providers: readonly CategoryDef[] = []): readonly MentionCandidate[] {
  return [...CATEGORIES, ...providers].map(category => ({
    name: categoryLabel(category, t),
    icon: menuIconKind(categoryGlyph(category)),
    value: category.prefix,
    mentionKind: 'category' as const,
    description: category.shortcut,
  }))
}

/**
 * Resolve the single category the user's typed query points at, or undefined
 * when it is ambiguous.
 *
 * A query matching exactly one shortcut letter (F/D/S/C/P, plus whatever letter
 * a registered provider claimed — `G` for `@git`) or exactly one English name
 * prefix (fi/fo/sk/ch/pl…, and a provider's own id, so `gi` reaches git) wins;
 * otherwise the completion stays unavailable so plain mixed search keeps working.
 * @param query - the text after the trigger.
 * @param providers - the live provider categories, which compete on equal terms.
 * @returns the category the query names, or undefined.
 */
export function completionTarget(query: string, providers: readonly CategoryDef[] = []): CategoryDef | undefined {
  const q = query.trim().toLowerCase()
  if (q === '') return undefined
  const all = [...CATEGORIES, ...providers]
  const byShortcut = all.filter(category => category.shortcut.toLowerCase() === q)
  if (byShortcut.length === 1) return byShortcut[0]
  const byEnglish = all.filter(category => category.english.startsWith(q))
  return byEnglish.length === 1 ? byEnglish[0] : undefined
}

/**
 * The hint row a completion query puts at the END of the list.
 *
 * It is a category row like the one it repeats (same `value`, so a pick enters
 * the same `@<category>:` prefix) plus `completionHint`, which is the flag the
 * navigator uses to land the default highlight here: the menu opens above the
 * composer, so the last row is the one closest to the caret and the eye stays in
 * the bottom band instead of jumping to the top of the list.
 */
export function hintRow(category: CategoryDef, t?: Translate): MentionCandidate {
  return {
    name: categoryLabel(category, t),
    icon: menuIconKind(categoryGlyph(category)),
    value: category.prefix,
    mentionKind: 'category' as const,
    completionHint: true,
    description: t?.('hint.complete', { prefix: category.prefix }) ?? `Tab 补全 → ${category.prefix}`,
  }
}

/** The text category tag, matching the category menu rows (icons live on rows). */
const CATEGORY_TAG_FALLBACK = {
  file: '文件',
  folder: '文件夹',
  skill: 'Skill',
  chat: '聊天',
  plugin: '插件',
} as const

/** The row tag for one mention kind, localized when a binder is supplied. */
export function categoryTag(
  kind: 'file' | 'folder' | 'skill' | 'chat' | 'plugin',
  t?: Translate,
): string {
  const key = kind === 'chat' ? 'cat.tag.chat' : `cat.${kind}`
  return t?.(key) ?? CATEGORY_TAG_FALLBACK[kind]
}

/** The back row shown inside one category. */
export function backRow(t?: Translate): MentionCandidate {
  return {
    name: t?.('nav.back') ?? '返回类别',
    icon: menuIconKind('back'),
    value: 'back',
    mentionKind: 'back',
    // No framework glyph means no icon box, rather than an empty one.
  }
}

/** A non-pickable section divider row (e.g. 最近引用 / 全部匹配). */
export function sectionHeaderRow(label: string): MentionCandidate {
  return { name: `─ ${label}`, value: '', mentionKind: 'section-header' as const }
}

/** Relative-time buckets, mirroring the sidebar workspace rows. */
export interface RelativeTime {
  readonly unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  readonly n: number
}

/** Compact relative time ("刚刚"/"5分钟"…), same buckets as the sidebar. */
export function relativeTime(updatedAt: number, now: number): RelativeTime {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

/** The default zh labels used when no locale binder is wired (product copy). */
const FALLBACK_TIME: Record<RelativeTime['unit'], string> = {
  now: '刚刚',
  minutes: '{n}分钟',
  hours: '{n}小时',
  days: '{n}天',
  months: '{n}个月',
  years: '{n}年',
}

/** Render one relative time as the sidebar does ("刚刚"/"5分钟"/"2天"). */
export function relativeTimeLabel(updatedAt: number, now: number, t?: (key: string, params?: Record<string, string>) => string): string {
  const { unit, n } = relativeTime(updatedAt, now)
  if (t !== undefined) return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n: String(n) })
  return unit === 'now' ? FALLBACK_TIME.now : FALLBACK_TIME[unit].replace('{n}', String(n))
}

/** Skill tier labels (mirror the sidebar Skill Manager grouping). */
export const TIER_ORDER: readonly SkillTier[] = ['system', 'user', 'project', 'custom', 'plugin']

/** Default zh tier labels (locale keys `tier.<key>` override when bound). */
const FALLBACK_TIER: Record<SkillTier, string> = {
  system: '系统',
  user: '用户',
  project: '项目',
  custom: '自定义',
  plugin: '插件',
}

/**
 * Clean a session title for display and the mention token: trim, drop leading
 * markdown heading markers (#), collapse internal whitespace, cap at 40 chars.
 */
export function cleanChatLabel(label: string): string {
  const cleaned = label
    .trim()
    .replace(/^#+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return cleaned.length > 40 ? cleaned.slice(0, 39).trimEnd() + '…' : cleaned
}

/** The workspace title for one chat group (basename; 未分组 for none). */
export function workspaceTitle(cwd: string | undefined, t?: Translate): string {
  if (cwd === undefined) return t?.('group.ungrouped') ?? '未分组'
  const trimmed = cwd.replace(/[\\/]+$/u, '')
  return trimmed.split(/[\\/]/u).pop() || cwd
}

/** Project ranked entries into filename-first, duplicate-safe menu rows. */
function candidateRows(files: readonly FileEntry[], kind: 'file' | 'dir' | 'both', tagged = false, t?: Translate): readonly MentionCandidate[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const basename = basenameOf(file.relative)
    counts.set(basename, (counts.get(basename) ?? 0) + 1)
  }
  return files.flatMap(file => {
    if (kind === 'file' && file.kind !== 'file') return []
    if (kind === 'dir' && file.kind !== 'dir') return []
    const basename = basenameOf(file.relative)
    const directory = dirnameOf(file.relative)
    const duplicate = (counts.get(basename) as number) > 1
    const tag = categoryTag(file.kind === 'dir' ? 'folder' : 'file', t)
    const description = tagged
      ? (directory === '' ? tag : `${tag} · ${directory}`)
      : (directory === '' ? undefined : directory)
    const row: MentionCandidate = {
      name: duplicate && directory !== '' ? `${basename} - ${directory}` : basename,
      icon: menuIconKind(file.kind === 'dir' ? 'folder' : 'file'),
      value: file.relative,
      atFileKind: file.kind,
      mentionKind: file.kind === 'dir' ? 'dir' : 'file',
      ...(description === undefined ? {} : { description }),
    }
    return [row]
  })
}

/** Simple case-insensitive substring filter for skill/plugin rows. */
function matches(query: string, ...fields: readonly string[]): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return fields.some(field => field.toLowerCase().includes(q))
}

/**
 * Damerau–Levenshtein distance between two short strings (optimal string
 * alignment). Used for typo-tolerant mention search.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 4) return Math.max(m, n)
  const rows: number[][] = []
  for (let i = 0; i <= m; i += 1) {
    rows.push([i])
    for (let j = 1; j <= n; j += 1) {
      rows[i]!.push(i === 0 ? j : 0)
    }
  }
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      )
      if (i > 1 && j > 1 && a[i - 1]!.toLowerCase() === b[j - 2]!.toLowerCase()
        && a[i - 2]!.toLowerCase() === b[j - 1]!.toLowerCase()) {
        rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1)
      }
    }
  }
  return rows[m]![n]!
}

/**
 * Typo-tolerant match: substring OR any word token of the field within edit
 * distance (1 for short queries, 2 for queries of 8+ chars). Enables e.g.
 * `qulity` → `animation-quality-gate` via its `quality` token.
 */
export function matchesFuzzy(query: string, ...fields: readonly string[]): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  if (fields.some(field => field.toLowerCase().includes(q))) return true
  if (q.length < 3) return false
  const maxDistance = q.length >= 8 ? 2 : 1
  return fields.some(field => {
    const tokens = field.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
    return tokens.some(token => editDistance(q, token) <= maxDistance)
  })
}

/**
 * Typo-tolerant file ranking, used only when the exact ranking found nothing.
 * The query is compared with the basename, its extension-less stem, and each
 * parent directory segment, so `veiw.ts` reaches `view.ts` and `clinet` reaches
 * `client/…`. Queries shorter than three characters never fall back, and a
 * query containing `/` stays exact — the user already named a directory, so a
 * fuzzy sweep across segments would only add noise.
 * @param files - the workspace index.
 * @param query - the user's query.
 * @param limit - maximum rows.
 * @returns typo-tolerant matches, nearest first.
 */
function fuzzyRankFiles(files: readonly FileEntry[], query: string, limit: number): readonly FileEntry[] {
  const q = query.trim().toLowerCase()
  if (q.length < 3 || q.includes('/')) return []
  const maxDistance = q.length >= 8 ? 2 : 1
  return files
    .map(file => ({ file, distance: fuzzyFileDistance(file.relative, q) }))
    .filter(entry => entry.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance
      || (a.file.kind === 'dir' ? 1 : 0) - (b.file.kind === 'dir' ? 1 : 0)
      || a.file.relative.length - b.file.relative.length
      || (a.file.relative < b.file.relative ? -1 : 1))
    .slice(0, limit)
    .map(entry => entry.file)
}

/** Smallest edit distance from the query to any name part of one relative path. */
function fuzzyFileDistance(relative: string, q: string): number {
  const segments = relative.toLowerCase().split('/')
  const basename = segments.at(-1) as string
  const dot = basename.lastIndexOf('.')
  const stem = dot > 0 ? basename.slice(0, dot) : basename
  let best = editDistance(q, basename)
  for (const candidate of [stem, ...segments.slice(0, -1)]) {
    best = Math.min(best, editDistance(q, candidate))
  }
  return best
}

/**
 * Rank files for one query, falling back to typo tolerance only when the exact
 * ranking returns nothing — so a near miss can never displace an exact match.
 * @param files - the workspace index.
 * @param query - the user's query.
 * @param limit - maximum rows.
 * @returns the ranked entries.
 */
export function rankFilesWithFuzzy(
  files: readonly FileEntry[],
  query: string,
  limit: number,
): readonly FileEntry[] {
  const ranked = rankFiles(files, query, limit)
  if (ranked.length > 0) return ranked
  return fuzzyRankFiles(files, query, limit)
}

/** A bare drive letter in the draft (`E:`), which means that drive's root. */
const DRIVE_ONLY = /^[a-z]:$/iu

/**
 * The directory a draft query asks to walk, or undefined when it is a search.
 *
 * Both spellings reach the browser: the bare mention the browser's own picks write
 * (`@E:/…/`) and the category form a user may type (`@folder:E:/…`). A drive letter
 * alone is its root, so `@folder:E:` is enough to leave the drive you are on. A
 * FILE path is not a special case: it browses the directory it lives in, where the
 * file itself is a row — which is what makes typing a path feel like a path.
 * @param query - the live query (text after `@`).
 * @returns the absolute directory to list, or undefined for an ordinary search.
 */
export function browseTarget(query: string): string | undefined {
  const trimmed = query.trim()
  const body = (trimmed.startsWith('folder:') ? trimmed.slice('folder:'.length) : trimmed).trim()
  if (body === '') return undefined
  if (DRIVE_ONLY.test(body)) return `${body}/`
  if (!isAbsoluteReference(body)) return undefined
  // The trailing separator a folder mention carries names the same directory, so
  // the walk asks for it once, without — EXCEPT at a root: `E:` is the DRIVE-RELATIVE
  // spelling (it means "the current directory on E:"), so stripping the slash there
  // would silently browse the session workspace instead of the drive (observed live).
  const withoutTrailing = body.replace(/[/\\]+$/u, '')
  if (withoutTrailing === '') return '/'
  return DRIVE_ONLY.test(withoutTrailing) ? `${withoutTrailing}/` : withoutTrailing
}
function skillGroupRow(tier: SkillTier, collapsed: boolean, t?: (key: string, params?: Record<string, string>) => string): MentionCandidate {
  const label = t !== undefined ? t(`tier.${tier}`) : FALLBACK_TIER[tier]
  return {
    name: `${collapsed ? '▸' : '▾'} ${label}`,
    value: '',
    mentionKind: 'skill-group' as const,
    description: collapsed ? (t?.('group.expand') ?? '展开') : (t?.('group.collapse') ?? '折叠'),
    groupKey: `skill:${tier}`,
  }
}

/** A skill domain header row (mentionKind 'skill-group'; toggles collapse). */
function skillDomainRow(domain: string, collapsed: boolean, key: string, t?: Translate): MentionCandidate {
  return {
    name: `${collapsed ? '▸' : '▾'} ${domain}`,
    value: '',
    mentionKind: 'skill-group' as const,
    description: collapsed ? (t?.('group.expand') ?? '展开') : (t?.('group.collapse') ?? '折叠'),
    groupKey: key,
  }
}

/** The collapse key of the out-of-workspace folder group. */
export const OUTSIDE_GROUP_KEY = 'folder:outside'

/** The collapse key of the workspace folder group. */
export const WORKSPACE_GROUP_KEY = 'folder:workspace'

/**
 * How many rows the folder category shows at most (headers included).
 *
 * The user's口径: the visible area must always be the folders whose NAME matched —
 * workspace first, then outside — and the folder view must not FOLD rows away to
 * stay short. Beyond what fits on screen the menu SCROLLS (with PageUp/PageDown,
 * and the focus row is kept visible), so this is only the hard ceiling that keeps
 * one category from flooding the menu; the name matches still claim the top rows
 * and the path-only group fills whatever is left.
 */
export const FOLDER_ROW_BUDGET = MAX_CANDIDATES

/** The collapse key of the path-only matches (folded, so they never bury the name hits). */
export const PATH_GROUP_KEY = 'folder:path'

/**
 * How many rows the `@file:` view shows at most, headers included.
 *
 * The same口径 as the folder view (R-03/R-05): the user asked for the two views to
 * behave alike, so this is deliberately the same ceiling — and the same answer to
 * "more than fits": scroll, don't truncate the priority rows away.
 */
export const FILE_ROW_BUDGET = MAX_CANDIDATES

/** The collapse key of the file view's path-only matches. */
export const FILE_PATH_GROUP_KEY = 'file:path'

/**
 * Whether one group is folded before the user touches it.
 *
 * Two groups open folded. The out-of-workspace one, because a dozen checkouts
 * beside a workspace pushed the workspace's own folders past the fold (reported
 * with a screenshot). And the path-only matches, because a one-letter query
 * matches almost every path under an `E:`-rooted workspace, and those rows must
 * never bury the folders whose NAME matched.
 * @param key - a group's collapse key.
 * @returns true when that group opens folded.
 */
function defaultCollapsed(key: string): boolean {
  return key === OUTSIDE_GROUP_KEY || key === PATH_GROUP_KEY
}

/**
 * One collapsible group header inside the folder category.
 *
 * The folder category has two sources of rows — folders outside the workspace and
 * folders inside it — and they must not be one flat list: the workspace ones are
 * what a session reaches for most, and a flat list of a dozen external checkouts
 * pushed them below the fold (reported with a screenshot). Folding reuses the
 * gesture this plugin already owns (`dir-group` joins the three group kinds the
 * navigator folds), so nothing new is claimed.
 * @param key - stable collapse key.
 * @param label - the group's name in the locale's own words.
 * @param collapsed - whether the group is folded right now.
 * @param t - locale binder.
 * @returns the header row.
 */
function dirGroupRow(key: string, label: string, collapsed: boolean, t?: Translate): MentionCandidate {
  return {
    name: `${collapsed ? '▸' : '▾'} ${label}`,
    value: '',
    mentionKind: 'dir-group' as const,
    description: collapsed ? (t?.('group.expand') ?? '展开') : (t?.('group.collapse') ?? '折叠'),
    groupKey: key,
  }
}

/**
 * The row that starts walking the filesystem from the session workspace root.
 *
 * It is the folder category's default highlight, because the case this feature
 * exists for is "a folder that is NOT in my workspace" — and a user who wants one
 * of the workspace rows does not need to travel through it.
 * @param t - locale binder.
 * @returns the row (its pick drafts the workspace root and keeps the menu open).
 */
export function folderChooseRow(t?: Translate): MentionCandidate {
  return {
    name: t?.('folder.choose') ?? '选择文件夹…',
    icon: menuIconKind('folder'),
    value: 'folder-choose',
    mentionKind: 'folder-choose' as const,
    description: t?.('folder.chooseHint') ?? '从工作区根开始浏览，可上溯、可换盘',
  }
}

/** The stable collapse key for one skill tier. */
export function skillGroupKey(tier: SkillTier): string {
  return `skill:${tier}`
}

/** The stable collapse key for one skill domain inside a tier. */
export function skillDomainKey(tier: SkillTier, domain: string): string {
  return `skill:${tier}:${domain}`
}

/** The domain of a skill: the prefix before the first '-' (e.g. blender-modeling → blender). */
export function domainOf(skillName: string): string {
  const dash = skillName.indexOf('-')
  return dash <= 0 ? skillName : skillName.slice(0, dash)
}

/** Skill rows grouped under tier → domain (system/… → blender/… → skills). */
function skillRows(
  skills: readonly SkillCandidate[],
  query: string,
  limit: number,
  collapsed: (key: string) => boolean,
  t?: (key: string, params?: Record<string, string>) => string,
  tagged = false,
  alphabetical = false,
): readonly MentionCandidate[] {
  // Substring matches rank first; typo-only (fuzzy) matches follow.
  const substring = skills.filter(skill => matches(query, skill.name, skill.description))
  const fuzzyOnly = skills.filter(skill => !matches(query, skill.name, skill.description)
    && matchesFuzzy(query, skill.name, skill.description))
  let matchesSkills = [...substring, ...fuzzyOnly]
  if (alphabetical) matchesSkills = [...matchesSkills].sort((a, b) => a.name.localeCompare(b.name))
  matchesSkills = matchesSkills.slice(0, limit)
  const rows: MentionCandidate[] = []
  for (const tier of TIER_ORDER) {
    const tierSkills = matchesSkills.filter(skill => skill.tier === tier)
    if (tierSkills.length === 0) continue
    const tierKey = skillGroupKey(tier)
    rows.push(skillGroupRow(tier, collapsed(tierKey), t))
    if (collapsed(tierKey)) continue
    const domains = new Map<string, readonly SkillCandidate[]>()
    for (const skill of tierSkills) {
      const domain = domainOf(skill.name)
      const current = domains.get(domain) ?? []
      domains.set(domain, [...current, skill])
    }
    for (const [domain, domainSkills] of domains) {
      const domainKey = skillDomainKey(tier, domain)
      rows.push(skillDomainRow(domain, collapsed(domainKey), domainKey, t))
      if (collapsed(domainKey)) continue
      for (const skill of domainSkills) {
        rows.push({
          name: skill.name,
          icon: menuIconKind('skill'),
          value: skill.name,
          mentionKind: 'skill' as const,
          ...(skill.description === '' ? {} : { description: tagged ? `${categoryTag('skill', t)} · ${skill.description}` : skill.description }),
        })
      }
    }
  }
  return rows
}

/** The scope group of one plugin module: the npm scope (e.g. @deepseek-ai) or 其他. */
export function pluginScope(moduleName: string): string {
  if (moduleName.startsWith('@')) {
    const slash = moduleName.indexOf('/')
    return slash < 0 ? moduleName : moduleName.slice(0, slash)
  }
  return '其他'
}

/** One plugin scope's displayed label (the "其他" bucket is localized). */
function pluginScopeLabel(scope: string, t?: Translate): string {
  return scope === '其他' ? (t?.('plugin.scope.other') ?? scope) : scope
}

/** The stable collapse key for one plugin scope group. */
export function pluginGroupKey(scope: string): string {
  return `plugin:${scope}`
}

/** A plugin scope header row (mentionKind 'plugin-group'; toggles collapse). */
function pluginGroupRow(scope: string, collapsed: boolean, key: string, t?: Translate): MentionCandidate {
  return {
    name: `${collapsed ? '▸' : '▾'} ${scope}`,
    value: '',
    mentionKind: 'plugin-group' as const,
    description: collapsed ? (t?.('group.expand') ?? '展开') : (t?.('group.collapse') ?? '折叠'),
    groupKey: key,
  }
}

/** Plugin rows grouped under their npm scope, with the full name always visible. */
function pluginRows(
  plugins: readonly PluginCandidate[],
  query: string,
  limit: number,
  collapsed: (key: string) => boolean,
  t?: Translate,
  tagged = false,
  alphabetical = false,
): readonly MentionCandidate[] {
  const substringPlugins = plugins.filter(plugin => plugin.enabled && matches(query, plugin.moduleName))
  const fuzzyPlugins = plugins.filter(plugin => plugin.enabled && !matches(query, plugin.moduleName)
    && matchesFuzzy(query, plugin.moduleName))
  let matchesPlugins = [...substringPlugins, ...fuzzyPlugins]
  if (alphabetical) matchesPlugins = [...matchesPlugins].sort((a, b) => a.moduleName.localeCompare(b.moduleName))
  matchesPlugins = matchesPlugins.slice(0, limit)
  const groups = new Map<string, readonly PluginCandidate[]>()
  for (const plugin of matchesPlugins) {
    const scope = pluginScope(plugin.moduleName)
    const current = groups.get(scope) ?? []
    groups.set(scope, [...current, plugin])
  }
  const rows: MentionCandidate[] = []
  for (const [scope, scopePlugins] of groups) {
    const key = pluginGroupKey(scope)
    rows.push(pluginGroupRow(pluginScopeLabel(scope, t), collapsed(key), key, t))
    if (collapsed(key)) continue
    for (const plugin of scopePlugins) {
      rows.push({
        name: plugin.moduleName,
        icon: menuIconKind('plugin'),
        value: plugin.moduleName,
        mentionKind: 'plugin' as const,
        description: tagged ? `${categoryTag('plugin', t)} · ${plugin.moduleName}` : plugin.moduleName,
      })
    }
  }
  return rows
}

/** A workspace group header row (mentionKind 'chat-group'; toggles collapse).
 * The groupKey MUST equal chatGroupKey(cwd) — the collapse filter and the
 * navigator toggle share this single key. */
function chatGroupRow(title: string, collapsed: boolean, key: string, t?: Translate): MentionCandidate {
  return {
    name: `${collapsed ? '▸' : '▾'} ${title}`,
    value: '',
    mentionKind: 'chat-group' as const,
    description: collapsed ? (t?.('group.expand') ?? '展开') : (t?.('group.collapse') ?? '折叠'),
    groupKey: key,
  }
}

/** The stable collapse key for one chat workspace group. */
export function chatGroupKey(cwd: string | undefined): string {
  return cwd === undefined ? 'chat:' : `chat:${workspaceTitle(cwd)}`
}

/** Chat rows grouped under their workspace, with sidebar-style relative time. */
function chatRows(
  chats: readonly ChatCandidate[],
  limit: number,
  now: number,
  collapsed: (key: string) => boolean,
  t?: (key: string, params?: Record<string, string>) => string,
  tagged = false,
): readonly MentionCandidate[] {
  const rows: MentionCandidate[] = []
  const groups = new Map<string, readonly ChatCandidate[]>()
  for (const chat of chats.slice(0, limit)) {
    const key = chatGroupKey(chat.cwd)
    const current = groups.get(key) ?? []
    groups.set(key, [...current, chat])
  }
  for (const [key, groupChats] of groups) {
    const title = key === 'chat:' ? workspaceTitle(undefined, t) : key.slice('chat:'.length)
    rows.push(chatGroupRow(title, collapsed(key), key, t))
    if (collapsed(key)) continue
    for (const chat of groupChats) {
      rows.push({
        name: chat.label === '' ? chat.sessionId : cleanChatLabel(chat.label),
        icon: menuIconKind('chat'),
        value: chat.sessionId,
        mentionKind: 'chat' as const,
        chatUri: chat.uri,
        description: tagged ? `${categoryTag('chat', t)} · ${relativeTimeLabel(chat.createdAt, now, t)}` : relativeTimeLabel(chat.createdAt, now, t),
      })
    }
  }
  return rows
}

/**
 * Build the '@' trigger source over the injected deps. One source per plugin
 * fiber; per-session caches live in the returned closure and die with it.
 * @param deps - Remote, locale, and clock faces.
 * @returns the source to register with `inputTriggers.registerSource`, plus
 *   the cache invalidator.
 */
export function createMentionSource(deps: MentionSourceDeps): MentionSource {
  const now = deps.now ?? (() => Date.now())
  const t = deps.t
  const collapsedGroups = new Map<SessionId, Map<string, boolean>>()
  // What the last render actually SHOWED, per group. The `folder:` view also folds the
  // path group by ROW BUDGET, so the rendered state can differ from `defaultCollapsed`;
  // the fold gesture must flip what the user sees, or pressing Enter on a
  // budget-expanded header would "fold" it to expanded again (observed in a spec).
  const renderedGroups = new Map<SessionId, Map<string, boolean>>()
  /**
   * The last scope each session's draft resolved to. The synchronous fold rebuild
   * needs it (the navigator writes rebuilt rows straight into the open menu), and
   * re-reading the composer DOM from a fold handler would be reading live state
   * mid-gesture.
   */
  const lastScopePaths = new Map<SessionId, string>()
  const warmedSessions = new Set<SessionId>()
  const rememberRendered = (sessionId: SessionId, key: string, collapsed: boolean): void => {
    const state = renderedGroups.get(sessionId) ?? new Map<string, boolean>()
    state.set(key, collapsed)
    renderedGroups.set(sessionId, state)
  }
  const toggleGroup = (sessionId: SessionId, key: string): void => {
    const state = collapsedGroups.get(sessionId) ?? new Map<string, boolean>()
    const current = state.get(key) ?? renderedGroups.get(sessionId)?.get(key) ?? defaultCollapsed(key)
    state.set(key, !current)
    collapsedGroups.set(sessionId, state)
  }
  const isCollapsed = (sessionId: SessionId, key: string): boolean =>
    collapsedGroups.get(sessionId)?.get(key) ?? defaultCollapsed(key)
  const fetches = new Map<SessionId, CategoryCache<FileEntry>>()
  const skillFetches = new Map<SessionId, CategoryCache<SkillCandidate>>()
  const chatFetches = new Map<SessionId, CategoryCache<ChatCandidate>>()
  const pluginCache: { current: CategoryCache<PluginCandidate> | undefined } = { current: undefined }
  const lexiconListeners = new Map<SessionId, Set<() => void>>()

  const notifyLexicon = (sessionId: SessionId): void => {
    for (const listener of [...(lexiconListeners.get(sessionId) ?? [])]) {
      try {
        listener()
      } catch (error) {
        // Contain listener failures: settlement notifies from an ignored
        // promise chain, and one faulty consumer must not starve the others.
        console.error('[dsh-atlas] lexicon listener failed:', error)
      }
    }
  }

  /** One shared entry with a per-session key (files and skills). */
  const fetchPerSession = <T,>(
    cache: Map<SessionId, CategoryCache<T>>,
    sessionId: SessionId,
    load: (signal: AbortSignal) => Promise<readonly T[]>,
    signal?: AbortSignal,
    onSettled?: () => void,
  ): Promise<readonly T[]> => {
    const entry = cache.get(sessionId)
    const nowVal = now()
    if (entry !== undefined) {
      if (entry.settled !== undefined) {
        if (nowVal - entry.at < CATEGORY_TTL_MS) {
          // Fresh settled page: serve it synchronously.
          return Promise.resolve(entry.settled)
        }
        // Stale-while-revalidate: serve the last page immediately and refresh
        // in the background (the caller never waits for the refresh).
        const abort = new AbortController()
        const promise = load(abort.signal)
        const next: CategoryCache<T> = { promise, abort, at: nowVal }
        cache.set(sessionId, next)
        promise.then(
          (values) => {
            next.settled = values
            onSettled?.()
          },
          () => {
            if (cache.get(sessionId) === next) cache.delete(sessionId)
          },
        )
        return Promise.resolve(entry.settled)
      }
      if (nowVal - entry.at < CATEGORY_TTL_MS) {
        // In-flight and fresh: join it.
        return entry.promise
      }
      // In-flight but stale: abort and refetch.
      cache.delete(sessionId)
      entry.abort.abort()
    }
    const abort = new AbortController()
    const promise = load(abort.signal)
    const next: CategoryCache<T> = { promise, abort, at: nowVal }
    cache.set(sessionId, next)
    promise.then(
      (values) => {
        next.settled = values
        onSettled?.()
      },
      () => {
        if (cache.get(sessionId) === next) cache.delete(sessionId)
      },
    )
    if (signal !== undefined) {
      return promise.then(values => (signal.aborted ? [] : values))
    }
    return promise
  }

  /** One shared global entry (plugins). */
  const fetchGlobal = <T,>(
    cache: { current: CategoryCache<T> | undefined },
    load: (signal: AbortSignal) => Promise<readonly T[]>,
    signal?: AbortSignal,
  ): Promise<readonly T[]> => {
    const entry = cache.current
    const nowVal = now()
    if (entry !== undefined && entry.settled !== undefined) {
      if (nowVal - entry.at < CATEGORY_TTL_MS) {
        return Promise.resolve(entry.settled)
      }
      // Stale-while-revalidate: serve the last page now, refresh in background.
      const abort = new AbortController()
      const promise = load(abort.signal)
      const next: CategoryCache<T> = { promise, abort, at: nowVal }
      cache.current = next
      promise.then(
        (values) => { next.settled = values },
        () => {
          if (cache.current === next) cache.current = undefined
        },
      )
      return Promise.resolve(entry.settled)
    }
    if (entry !== undefined && nowVal - entry.at < CATEGORY_TTL_MS) {
      // In-flight and fresh: join it.
      return entry.promise
    }
    if (entry !== undefined) {
      cache.current = undefined
      entry.abort.abort()
    }
    const abort = new AbortController()
    const promise = load(abort.signal)
    const next: CategoryCache<T> = { promise, abort, at: nowVal }
    cache.current = next
    promise.then(
      (values) => { next.settled = values },
      () => {
        if (cache.current === next) cache.current = undefined
      },
    )
    if (signal !== undefined) {
      return promise.then(values => (signal.aborted ? [] : values))
    }
    return promise
  }

  const fetchIndex = (sessionId: SessionId, signal?: AbortSignal): Promise<readonly FileEntry[]> =>
    fetchPerSession(fetches, sessionId, s => deps.search(sessionId, s), signal, () => notifyLexicon(sessionId))

  /**
   * The Host's out-of-workspace scope per session.
   *
   * A single value rather than a list, so it gets its own tiny cache instead of
   * the list-shaped {@link CategoryCache}: same TTL and abort discipline, one
   * cached scope per session, and a settled snapshot for synchronous reads.
   */
  interface ScopeCache {
    readonly promise: Promise<ExternalAccessScope>
    readonly abort: AbortController
    settled?: ExternalAccessScope
    readonly at: number
  }
  const externalFetches = new Map<SessionId, ScopeCache>()
  /** What a session with no answer yet offers: nothing, never a guess. */
  const NO_EXTERNAL: ExternalAccessScope = { canDiscover: false, roots: [], folders: [] }
  const fetchExternal = (sessionId: SessionId, signal?: AbortSignal): Promise<ExternalAccessScope> => {
    const load = deps.external
    if (load === undefined) return Promise.resolve(NO_EXTERNAL)
    const entry = externalFetches.get(sessionId)
    const at = now()
    if (entry !== undefined && entry.settled !== undefined && at - entry.at < CATEGORY_TTL_MS) {
      return Promise.resolve(entry.settled)
    }
    if (entry !== undefined && entry.settled !== undefined) {
      // Stale-while-revalidate: the last scope answers now and a fresh one is fetched
      // in the background. The ledger grows as the user SENDS references, and a
      // settled-but-stale scope used to hide a folder the Host already knew for a
      // whole TTL (reported: `@folder:do` did not offer the `e:/work/docs` the user had
      // just sent). The refresh also survives `invalidateExternal` below.
      const abort = new AbortController()
      const promise = load(sessionId, abort.signal)
      const next: ScopeCache = { promise, abort, at }
      externalFetches.set(sessionId, next)
      promise.then(
        (value) => { next.settled = value },
        () => { if (externalFetches.get(sessionId) === next) externalFetches.delete(sessionId) },
      )
      return Promise.resolve(entry.settled)
    }
    if (entry !== undefined && at - entry.at < CATEGORY_TTL_MS) return entry.promise
    if (entry !== undefined) {
      entry.abort.abort()
      externalFetches.delete(sessionId)
    }
    const abort = new AbortController()
    const promise = load(sessionId, abort.signal)
    const next: ScopeCache = { promise, abort, at }
    externalFetches.set(sessionId, next)
    promise.then(
      (value) => { next.settled = value },
      () => { if (externalFetches.get(sessionId) === next) externalFetches.delete(sessionId) },
    )
    return signal === undefined ? promise : promise.then(value => (signal.aborted ? NO_EXTERNAL : value))
  }

  /**
   * The out-of-workspace folder rows `@folder:` offers, from the Host's scope.
   *
   * An empty list is the common case and is never a failure: a session with no
   * resolved policy, or one that may only use ledger paths it has not used yet,
   * is expected to offer none. Each row is an ABSOLUTE path (that is what the
   * Host resolves and what the injected `<external-reference>` carries) with the
   * trailing separator a folder mention spells, and says "工作区外" so an external
   * row is never mistaken for a workspace one.
   * @param sessionId - the session whose scope was fetched.
   * @returns the rows to PREPEND to the folder category's own rows.
   */
  const externalFolderRows = (sessionId: SessionId): readonly MentionCandidate[] => {
    const scope = externalFetches.get(sessionId)?.settled
    if (scope === undefined || scope.folders.length === 0) return []
    const outside = t?.('folder.outside') ?? '工作区外'
    return scope.folders.map(folder => {
      const path = externalPath(folder)
      const parent = dirnameOf(path)
      return {
        name: `${basenameOf(path)}/`,
        icon: menuIconKind('folder'),
        value: `${path}/`,
        atFileKind: 'dir' as const,
        mentionKind: 'dir' as const,
        description: parent === '' ? outside : `${outside} · ${parent}`,
      }
    })
  }

  /**
   * One scoped folder's listing (R-05), cached per path with the same TTL and
   * stale-while-revalidate discipline as the session scope: the folder is being
   * browsed while its contents can change, and a settled answer must keep the
   * browse instant without freezing for a whole TTL.
   */
  interface ScopeListingCache {
    readonly promise: Promise<DirectoryListing>
    readonly abort: AbortController
    settled?: DirectoryListing
    readonly at: number
  }
  const scopeListings = new Map<string, ScopeListingCache>()
  const fetchScopeListing = (sessionId: SessionId, path: string, signal?: AbortSignal): Promise<DirectoryListing> => {
    // The only caller (`scopeFileRows`) has already checked that this build has a
    // listing seam, so the face is narrowed here instead of guarded twice.
    const load = deps.list as (id: SessionId, directory: string, signal: AbortSignal) => Promise<DirectoryListing>
    const key = `${sessionId}\u0000${path.toLowerCase()}`
    const entry = scopeListings.get(key)
    const at = now()
    const remember = (next: ScopeListingCache): void => {
      scopeListings.set(key, next)
      next.promise.then(
        (value) => { next.settled = value },
        () => { if (scopeListings.get(key) === next) scopeListings.delete(key) },
      )
    }
    if (entry !== undefined && entry.settled !== undefined && at - entry.at < CATEGORY_TTL_MS) {
      return Promise.resolve(entry.settled)
    }
    if (entry !== undefined && entry.settled !== undefined) {
      const abort = new AbortController()
      remember({ promise: load(sessionId, path, abort.signal), abort, at })
      return Promise.resolve(entry.settled)
    }
    if (entry !== undefined && at - entry.at < CATEGORY_TTL_MS) return entry.promise
    if (entry !== undefined) {
      entry.abort.abort()
      scopeListings.delete(key)
    }
    const abort = new AbortController()
    const promise = load(sessionId, path, abort.signal)
    remember({ promise, abort, at })
    if (signal === undefined) return promise
    return promise.then(value => (signal.aborted ? { path, entries: [] } : value))
  }

  /**
   * Whether one path is inside the session workspace.
   *
   * A workspace folder's files are already in the index, so a scope that points
   * inside the workspace needs no listing at all: the workspace tier already holds
   * them, and listing them a second time would show the same file twice.
   * @param sessionId - the session whose workspace root scopes the question.
   * @param path - the candidate scope path (absolute or workspace-relative).
   * @returns true when the index already covers that folder.
   */
  const insideWorkspace = (sessionId: SessionId, path: string): boolean => {
    if (!isAbsoluteReference(path)) return true
    const root = workspaceRootOf(sessionId).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
    if (root === '') return false
    const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
    return normalized === root || normalized.startsWith(`${root}/`)
  }

  /**
   * The rows one draft scope contributes: that folder's own FILES, one level deep.
   *
   * Only the folder the user named is listed — never its descendants — because the
   * scope answers "this folder's files", and a recursive walk would spend the whole
   * budget on one subtree. A folder the Host refuses (outside the session's allowed
   * scope, or gone) contributes nothing rather than an empty-looking group: the
   * workspace tier above it still answers the query.
   * @param sessionId - the session whose scope may be read.
   * @param scopePath - the folder the draft named.
   * @param needle - the lowercased query, or '' for the unfiltered view.
   * @param signal - caller lifetime.
   * @returns the matching rows and the folder's label.
   */
  const scopeFileRows = async (
    sessionId: SessionId,
    scopePath: string,
    needle: string,
    signal: AbortSignal,
  ): Promise<{ readonly rows: readonly MentionCandidate[]; readonly label: string }> => {
    const path = scopePath.replace(/[/\\]+$/u, '')
    const none = { rows: [] as readonly MentionCandidate[], label: '' }
    if (path === '' || insideWorkspace(sessionId, path) || deps.list === undefined) return none
    let listing: DirectoryListing
    try {
      listing = await fetchScopeListing(sessionId, path, signal)
    } catch (error) {
      // A refused or vanished folder is not an error the user has to read: the
      // scope simply contributes no rows.
      if (!isCancellation(error, signal)) console.warn('[dsh-atlas] scoped folder listing failed:', error)
      return none
    }
    if (listing.error !== undefined) return none
    const outside = t?.('folder.outside') ?? '工作区外'
    const rows = listing.entries
      .filter(entry => entry.kind === 'file' && (needle === '' || entry.name.toLowerCase().includes(needle)))
      .map(entry => ({
        name: entry.name,
        icon: menuIconKind('file'),
        value: childOf(listing.path, entry.name),
        mentionKind: 'file' as const,
        description: `${outside} · ${path}`,
      }))
    return { rows, label: basenameOf(path) }
  }

  const fetchSkills = (sessionId: SessionId, signal?: AbortSignal): Promise<readonly SkillCandidate[]> =>
    deps.listSkills === undefined
      ? Promise.resolve([])
      : fetchPerSession(skillFetches, sessionId, s => (deps.listSkills as (id: SessionId, signal: AbortSignal) => Promise<readonly SkillCandidate[]>)(sessionId, s), signal)

  const fetchPlugins = (signal?: AbortSignal): Promise<readonly PluginCandidate[]> =>
    deps.listPlugins === undefined
      ? Promise.resolve([])
      : fetchGlobal(pluginCache, s => (deps.listPlugins as (signal: AbortSignal) => Promise<readonly PluginCandidate[]>)(s), signal)

  const fetchChats = (sessionId: SessionId, query: string, signal: AbortSignal): Promise<readonly ChatCandidate[]> => {
    if (deps.listChats === undefined) return Promise.resolve([])
    const load = (s: AbortSignal) => (deps.listChats as (id: SessionId, q: string, limit: number, signal: AbortSignal) => Promise<readonly ChatCandidate[]>)(sessionId, query, CHAT_PAGE, s)
    // The initial (empty-query) page is cached per session so the @chat: list
    // opens instantly and collapse toggles can rebuild synchronously.
    return query.trim() === ''
      ? fetchPerSession(chatFetches, sessionId, load, signal)
      : load(signal)
  }

  const findEntry = (sessionId: SessionId, relative: string): FileEntry | undefined =>
    fetches.get(sessionId)?.settled?.find(file => file.relative === relative)

  /** Preload one category's list in the background (cache stays warm for TTL). */
  const warmCategory = (sessionId: SessionId, key: CategoryKey): void => {
    if (key === 'file' || key === 'folder') {
      void fetchIndex(sessionId).catch(() => {})
      // The out-of-workspace scope belongs to the folder category, and warming it
      // here is what makes its rows appear on the FIRST open of `@folder:`.
      if (deps.external !== undefined) void fetchExternal(sessionId).catch(() => {})
    } else if (key === 'skill') {
      void fetchSkills(sessionId).catch(() => {})
    } else if (key === 'chat') {
      void fetchChats(sessionId, '', new AbortController().signal).catch(() => {})
    } else {
      void fetchPlugins().catch(() => {})
    }
  }

  /**
   * The folder category's rows: a way OUT of the workspace, then two groups.
   *
   * The order is the whole point. The workspace folders come last because they are
   * the ones a session already has; the out-of-workspace folders — the reason this
   * category exists — come second, as a foldable group instead of a flat list that
   * used to push the workspace rows past the fold (reported with a screenshot).
   * While a query is being filtered BOTH groups stay expanded and are filtered by
   * the same text, because the user asked for "区内 和 区外" together at that point.
   * @param sessionId - the answered session.
   * @param files - the settled workspace index.
   * @param query - the text after `folder:`.
   * @returns the rows, in menu order.
   */
  const folderCategoryRows = (
    sessionId: SessionId,
    files: readonly FileEntry[],
    query: string,
  ): readonly MentionCandidate[] => {
    const trimmed = query.trim()
    const outside = externalFolderRows(sessionId)
    const own = candidateRows(rankFilesWithFuzzy(files, query, MAX_CANDIDATES), 'dir', false, t)
    if (trimmed !== '') {
      // Filtering is TWO tiers, in this order (user's口径):
      // 1. folders whose NAME matches — workspace first, then outside the workspace;
      // 2. folders that only their PATH matches (`E:/…` contains the letter the user
      //    typed) — ONE group of their own, spending only the ROW BUDGET the name
      //    matches left behind: a single letter matches almost every path under an
      //    `E:`-rooted workspace, so the budget is what keeps it from burying tier 1,
      //    while a handful of matches stays visible instead of hiding behind a fold.
      const needle = trimmed.toLowerCase()
      const nameOf = (value: string): string => basenameOf(value.replace(/[/\\]+$/u, '')).toLowerCase()
      const dirs = files.filter(file => file.kind === 'dir')
      const ownByName = dirs.filter(file => nameOf(file.relative).includes(needle))
      const ownNamed = new Set(ownByName)
      const ownByPath = dirs.filter(file => !ownNamed.has(file) && file.relative.toLowerCase().includes(needle))
      const outsideByName = outside.filter(row => nameOf(row.value ?? '').includes(needle))
      const namedOutside = new Set(outsideByName.map(row => row.value))
      const outsideByPath = outside.filter(row => !namedOutside.has(row.value) && (row.value ?? '').toLowerCase().includes(needle))
      const byPath = [...candidateRows(ownByPath, 'dir', false, t), ...outsideByPath]
      // The path group is folded only when it would CROWD the name matches: the
      // user's口径 is "如果多就折叠", so when the rest of the budget covers it the
      // matches are simply shown. An explicit fold/unfold always wins.
      const explicitPath = collapsedGroups.get(sessionId)?.get(PATH_GROUP_KEY)
      const rows: MentionCandidate[] = []
      const push = (row: MentionCandidate): void => {
        // One row of the budget belongs to the back row the caller prepends.
        if (rows.length < FOLDER_ROW_BUDGET - 1) rows.push(row)
      }
      if (ownByName.length > 0) {
        push(dirGroupRow(WORKSPACE_GROUP_KEY, t?.('folder.workspaceGroup') ?? '工作区文件夹', false, t))
        for (const row of candidateRows(ownByName, 'dir', false, t)) push(row)
      }
      if (outsideByName.length > 0) {
        push(dirGroupRow(OUTSIDE_GROUP_KEY, t?.('folder.outsideGroup') ?? '工作区外文件夹', false, t))
        for (const row of outsideByName) push(row)
      }
      // The path tier is shown whenever the name matches left it room, and it spends
      // only that leftover budget: the user's口径 is "if there are many, fold them
      // together", and the BUDGET is what does that folding — name matches keep the
      // top rows, and a flood of path-only hits can never bury them. Folding the group
      // by hand (`explicitPath`) still wins, and a group with no room at all (all ten
      // rows already spent on name matches) is not rendered: a header that cannot show
      // a single row would be a dead gesture.
      const room = FOLDER_ROW_BUDGET - 2 - rows.length
      if (byPath.length > 0 && room > 0) {
        const pathCollapsed = explicitPath ?? false
        rememberRendered(sessionId, PATH_GROUP_KEY, pathCollapsed)
        push(dirGroupRow(PATH_GROUP_KEY, t?.('folder.pathGroup') ?? '路径匹配', pathCollapsed, t))
        if (!pathCollapsed) for (const row of byPath) push(row)
      }
      return rows
    }
    const outsideCollapsed = isCollapsed(sessionId, OUTSIDE_GROUP_KEY)
    const workspaceCollapsed = isCollapsed(sessionId, WORKSPACE_GROUP_KEY)
    const rest: MentionCandidate[] = []
    const pushRest = (row: MentionCandidate): void => {
      if (rest.length < FOLDER_ROW_BUDGET - 1) rest.push(row)
    }
    if (outside.length > 0) {
      pushRest(dirGroupRow(OUTSIDE_GROUP_KEY, t?.('folder.outsideGroup') ?? '工作区外文件夹', outsideCollapsed, t))
      if (!outsideCollapsed) for (const row of outside) pushRest(row)
    }
    pushRest(dirGroupRow(WORKSPACE_GROUP_KEY, t?.('folder.workspaceGroup') ?? '工作区文件夹', workspaceCollapsed, t))
    if (!workspaceCollapsed) for (const row of own) pushRest(row)
    // The picker row is this view's default highlight: it is never spent by the cap.
    return [folderChooseRow(t), ...rest]
  }

  /** The session workspace root, as the folder browser starts from it. */
  const workspaceRootOf = (sessionId: SessionId): string => {
    const first = fetches.get(sessionId)?.settled?.[0]
    if (first === undefined) return ''
    return workspaceFromAbsolute(first.path, first.relative).replace(/[/\\]+$/u, '')
  }

  /** One note row: a browsing fact the user has to read, and cannot pick. */
  const browseNote = (text: string): MentionCandidate => ({
    name: text,
    value: '',
    mentionKind: 'browse-note' as const,
  })

  /**
   * The rows for one browsed directory: up, other drives, then its own children.
   *
   * A directory row is a normal pick (it lands `@<path>/` — a folder reference) and
   * ALSO drills (Tab, or the row's chevron), which is the framework's own descent
   * gesture and keeps this menu open on the child. `..` and a drive both descend the
   * same way on a plain click, because that is the only thing they can mean.
   * @param sessionId - the answered session.
   * @param path - the absolute directory to list.
   * @param signal - caller lifetime.
   * @returns the rows, or a single note explaining why there is nothing to walk.
   */
  const browseRows = async (
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
  ): Promise<readonly MentionCandidate[]> => {
    const load = deps.list
    if (load === undefined) return []
    let listing: DirectoryListing
    try {
      listing = await load(sessionId, path, signal)
    } catch (error: unknown) {
      if (isCancellation(error, signal)) return []
      console.error('[dsh-atlas] the folder browser could not list a directory:', error)
      return [browseNote(t?.('folder.error.unavailable') ?? '这个文件夹现在读不到。')]
    }
    if (listing.error !== undefined) {
      return [browseNote(t?.(`folder.error.${listing.error}`) ?? listing.error)]
    }
    const rows: MentionCandidate[] = []
    if (listing.parent !== undefined) {
      rows.push({
        name: `⬆ ${t?.('folder.up') ?? '上一级'}`,
        icon: menuIconKind('folder'),
        value: listing.parent,
        mentionKind: 'browse-up' as const,
        description: listing.parent,
      })
    }
    for (const drive of listing.drives ?? []) {
      rows.push({
        name: drive,
        icon: menuIconKind('folder'),
        value: drive,
        mentionKind: 'browse-drive' as const,
        description: t?.('folder.drive') ?? '盘符',
      })
    }
    for (const entry of listing.entries) {
      rows.push({
        name: entry.kind === 'dir' ? `${entry.name}/` : entry.name,
        icon: menuIconKind(entry.kind === 'dir' ? 'folder' : 'file'),
        value: childOf(listing.path, entry.name),
        mentionKind: entry.kind === 'dir' ? 'browse-dir' as const : 'browse-file' as const,
        ...(entry.kind === 'dir' ? { drill: true as const } : {}),
      })
    }
    if (rows.length === 0) return [browseNote(t?.('folder.empty') ?? '空文件夹')]
    if (listing.truncated === true) rows.push(browseNote(t?.('folder.truncated') ?? '条目过多，只显示前 200 项。'))
    return rows
  }

  /** The collapse key of one scoped folder's group in the file view. */
  const fileScopeKey = (path: string): string => `file:scope:${path.toLowerCase()}`

  /** The scope one file view is drawn with: the folder, its label, and its rows. */
  interface FileScope {
    readonly path: string
    readonly label: string
    readonly rows: readonly MentionCandidate[]
  }

  /**
   * The draft's scope for the file view (R-05), with its listing already read.
   *
   * The resolved path is remembered for the synchronous rebuild a group fold needs
   * (see {@link rebuildRows}): that path is what a toggle re-renders with, and
   * asking the composer DOM again from a fold handler would be reading live state
   * mid-gesture.
   * @param sessionId - the session whose draft is scoped.
   * @param query - the live query (the scope's rows are name-filtered by it).
   * @param signal - caller lifetime.
   * @returns the scope, or undefined when the draft names no out-of-workspace folder.
   */
  const resolveFileScope = async (
    sessionId: SessionId,
    query: string,
    signal?: AbortSignal,
  ): Promise<FileScope | undefined> => {
    const read = deps.scopeFolder
    if (read === undefined) return undefined
    const abort = signal ?? new AbortController().signal
    let path: string | undefined
    try {
      path = await read(sessionId, abort)
    } catch (error) {
      if (!isCancellation(error, abort)) console.warn('[dsh-atlas] draft scope lookup failed:', error)
      return undefined
    }
    if (path === undefined || path.trim() === '') return undefined
    lastScopePaths.set(sessionId, path)
    const listed = await scopeFileRows(sessionId, path, query.trim().toLowerCase(), abort)
    if (listed.label === '') return undefined
    return { path: path.replace(/[/\\]+$/u, ''), label: listed.label, rows: listed.rows }
  }

  /**
   * The rows of one scope, from the SETTLED listing cache only.
   *
   * A fold rebuilds rows synchronously (the navigator writes them straight into the
   * open menu), so it can only use what has already arrived; anything else makes the
   * caller refetch instead of drawing a scope-less view.
   * @param sessionId - the session whose last resolved scope is reused.
   * @param query - the live query.
   * @returns the scope, or undefined when nothing is settled for it.
   */
  const settledFileScope = (sessionId: SessionId, query: string): FileScope | undefined => {
    const path = lastScopePaths.get(sessionId)
    if (path === undefined) return undefined
    const normalized = path.replace(/[/\\]+$/u, '')
    const listing = scopeListings.get(`${sessionId}\u0000${normalized.toLowerCase()}`)?.settled
    if (listing === undefined || listing.error !== undefined) return undefined
    const needle = query.trim().toLowerCase()
    const outside = t?.('folder.outside') ?? '工作区外'
    const rows = listing.entries
      .filter(entry => entry.kind === 'file' && (needle === '' || entry.name.toLowerCase().includes(needle)))
      .map(entry => ({
        name: entry.name,
        icon: menuIconKind('file'),
        value: childOf(listing.path, entry.name),
        mentionKind: 'file' as const,
        description: `${outside} · ${normalized}`,
      }))
    return { path: normalized, label: basenameOf(normalized), rows }
  }

  /**
   * The `@file:` rows, tiered exactly like the folder view when the draft is scoped.
   *
   * The user's口径 (R-05): 区内 》 区外 》 路径匹配, with the same row budget and the
   * same fold behaviour. 区内 is the workspace index (name matches first); 区外 is the
   * folder the draft named, one level deep, under its own group header; 路径匹配 is
   * the index's path-only hits, which spend whatever budget is left. An UNSCOPED
   * query keeps this view exactly as it was — with no scope there is no second tier
   * to rank against, and `rankFiles` already answers name matches only.
   * @param sessionId - the session whose index and scope are used.
   * @param files - the settled workspace index.
   * @param query - the live query.
   * @param scope - the resolved scope, or undefined.
   * @returns the row list, bounded by {@link FILE_ROW_BUDGET}.
   */
  const fileCategoryRows = (
    sessionId: SessionId,
    files: readonly FileEntry[],
    query: string,
    scope: FileScope | undefined,
  ): readonly MentionCandidate[] => {
    // One row of the budget is the back row the caller prepends. The SAME budget
    // bounds a scoped and an unscoped view: the user asked for one口径 for the whole
    // picker, and the framework renders every settled row, so a view that could grow
    // to twenty was the odd one out (it used to be capped by MAX_CANDIDATES alone).
    const budgeted = (rows: readonly MentionCandidate[]): readonly MentionCandidate[] =>
      rows.slice(0, FILE_ROW_BUDGET - 1)
    if (scope === undefined) {
      if (query.trim() === '') return budgeted(recentFirstRows(files, sessionId))
      return budgeted(candidateRows(rankFilesWithFuzzy(files, query, MAX_CANDIDATES), 'file', false, t))
    }
    const needle = query.trim().toLowerCase()
    const fileEntries = files.filter(file => file.kind === 'file')
    const rows: MentionCandidate[] = []
    // One row of the budget is the back row the caller prepends.
    const push = (row: MentionCandidate): void => {
      if (rows.length < FILE_ROW_BUDGET - 1) rows.push(row)
    }
    // 区外: the folder the draft named, under a header that says which folder it is.
    const groupKey = fileScopeKey(scope.path)
    const scopeCollapsed = isCollapsed(sessionId, groupKey)
    const pushScope = (): void => {
      if (scope.rows.length === 0) return
      // The header carries "工作区外" on purpose: a scope group that only said
      // "docs 中的文件" reads like the WORKSPACE's own `docs` folder (reported with
      // a screenshot), and the folder category already taught this vocabulary.
      const title = t?.('file.scopeGroup', { name: scope.label }) ?? `工作区外 · ${scope.label} 中的文件`
      push(dirGroupRow(groupKey, title, scopeCollapsed, t))
      rememberRendered(sessionId, groupKey, scopeCollapsed)
      if (!scopeCollapsed) for (const row of scope.rows) push(row)
    }
    const pushPathTier = (byPath: readonly FileEntry[]): void => {
      // The same fold口径 as the folder view (R-04): shown whenever the budget
      // covers it, and dropped entirely when the tiers above spent it all.
      const room = FILE_ROW_BUDGET - 2 - rows.length
      if (byPath.length === 0 || room <= 0) return
      const pathCollapsed = collapsedGroups.get(sessionId)?.get(FILE_PATH_GROUP_KEY) ?? false
      rememberRendered(sessionId, FILE_PATH_GROUP_KEY, pathCollapsed)
      push(dirGroupRow(FILE_PATH_GROUP_KEY, t?.('folder.pathGroup') ?? '路径匹配', pathCollapsed, t))
      if (!pathCollapsed) for (const row of candidateRows(byPath, 'file', false, t)) push(row)
    }
    if (needle === '') {
      // The unfiltered view exists FOR the scope: the folder the user just named is
      // what they are pointing at, so it leads and the recents fill what is left.
      pushScope()
      for (const row of recentFirstRows(fileEntries, sessionId)) push(row)
      return rows
    }
    // 区内: the workspace's own name matches.
    const byName = fileEntries.filter(file => basenameOf(file.relative).toLowerCase().includes(needle))
    const named = new Set(byName)
    const byPath = fileEntries.filter(file => !named.has(file) && file.relative.toLowerCase().includes(needle))
    for (const row of candidateRows(rankFilesWithFuzzy(byName, query, MAX_CANDIDATES), 'file', false, t)) push(row)
    pushScope()
    pushPathTier(byPath)
    return rows
  }

  /** Build the rows for one of the list-shaped categories from already-fetched lists. */
  const categoryRowsFor = (
    category: CategoryDef,
    skills: readonly SkillCandidate[],
    chats: readonly ChatCandidate[],
    plugins: readonly PluginCandidate[],
    sub: string,
    sessionId: SessionId,
  ): readonly MentionCandidate[] => {
    if (category.key === 'skill') return skillRows(skills, sub, MAX_CANDIDATES, key => isCollapsed(sessionId, key), t)
    if (category.key === 'chat') return chatRows(chats, MAX_CANDIDATES, now(), key => isCollapsed(sessionId, key), t)
    return pluginRows(plugins, sub, MAX_CANDIDATES, key => isCollapsed(sessionId, key), t)
  }

  /** One provider item as a menu row (the value stays the provider's own item id). */
  const providerRow = (registration: AtlasRegistration, item: AtlasItem): MentionCandidate => ({
    name: item.title,
    icon: menuIconKind('plugin'),
    value: item.id,
    mentionKind: 'provider' as const,
    providerId: registration.id,
    // No framework glyph fits a provider's own item, and the row must not borrow
    // one: an iconless row beats a mislabelled one.
    ...(item.preview === undefined ? {} : { hint: item.preview }),
    description: item.badge === undefined ? registration.id : `${registration.id} · ${item.badge}`,
  })

  /**
   * The rows for one provider category, from that provider's own `list`.
   *
   * The provider is called here and nowhere else, with the caller's signal, and
   * only while a menu is open: registration is what makes it reachable at all,
   * and nothing is cached across queries — a provider owns its own caching.
   * @param providerId - the provider handle (already validated by the registry).
   * @param query - the text after the `@<id>:` prefix.
   * @param sessionId - the answered session.
   * @param signal - caller lifetime.
   * @returns the provider's rows; a failing provider yields none, never an error row.
   */
  const providerRows = async (
    providerId: string,
    query: string,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<readonly MentionCandidate[]> => {
    const registration = deps.atlasProviders?.().find(entry => entry.id === providerId)
    const list = registration?.provider.list
    if (registration === undefined || list === undefined) return []
    try {
      const items = await list(query, { sessionId, signal })
      return items.map(item => providerRow(registration, item)).slice(0, MAX_CANDIDATES)
    } catch (error) {
      // A superseded keystroke aborts the previous call: that is the menu
      // working, not a provider failing.
      if (!isCancellation(error, signal)) {
        console.error(`[dsh-atlas] atlas provider "${providerId}" list failed:`, error)
      }
      return []
    }
  }

  /** The live provider categories, rebuilt per request (registration is the gate). */
  const liveProviders = (): readonly CategoryDef[] => providerCategories(deps.atlasProviders?.() ?? [])

  /**
   * Mixed-search rows across every registered provider: each answers its own
   * `list` with the live query, in parallel, under one shared row budget. A
   * provider that fails or is slow contributes nothing rather than an error row.
   * @param query - the live query.
   * @param sessionId - the answered session.
   * @param signal - caller lifetime.
   * @returns the provider rows for the mixed view, bounded by the shared budget.
   */
  const providerMatches = async (
    query: string,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<readonly MentionCandidate[]> => {
    const registrations = (deps.atlasProviders?.() ?? []).filter(entry => entry.provider.list !== undefined)
    if (registrations.length === 0) return []
    const perProvider = Math.max(1, Math.floor(PROVIDER_MIX_LIMIT / registrations.length))
    const results = await Promise.all(registrations.map(async registration =>
      (await providerRows(registration.id, query, sessionId, signal)).slice(0, perProvider)))
    return results.flat()
  }

  /** Rebuild the rows for one category query synchronously from settled caches. */
  const rebuildRows = (sessionId: SessionId, query: string): readonly MentionCandidate[] | undefined => {
    const category = categoryOfQuery(query)
    if (category === undefined) return undefined
    const sub = query.slice(category.prefix.length)
    let rows: readonly MentionCandidate[]
    if (category.key === 'file' || category.key === 'folder') {
      const files = fetches.get(sessionId)?.settled
      if (files === undefined) return undefined
      if (category.key === 'folder') {
        rows = folderCategoryRows(sessionId, files, sub)
      } else {
        // The file view's scope rows arrive asynchronously with the folder's
        // listing; a fold rebuild can only use one that has already landed, and
        // answers `undefined` otherwise so the caller refetches instead of redrawing
        // the view without the scope it is showing.
        const scope = settledFileScope(sessionId, sub)
        if (lastScopePaths.has(sessionId) && scope === undefined) return undefined
        rows = fileCategoryRows(sessionId, files, sub, scope)
      }
    } else if (category.key === 'skill') {
      const skills = skillFetches.get(sessionId)?.settled
      if (skills === undefined) return undefined
      rows = categoryRowsFor(category, skills, [], [], sub, sessionId)
    } else if (category.key === 'chat') {
      const chats = chatFetches.get(sessionId)?.settled
      if (chats === undefined) return undefined
      rows = categoryRowsFor(category, [], chats, [], sub, sessionId)
    } else {
      const plugins = pluginCache.current?.settled
      if (plugins === undefined) return undefined
      rows = categoryRowsFor(category, [], [], plugins, sub, sessionId)
    }
    return [backRow(t), ...rows]
  }

  /** One usage row rebuilt from the live catalogs, or undefined when unknown. */
  const usageRowFor = (
    kind: string,
    value: string,
    catalogs: {
      readonly files: readonly FileEntry[]
      readonly skills: readonly SkillCandidate[]
      readonly chats: readonly ChatCandidate[]
      readonly plugins: readonly PluginCandidate[]
    },
    t?: Translate,
  ): MentionCandidate | undefined => {
    if (kind === 'file' || kind === 'dir') {
      const file = catalogs.files.find(candidate => candidate.relative === value)
      if (file === undefined) return undefined
      return candidateRows([file], kind === 'dir' ? 'dir' : 'file', false, t)[0]
    }
    if (kind === 'skill') {
      const skill = catalogs.skills.find(candidate => candidate.name === value)
      if (skill === undefined) return undefined
      return {
        name: skill.name,
        icon: menuIconKind('skill'),
        value: skill.name,
        mentionKind: 'skill' as const,
        ...(skill.description === '' ? {} : { description: `${categoryTag('skill', t)} · ${skill.description}` }),
      }
    }
    if (kind === 'chat') {
      const chat = catalogs.chats.find(candidate => candidate.sessionId === value)
      if (chat === undefined) return undefined
      return {
        name: chat.label === '' ? chat.sessionId : cleanChatLabel(chat.label),
        icon: menuIconKind('chat'),
        value: chat.sessionId,
        mentionKind: 'chat' as const,
        chatUri: chat.uri,
        ...(chat.cwd === undefined ? {} : { description: workspaceTitle(chat.cwd, t) }),
      }
    }
    if (kind === 'plugin') {
      const plugin = catalogs.plugins.find(candidate => candidate.moduleName === value)
      if (plugin === undefined || !plugin.enabled) return undefined
      return {
        name: plugin.moduleName,
        icon: menuIconKind('plugin'),
        value: plugin.moduleName,
        mentionKind: 'plugin' as const,
      }
    }
    if (kind === 'atlas') {
      // A provider pick is stored as `atlas:<provider>/<item>`. The most-used
      // list recalls it from the registry alone: asking the provider again
      // would spend its `list` on every keystroke, and the row only has to
      // reproduce the token, not the provider's preview.
      const slash = value.indexOf('/')
      if (slash <= 0) return undefined
      const registration = deps.atlasProviders?.().find(entry => entry.id === value.slice(0, slash))
      const itemId = value.slice(slash + 1)
      if (registration === undefined || itemId === '') return undefined
      return providerRow(registration, { id: itemId, title: itemId })
    }
    return undefined
  }

  /**
   * The most-picked references across every category, highest count first, then
   * most recent, filtered by the live query. Keys are `${kind}:${value}` — the
   * same mention-kind vocabulary the picker and the dock share — so a category
   * added later participates without further wiring. Entries the live catalogs
   * no longer know (a deleted chat, an uninstalled plugin) are skipped rather
   * than rendered as broken rows.
   * @param query - the live query (the pasted-marker check already ran).
   * @param catalogs - the settled category pages fetched for this query.
   * @param limit - maximum rows.
   * @param t - locale binder.
   * @returns the usage rows, most-picked first.
   */
  const usageRows = (
    query: string,
    catalogs: {
      readonly files: readonly FileEntry[]
      readonly skills: readonly SkillCandidate[]
      readonly chats: readonly ChatCandidate[]
      readonly plugins: readonly PluginCandidate[]
    },
    limit: number,
    t?: Translate,
  ): readonly MentionCandidate[] => {
    const entries = deps.usage === undefined ? [] : [...deps.usage()]
    entries.sort((a, b) => b.count - a.count || b.at - a.at)
    const out: MentionCandidate[] = []
    for (const entry of entries) {
      if (out.length >= limit) break
      const separator = entry.key.indexOf(':')
      if (separator <= 0) continue
      const kind = entry.key.slice(0, separator)
      const value = entry.key.slice(separator + 1)
      if (value === '' || !matches(query, value)) continue
      const row = usageRowFor(kind, value, catalogs, t)
      if (row !== undefined) out.push(row)
    }
    return out
  }

  /**
   * File rows for the @file: initial view: recently referenced first, then
   * alphabetical.
   *
   * Bounded by {@link MAX_CANDIDATES} exactly like a typed file query. The
   * framework renders every row a source settles with (its viewport is a fixed
   * height, but the list is NOT virtualized), so an uncapped first view put the
   * WHOLE workspace index into the menu — measured live at 180 rows — and every
   * keystroke then re-rendered them while the query re-settled. The recent rows
   * are what this view exists for, so the cap keeps them and never the tail.
   * @param files - the settled workspace index.
   * @param sessionId - the session whose recent-file roll is consulted.
   * @returns the row list, most-recent first, capped.
   */
  const recentFirstRows = (files: readonly FileEntry[], sessionId: SessionId): readonly MentionCandidate[] => {
    const workspace = files.length === 0 ? '' : workspaceFromAbsolute(files[0]!.path, files[0]!.relative)
    const recent = deps.recentFiles === undefined ? [] : deps.recentFiles(sessionId, workspace)
    const byRel = new Map(files.map(file => [file.relative, file]))
    const ordered: FileEntry[] = []
    const seen = new Set<string>()
    for (const relative of recent) {
      const file = byRel.get(relative)
      if (file === undefined || file.kind !== 'file' || seen.has(relative)) continue
      seen.add(relative)
      ordered.push(file)
    }
    const rest = files
      .filter(file => file.kind === 'file' && !seen.has(file.relative))
      .sort((a, b) => a.relative.localeCompare(b.relative))
    return candidateRows([...ordered, ...rest].slice(0, MAX_CANDIDATES), 'file', false, t)
  }

  /**
   * Forget one session's out-of-workspace scope so the next read asks the Host
   * again. Called when a message is submitted: the Host records a referenced
   * external path in its ledger during that send, and a cached scope would keep
   * hiding it from `@folder:` until its TTL expired.
   * @param sessionId - the session whose scope is dropped.
   */
  const invalidateExternal = (sessionId: SessionId): void => {
    const entry = externalFetches.get(sessionId)
    if (entry === undefined) return
    entry.abort.abort()
    externalFetches.delete(sessionId)
  }

  const invalidateAll = (): void => {
    for (const entry of [...fetches.values()]) entry.abort.abort()
    for (const entry of [...skillFetches.values()]) entry.abort.abort()
    for (const entry of [...externalFetches.values()]) entry.abort.abort()
    for (const entry of [...scopeListings.values()]) entry.abort.abort()
    if (pluginCache.current !== undefined) pluginCache.current.abort.abort()
    fetches.clear()
    skillFetches.clear()
    chatFetches.clear()
    externalFetches.clear()
    scopeListings.clear()
    lastScopePaths.clear()
    pluginCache.current = undefined
    collapsedGroups.clear()
    renderedGroups.clear()
    for (const listeners of [...lexiconListeners.values()]) {
      for (const listener of listeners) listener()
    }
  }

  const source: InputTriggerSource = {
    trigger: '@',
    name: SOURCE_NAME,
    // The menu lists one group per `@` source, ordered by this number (the
    // roster sorts by it, unset meaning 0). A POSITIVE value puts this plugin's
    // group LAST, and that is the point: the menu opens above the composer, so
    // the bottom of the list is the band next to where the user is typing. The
    // categories and the Tab hint live there, which is why the eye never has to
    // travel to the top of the menu to find them.
    order: 1,
    async candidates(session, { query, signal }) {
      // A protected query came from pasted text. Keep the menu closed from the
      // plugin's point of view instead of treating it as a lookup.
      if (query.includes(PASTED_MENTION_MARKER)) return []
      // Pre-warm every category page once per session on the first @
      // interaction. The plugin list is light and warms FIRST so it settles
      // ahead of the heavier file/chat/skill scans (which share the host loop).
      if (!warmedSessions.has(session.sessionId)) {
        warmedSessions.add(session.sessionId)
        warmCategory(session.sessionId, 'plugin')
        warmCategory(session.sessionId, 'file')
        warmCategory(session.sessionId, 'chat')
        warmCategory(session.sessionId, 'skill')
      }
      const providers = liveProviders()
      // A PATH in the draft is a folder to walk, not a query to match: `@E:/…` and
      // `@folder:E:/…` both open the browser on that directory (a drive letter
      // alone means its root). This is also where the browser's own picks land,
      // since they write a plain `@<absolute>/` mention and keep the menu open.
      const browserTarget = browseTarget(query)
      if (browserTarget !== undefined) return browseRows(session.sessionId, browserTarget, signal)
      const category = categoryOfQuery(query, providers)
      if (category === undefined) {
        if (query.trim() === '') return categoryRows(t, providers)
        // Intent detection: a single matching category earns the pinned gray
        // hint row, and its list preloads in the background so Tab completion is
        // instant.
        const completion = completionTarget(query, providers)
        if (completion !== undefined) {
          warmCategory(session.sessionId, completion.key)
        }
        // One shortcut LETTER is a statement of intent, not a query: the user
        // asked for a category, so the menu answers with the categories and the
        // hint alone — no mixed matches to scroll past, nothing to read above
        // the row the highlight already sits on. Filtering starts on anything
        // else: a first letter that is not a shortcut, or a second character
        // (which covers the `fi`/`fo`/`sk`/`ch`/`pl` prefix spellings too, since
        // those are two characters by definition).
        if (completion !== undefined && query.trim().length === 1) {
          return [...categoryRows(t, providers), hintRow(completion, t)]
        }
        // Mixed search over the category pages. Settled pages answer instantly
        // (fetchPerSession returns the cached page synchronously); a cold page
        // awaits its first fetch ONCE so the first letter still lands matches —
        // the pending ad covers that wait, and the caller's signal cancels each
        // waiting supersede.
        const [files, skills, chatPage, plugins] = await Promise.all([
          fetchIndex(session.sessionId, signal).catch(() => [] as readonly FileEntry[]),
          fetchSkills(session.sessionId, signal).catch(() => [] as readonly SkillCandidate[]),
          fetchChats(session.sessionId, '', signal).catch(() => [] as readonly ChatCandidate[]),
          fetchPlugins(signal).catch(() => [] as readonly PluginCandidate[]),
        ])
        if (signal.aborted) return []
        const chats = chatPage.filter(chat => matches(query, chat.label, chat.sessionId))
        // Section A: the user's most-picked references across every category,
        // filtered by the live query (usage keys are `${kind}:${value}`).
        const usage = usageRows(query, { files, skills, chats: chatPage, plugins }, MAX_CANDIDATES - CATEGORIES.length - providers.length, t)
        const usageKeys = new Set(usage.map(row => `${row.mentionKind}:${row.value}`))
        // Section B: every other match, grouped by category with a tag, sorted
        // alphabetically within skills/plugins (files keep relevance ranking).
        const relevantFiles = files.filter(file => !usageKeys.has(`file:${file.relative}`))
        // Out-of-workspace folders are NOT in the index, so a plain query used to
        // find only the workspace's own matches (reported: `@do` showed the workspace
        // `docs` but never a 区外 folder of the same name). They match here on the
        // same query, tagged like every other leaf row, and the settled scope answers
        // synchronously — a cold scope simply contributes nothing.
        const externalMatches = externalFolderRows(session.sessionId)
          .filter(row => matches(query, row.name))
        const relevance = [
          ...externalMatches.slice(0, 4),
          ...candidateRows(rankFilesWithFuzzy(relevantFiles, query, 8), 'both', true, t),
          ...skillRows(skills, query, 3, key => isCollapsed(session.sessionId, key), t, true, true),
          ...chatRows(chats, 2, now(), key => isCollapsed(session.sessionId, key), t, true),
          ...pluginRows(plugins, query, 2, key => isCollapsed(session.sessionId, key), t, true, true),
          ...await providerMatches(query, session.sessionId, signal),
        ].slice(0, MAX_CANDIDATES - CATEGORIES.length - providers.length - usage.length - (usage.length > 0 ? 1 : 0))
        const rows: MentionCandidate[] = []
        if (usage.length > 0) {
          rows.push(sectionHeaderRow(t?.('section.usage') ?? '最常用'), ...usage)
        }
        if (relevance.length > 0) {
          rows.push(sectionHeaderRow(t?.('section.relevance') ?? '全部匹配'), ...relevance)
        }
        // Bottom band: the matches first, then the five pinned categories, then
        // the hint LAST. The menu opens above the composer, so the last row is
        // the one nearest the caret — and for a completion query the highlight
        // already sits on the hint (see `defaultHighlightIndex`), which keeps the
        // eye on the bottom row instead of sending it to the top of the list.
        const tail = completion !== undefined
          ? [...categoryRows(t, providers), hintRow(completion, t)]
          : categoryRows(t, providers)
        return [...rows, ...tail]
      }
      const sub = query.slice(category.prefix.length)
      let rows: readonly MentionCandidate[]
      if (category.key === 'file' || category.key === 'folder') {
        const files = await fetchIndex(session.sessionId, signal)
        if (signal.aborted) return []
        if (category.key === 'folder') {
          // Folder rows are the out-of-workspace options first, then the indexed
          // directories; the Host scope is fetched here (and cached) so the rows are
          // present the moment it answers — for a FILTERED query too, because the
          // ledger grows as the user sends references and reading only a settled
          // cache is what hid a folder the Host already knew.
          if (sub.trim() !== '') {
            await fetchExternal(session.sessionId, signal).catch(() => undefined)
            if (signal.aborted) return []
          }
          rows = folderCategoryRows(session.sessionId, files, sub)
        } else {
          // The file view may be SCOPED by a folder reference earlier in the draft
          // (R-05): the scope is the draft's own fact, so it needs no external-scope
          // fetch — its rows come from that folder's own listing.
          const scope = await resolveFileScope(session.sessionId, sub, signal)
          if (signal.aborted) return []
          rows = fileCategoryRows(session.sessionId, files, sub, scope)
        }
      } else if (category.key === 'skill') {
        const skills = await fetchSkills(session.sessionId, signal)
        if (signal.aborted) return []
        rows = skillRows(skills, sub, MAX_CANDIDATES, key => isCollapsed(session.sessionId, key), t)
      } else if (category.key === 'chat') {
        const chats = await fetchChats(session.sessionId, sub, signal)
        if (signal.aborted) return []
        rows = chatRows(chats, MAX_CANDIDATES, now(), key => isCollapsed(session.sessionId, key), t)
      } else if (category.providerId !== undefined) {
        // A registered provider's own category: its `list` answers, and nothing
        // is cached on our side.
        rows = await providerRows(category.providerId, sub, session.sessionId, signal)
      } else {
        const plugins = await fetchPlugins(signal)
        if (signal.aborted) return []
        rows = pluginRows(plugins, sub, MAX_CANDIDATES, key => isCollapsed(session.sessionId, key), t)
      }
      return [backRow(t), ...rows]
    },
    warm(session) {
      // Fire-and-forget scope-birth prewarm; the shared fetches report
      // through candidates. Chats are cached for TTL, so the @chat: list
      // opens without a first-time round-trip.
      void fetchIndex(session.sessionId).catch(() => {})
      void fetchSkills(session.sessionId).catch(() => {})
      void fetchChats(session.sessionId, '', new AbortController().signal).catch(() => {})
      void fetchPlugins().catch(() => {})
    },
    onPick({ candidate, session, action, span }) {
      // The framework types only the fields every source shares; our own row
      // fields (the provider handle) ride along on the same object.
      const providerId = (candidate as { providerId?: string }).providerId
      if (candidate.mentionKind === 'category') {
        return { text: `@${candidate.value}` }
      }
      if (candidate.mentionKind === 'back') {
        return { text: '@' }
      }
      // The browser's own rows. `continue: true` is the framework's "keep the menu
      // open" (the same flag a drill uses), which is what lets the pick become the
      // next step of a walk instead of a closed menu.
      if (candidate.mentionKind === 'folder-choose') {
        // The product's own chooser first (the same dialog "add workspace" uses):
        // it is async, so it inserts by itself and this pick only triggers it. A
        // build without one falls back to walking inside the menu.
        if (deps.chooseFolder?.(session.sessionId, span) === true) return undefined
        return { text: `@${workspaceRootOf(session.sessionId)}/`, continue: true }
      }
      if (candidate.mentionKind === 'browse-up' || candidate.mentionKind === 'browse-drive') {
        return { text: `@${candidate.value ?? ''}`, continue: true }
      }
      if (candidate.mentionKind === 'browse-dir') {
        // Picking a folder row IS the reference; the chevron/Tab (a drill) walks
        // into it instead, which is the framework's own descent gesture.
        return action === 'drill'
          ? { text: `@${candidate.value ?? ''}/`, continue: true }
          : { text: `@${candidate.value ?? ''}/ ` }
      }
      if (candidate.mentionKind === 'browse-file') {
        return { text: `@${candidate.value ?? ''} ` }
      }
      if (candidate.mentionKind === 'dir-group' || candidate.mentionKind === 'browse-note') {
        // A group header folds and a note says something: neither inserts text.
        return undefined
      }
      if (candidate.mentionKind === 'chat-group' || candidate.mentionKind === 'skill-group') {
        return undefined
      }
      if (candidate.mentionKind === 'file' || candidate.mentionKind === 'dir') {
        // An out-of-workspace row carries an ABSOLUTE path (that is what the Host
        // resolves and what the injected `<external-reference>` records), so it is
        // never in the workspace index: drafting it is the whole pick, exactly as
        // the Host verdict will read it back. Without this arm those rows were
        // offered and then did nothing at all on a click.
        const value = candidate.value
        if (value !== undefined && isAbsoluteReference(value)) {
          // A folder row already spells its trailing separator (`…/DSH/`), so the
          // token is built from the path WITHOUT it and gets exactly one — never
          // `…/DSH//`, which is a different path to every reader.
          const path = value.replace(/[/\\]+$/u, '')
          const suffix = candidate.mentionKind === 'dir' ? '/' : ''
          deps.onUsage?.(session.sessionId, candidate.mentionKind === 'dir' ? 'dir' : 'file', `${path}${suffix}`)
          return { text: `@${path}${suffix} ` }
        }
        const entry = candidate.value === undefined ? undefined : findEntry(session.sessionId, candidate.value)
        // Recently referenced rows may appear before the index settles; fall
        // back to the relative path directly (the Host validates existence).
        const file = entry
          ?? (candidate.recent === true && candidate.value !== undefined
            ? { relative: candidate.value, kind: 'file' as const }
            : undefined)
        if (file === undefined) return undefined
        if (file.kind === 'file' && entry !== undefined) deps.onRecent?.(session.sessionId, file.relative)
        deps.onUsage?.(session.sessionId, file.kind === 'dir' ? 'dir' : 'file', file.relative)
        // Plain-text reference: the draft gains the readable @path token. A
        // trailing slash marks a directory mention without reading descendants.
        const suffix = file.kind === 'dir' ? '/' : ''
        return { text: `@${file.relative}${suffix} ` }
      }
      if (candidate.mentionKind === 'skill') {
        if (candidate.value !== undefined) deps.onUsage?.(session.sessionId, 'skill', candidate.value)
        return { text: `@skill:${candidate.value} ` }
      }
      if (candidate.mentionKind === 'chat') {
        if (candidate.chatUri === undefined) return undefined
        if (candidate.value !== undefined) deps.onUsage?.(session.sessionId, 'chat', candidate.value)
        return { text: `@[${candidate.name}](${candidate.chatUri}) ` }
      }
      if (candidate.mentionKind === 'plugin') {
        if (candidate.value !== undefined) deps.onUsage?.(session.sessionId, 'plugin', candidate.value)
        return { text: `@plugin:${candidate.value} ` }
      }
      if (candidate.mentionKind === 'provider' && providerId !== undefined) {
        if (candidate.value === undefined) return undefined
        // `@atlas:<provider>/<item>` stays a plain-text reference: the Host half
        // resolves it, so no provider content ever enters the draft.
        deps.onUsage?.(session.sessionId, 'atlas', `${providerId}/${candidate.value}`)
        return { text: `@atlas:${providerId}/${candidate.value} ` }
      }
      return undefined
    },
    lexicon(session) {
      return fetches.get(session.sessionId)?.settled?.map(file => file.relative)
    },
    openReference(session, reference) {
      // The client asks the owning source to open a reference token it activated
      // in the composer (a click on a decorated draft token). We answer with the
      // same action a sent-message click runs, so both surfaces agree; a token
      // that is not ours (a `/skill` slash mention) or has nothing to open
      // leaves the gesture to the next source.
      const link = decodeDraftReference(reference.ref)
      if (link === undefined) return false
      const action = deps.actionFor?.(session.sessionId, link)
      if (action === undefined) return false
      action()
      return true
    },
    subscribeLexicon(session, listener) {
      const key = session.sessionId
      const listeners = lexiconListeners.get(key) ?? new Set()
      listeners.add(listener)
      lexiconListeners.set(key, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) lexiconListeners.delete(key)
      }
    },
  }

  return { source, invalidateAll, invalidateExternal, toggleGroup, isCollapsed, rebuildRows }
}