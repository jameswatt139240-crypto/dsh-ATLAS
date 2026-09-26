/**
 * The '@' trigger source over stubbed deps: category menu, mixed results,
 * category modes (file/folder/skill/chat/plugin), plain-text picks, lexicon
 * rolls, caches, and invalidation.
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientSessionContext, MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  browseTarget,
  FILE_ROW_BUDGET,
  FOLDER_ROW_BUDGET,
  createMentionSource,
  INDEX_TTL_MS,
  MAX_CANDIDATES,
  SOURCE_NAME,
  CATEGORIES,
  categoryOfQuery,
  categoryRows,
  categoryTag,
  backRow,
  completionTarget,
  hintRow,
  relativeTime,
  relativeTimeLabel,
  workspaceTitle,
  cleanChatLabel,
  editDistance,
  matchesFuzzy,
  providerCategories,
  rankFilesWithFuzzy,
} from '../src/client/source.ts'
import type { ChatCandidate, FileEntry, PluginCandidate, SkillCandidate } from '../src/client/remote.ts'
import { defaultHighlightIndex, firstLeafIndex } from '../src/client/MentionNavigator.tsx'
import { fileIconKind, menuGlyph, menuIconKind } from '../src/client/icons.tsx'
import { workspaceFromAbsolute, referenceKey } from '../src/client/model.ts'
import { en, fmt, zh } from '../src/client/locales.ts'
import { protectPastedMentions } from '../src/paste.ts'

const sid = (value: string): SessionId => value as SessionId
const session = (id: string): ClientSessionContext => ({ sessionId: sid(id) })

/** Warm every category page and let the stubs settle (real typing rhythm). */
async function prime(h: ReturnType<typeof harness>, id = 's1'): Promise<ReturnType<typeof harness>['source']> {
  await h.source.candidates(session(id), { query: '', position: 'leading', signal: new AbortController().signal })
  await Promise.resolve()
  await Promise.resolve()
  return h.source
}

const FILES: readonly FileEntry[] = [
  { path: '/ws/README.md', relative: 'README.md', kind: 'file' },
  { path: '/ws/src', relative: 'src', kind: 'dir' },
  { path: '/ws/src/index.ts', relative: 'src/index.ts', kind: 'file' },
  { path: '/ws/src/client/view.ts', relative: 'src/client/view.ts', kind: 'file' },
]

const SKILLS: readonly SkillCandidate[] = [
  { name: 'blender-modeling', description: 'Model in Blender', tier: 'custom' },
  { name: 'dsh-plugin-guide', description: 'DSH plugin development', tier: 'plugin' },
]

const CHATS: readonly ChatCandidate[] = [
  { sessionId: 'sess-a', label: 'Payment rates', uri: 'dsh-session:YQ', cwd: '/ws', createdAt: 1 },
  { sessionId: 'sess-b', label: 'Refactor plan', uri: 'dsh-session:Yg', createdAt: 2 },
]

const PLUGINS: readonly PluginCandidate[] = [
  { entryId: 'dsh-atlas', moduleName: 'dsh-atlas', enabled: true },
  { entryId: 'dsh-off', moduleName: 'dsh-off', enabled: false },
]

function harness(overrides: Partial<Parameters<typeof createMentionSource>[0]> = {}) {
  const search = vi.fn(async (_id: SessionId) => FILES)
  const listSkills = vi.fn(async (_id: SessionId) => SKILLS)
  const listChats = vi.fn(async (_id: SessionId, query: string) => CHATS.filter(chat => query === '' || chat.label.toLowerCase().includes(query.toLowerCase())))
  const listPlugins = vi.fn(async () => PLUGINS)
  let clock = 0
  const wrapper = createMentionSource({
    search,
    listSkills,
    listChats,
    listPlugins,
    now: () => clock,
    ...overrides,
  })
  return {
    source: wrapper.source,
    invalidateAll: wrapper.invalidateAll,
    invalidateExternal: wrapper.invalidateExternal,
    toggleGroup: wrapper.toggleGroup,
    isCollapsed: wrapper.isCollapsed,
    rebuildRows: wrapper.rebuildRows,
    search,
    listSkills,
    listChats,
    listPlugins,
    tick: (ms: number) => { clock += ms },
  }
}

describe('category menu', () => {
  it('shows only the category rows for an empty query', async () => {
    const { source, search } = harness()
    const rows = await source.candidates(session('s1'), { query: '', position: 'leading', signal: new AbortController().signal })
    expect(rows.map(row => row.name)).toEqual(categoryRows().map(row => row.name))
    expect(rows.every(row => row.mentionKind === 'category')).toBe(true)
    // The menu itself shows categories only; the category pages warm in the
    // background so the first selection is instant.
    await Promise.resolve()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('does not search for a token that came from pasted text', async () => {
    const { source, search } = harness()
    const rows = await source.candidates(session('s1'), {
      query: protectPastedMentions('@README.md').slice(1),
      position: 'inline',
      signal: new AbortController().signal,
    })
    expect(rows).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it('enters a category by picking its prefix row', async () => {
    const { source } = harness()
    const outcome = source.onPick({
      candidate: { name: '🧠 Skill', value: 'skill:', mentionKind: 'category' },
      session: session('s1'),
      position: 'leading',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(outcome).toEqual({ text: '@skill:' })
  })

  it('returns to the root from a back row', () => {
    const { source } = harness()
    expect(source.onPick({
      candidate: backRow(),
      session: session('s1'),
      position: 'leading',
      via: 'menu',
      span: { start: 0, end: 4, draftRev: 1 },
    })).toEqual({ text: '@' })
  })

  it('resolves the active category from the query prefix', () => {
    expect(categoryOfQuery('chat:rates')?.key).toBe('chat')
    expect(categoryOfQuery('plugin:dsh')?.key).toBe('plugin')
    expect(categoryOfQuery('plain query')).toBeUndefined()
  })

  it('exports the pinned category and back rows', () => {
    expect(categoryRows()).toHaveLength(CATEGORIES.length)
    expect(backRow().mentionKind).toBe('back')
  })

  it('labels every category row with its shortcut letter', () => {
    const rows = categoryRows()
    expect(rows.map(row => row.description)).toEqual(['F', 'D', 'S', 'C', 'P'])
  })

  it('resolves exactly one completion target from a shortcut or English prefix', () => {
    expect(completionTarget('p')?.key).toBe('plugin')
    expect(completionTarget('P')?.key).toBe('plugin')
    expect(completionTarget('d')?.key).toBe('folder')
    expect(completionTarget('sk')?.key).toBe('skill')
    expect(completionTarget('chat')?.key).toBe('chat')
    expect(completionTarget('f')?.key).toBe('file')
    expect(completionTarget('')).toBeUndefined()
    expect(completionTarget('xyz')).toBeUndefined()
  })

  it('builds a gray hint row that enters the category on Tab', () => {
    const row = hintRow(CATEGORIES[4]!)
    expect(row).toMatchObject({ name: '插件', value: 'plugin:', mentionKind: 'category' })
    expect(row.description).toContain('plugin:')
  })

  it('answers a single shortcut letter with the categories, and the hint below them', async () => {
    const { source, search, listPlugins } = harness()
    const rows = await source.candidates(session('s1'), { query: 'p', position: 'leading', signal: new AbortController().signal })
    // A shortcut letter is a statement of intent, not a query: no matches to
    // scroll past, and the hint sits LAST — closest to the composer, where the
    // highlight already is.
    expect(rows.map(row => row.name).slice(0, CATEGORIES.length)).toEqual(categoryRows().map(row => row.name))
    expect(rows.at(-1)!.description).toContain('Tab 补全 → plugin:')
    expect(rows.at(-1)!.mentionKind).toBe('category')
    // The hint returns instantly; every category page preloads in the
    // background (files + plugins here).
    await Promise.resolve()
    expect(search).toHaveBeenCalledTimes(1)
    expect(listPlugins).toHaveBeenCalledTimes(1)
  })

  it('keeps plain mixed search when the query is not a category prefix', async () => {
    const h = harness()
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'view', position: 'inline', signal: new AbortController().signal })
    // The categories are the bottom band now, so they are the LAST rows.
    const tail = rows.slice(-CATEGORIES.length)
    expect(tail.map(row => row.name)).toEqual(categoryRows().map(row => row.name))
    expect(tail[0]!.description).toBe('F')
    expect(rows.some(row => row.description?.includes('Tab 补全'))).toBe(false)
    expect(rows.some(row => row.name === 'view.ts')).toBe(true)
  })
})

describe('mixed candidates', () => {
  it('prioritizes files, then skills, chats, and plugins, with categories pinned', async () => {
    const h = harness()
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'view', position: 'inline', signal: new AbortController().signal })
    const names = rows.map(row => row.name)
    expect(names.slice(-CATEGORIES.length)).toEqual(categoryRows().map(row => row.name))
    expect(names).toContain('view.ts')
    const skillRows = await source.candidates(session('s1'), { query: 'blender', position: 'inline', signal: new AbortController().signal })
    expect(skillRows.some(row => row.mentionKind === 'skill' && row.name === 'blender-modeling')).toBe(true)
    const chatRows2 = await source.candidates(session('s1'), { query: 'Payment', position: 'inline', signal: new AbortController().signal })
    expect(chatRows2.some(row => row.mentionKind === 'chat' && row.name === 'Payment rates')).toBe(true)
  })

  it('fetches the session index once and filters per keystroke locally', async () => {
    const h = harness()
    const source = await prime(h)
    const first = await source.candidates(session('s1'), { query: 'view', position: 'inline', signal: new AbortController().signal })
    expect(first.map(item => item.name)).toContain('view.ts')
    const second = await source.candidates(session('s1'), { query: 'README', position: 'inline', signal: new AbortController().signal })
    expect(second.map(item => item.name)).toContain('README.md')
    expect(h.search).toHaveBeenCalledTimes(1)
  })

  it('shows the basename first while retaining the full relative path as its value', async () => {
    const h = harness()
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'view', position: 'inline', signal: new AbortController().signal })
    const row = rows.find(entry => entry.mentionKind === 'file')
    expect(row).toMatchObject({ name: 'view.ts', value: 'src/client/view.ts', atFileKind: 'file', description: '文件 · src/client' })
    expect(fileIconKind(FILES[3]!)).toBe('code')
  })
})

describe('category modes', () => {
  it('lists only files under the file: prefix', async () => {
    const { source } = harness()
    const rows = await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(rows[0]!.mentionKind).toBe('back')
    expect(rows.slice(1).every(row => row.mentionKind === 'file')).toBe(true)
    expect(rows.slice(1).map(row => row.name).sort())
      .toEqual(['README.md', 'index.ts', 'view.ts'])
  })

  it('scopes the file view by the folder reference typed before it (R-05)', async () => {
    // The reported gap: `@e:/outsidedir/ @file:` listed only workspace files, so the
    // folder the user had just named was missing from the menu they were reading.
    const scopeFolder = vi.fn(async () => 'e:/outsidedir')
    const list = vi.fn(async () => ({
      path: 'e:/outsidedir',
      entries: [
        { name: 'outsidedir-notes.md', kind: 'file' as const },
        { name: 'sub', kind: 'dir' as const },
        { name: 'outsidedir-other.md', kind: 'file' as const },
      ],
    }))
    const { source } = harness({ scopeFolder, list })
    const rows = await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(scopeFolder).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith('s1', 'e:/outsidedir', expect.anything())
    // The scope leads the unfiltered view: it is the folder the draft points at.
    expect(rows[0]!.mentionKind).toBe('back')
    expect(rows[1]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 工作区外 · outsidedir 中的文件' })
    expect(rows[2]).toMatchObject({
      name: 'outsidedir-notes.md',
      value: 'e:/outsidedir/outsidedir-notes.md',
      mentionKind: 'file',
      description: '工作区外 · e:/outsidedir',
    })
    // A directory inside the scope is not a file row, and the workspace's own
    // files follow the scope instead of hiding it.
    expect(rows.some(row => row.name === 'sub/')).toBe(false)
    expect(rows.slice(3).map(row => row.name)).toContain('README.md')
  })

  it('ranks the workspace first, then the scope, then path-only matches', async () => {
    const files: readonly FileEntry[] = [
      { path: '/ws/src/client/view.ts', relative: 'src/client/view.ts', kind: 'file' },
      { path: '/ws/src/viewer/notes.md', relative: 'src/viewer/notes.md', kind: 'file' },
      { path: '/ws/README.md', relative: 'README.md', kind: 'file' },
    ]
    const { source, toggleGroup, rebuildRows } = harness({
      search: vi.fn(async () => files),
      scopeFolder: vi.fn(async () => 'e:/outsidedir'),
      list: vi.fn(async () => ({
        path: 'e:/outsidedir',
        entries: [
          { name: 'view-scope.md', kind: 'file' as const },
          { name: 'unrelated.md', kind: 'file' as const },
        ],
      })),
    })
    const rows = await source.candidates(session('s1'), { query: 'file:view', position: 'leading', signal: new AbortController().signal })
    expect(rows.map(row => row.name)).toEqual([
      '返回类别',
      'view.ts',
      '▾ 工作区外 · outsidedir 中的文件',
      'view-scope.md',
      '▾ 路径匹配',
      'notes.md',
    ])
    expect(rows.length).toBeLessThanOrEqual(FILE_ROW_BUDGET)
    // The scope's rows are the folder's own files: one level, name-filtered.
    expect(rows.some(row => row.name === 'unrelated.md')).toBe(false)
    // Folding the scope by hand leaves the tier order intact, and the synchronous
    // rebuild the fold gesture uses can redraw it from the settled listing.
    toggleGroup(sid('s1'), 'file:scope:e:/outsidedir')
    const rebuilt = rebuildRows(sid('s1'), 'file:view')
    expect(rebuilt?.map(row => row.name)).toEqual([
      '返回类别', 'view.ts', '▸ 工作区外 · outsidedir 中的文件', '▾ 路径匹配', 'notes.md',
    ])
  })

  it('scopes nothing when the draft folder is inside the workspace, refused, or absent', async () => {
    const list = vi.fn(async () => ({ path: 'e:/outsidedir', entries: [{ name: 'x.md', kind: 'file' as const }] }))
    // Inside the workspace: the index already holds those files, so no listing is
    // spent on them and the view is the plain one.
    const inside = harness({ search: vi.fn(async () => FILES), scopeFolder: vi.fn(async () => '/ws/src'), list })
    const insideRows = await inside.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(list).not.toHaveBeenCalled()
    expect(insideRows.some(row => row.mentionKind === 'dir-group')).toBe(false)
    // Relative spellings are workspace paths too.
    const relative = harness({ scopeFolder: vi.fn(async () => 'src'), list })
    const relativeRows = await relative.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(relativeRows.some(row => row.mentionKind === 'dir-group')).toBe(false)
    // A folder the Host refuses (`outside`) contributes no rows at all.
    const refused = harness({ scopeFolder: vi.fn(async () => 'e:/Elsewhere'), list: vi.fn(async () => ({ path: 'e:/Elsewhere', entries: [], error: 'outside' as const })) })
    const refusedRows = await refused.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(refusedRows.some(row => row.mentionKind === 'dir-group')).toBe(false)
    // A failing or pointless lookup is not an error the user has to read.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = harness({ scopeFolder: vi.fn(async () => { throw new Error('boom') }), list })
    const failingRows = await failing.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(failingRows.some(row => row.mentionKind === 'dir-group')).toBe(false)
    const throwingList = harness({ scopeFolder: vi.fn(async () => 'e:/outsidedir'), list: vi.fn(async () => { throw new Error('nope') }) })
    const throwingRows = await throwingList.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(throwingRows.some(row => row.mentionKind === 'dir-group')).toBe(false)
    // An empty answer names no folder, and neither does a build without the pieces.
    const empty = harness({ scopeFolder: vi.fn(async () => '   '), list })
    await expect(empty.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal }))
      .resolves.toBeDefined()
    const noScopeDep = harness({ list })
    await expect(noScopeDep.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal }))
      .resolves.toBeDefined()
    const noListDep = harness({ scopeFolder: vi.fn(async () => 'e:/outsidedir') })
    const noListRows = await noListDep.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(noListRows.some(row => row.mentionKind === 'dir-group')).toBe(false)
    // A cancelled lookup is the menu working, not a failure to report.
    warn.mockClear()
    const aborted = new AbortController()
    aborted.abort()
    const cancelled = harness({ scopeFolder: vi.fn(async () => { throw new Error('aborted') }), list })
    await cancelled.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: aborted.signal })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('caches the scoped folder listing and refreshes it stale-while-revalidate', async () => {
    type Listing = { path: string; entries: readonly { name: string; kind: 'file' }[] }
    const resolvers: Array<(listing: Listing) => void> = []
    const listing = (name: string): Listing => ({ path: 'e:/outsidedir', entries: [{ name, kind: 'file' }] })
    const list = vi.fn((_id: SessionId, _path: string) => new Promise<Listing>((resolve) => { resolvers.push(resolve) }))
    const h = harness({ scopeFolder: vi.fn(async () => 'e:/outsidedir'), list })
    const call = () => h.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    const settle = async (): Promise<void> => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve() }
    const flush = async (name: string): Promise<void> => { resolvers.shift()?.(listing(name)); await settle() }
    // A listing still in flight is SHARED, not fetched twice: the menu re-asks on
    // every keystroke and each one must not become another directory read.
    const first = call()
    const second = call()
    await settle()
    expect(list).toHaveBeenCalledTimes(1)
    await flush('a.md')
    await expect(first).resolves.toBeDefined()
    await expect(second).resolves.toBeDefined()
    // Settled and fresh: the next open answers from the cache.
    await call()
    expect(list).toHaveBeenCalledTimes(1)
    // Settled but stale: the old rows answer AT ONCE and a refresh runs behind them.
    h.tick(INDEX_TTL_MS + 1)
    const refreshed = await call()
    expect(refreshed.some(row => row.name === 'a.md')).toBe(true)
    await settle()
    expect(list).toHaveBeenCalledTimes(2)
    await flush('b.md')
    // A stale read that never settled is aborted before it is replaced.
    h.tick(INDEX_TTL_MS + 1)
    await call()
    await settle()
    expect(list).toHaveBeenCalledTimes(3)
    h.tick(INDEX_TTL_MS + 1)
    const replaced = call()
    await settle()
    expect(list).toHaveBeenCalledTimes(4)
    await flush('ignored.md')
    await flush('c.md')
    await expect(replaced).resolves.toBeDefined()
  })

  it('keeps the plain file view when a scope has no matching file', async () => {
    const files: readonly FileEntry[] = [
      { path: '/ws/view.ts', relative: 'view.ts', kind: 'file' },
      { path: '/ws/src/view/notes.md', relative: 'src/view/notes.md', kind: 'file' },
    ]
    const h = harness({
      search: vi.fn(async () => files),
      scopeFolder: vi.fn(async () => 'e:/outsidedir'),
      list: vi.fn(async () => ({ path: 'e:/outsidedir', entries: [{ name: 'other.md', kind: 'file' as const }] })),
    })
    // No FOLDER is named before the token yet, so a rebuild has nothing to redraw.
    expect(h.rebuildRows(sid('s1'), 'file:view')).toBeUndefined()
    const rows = await h.source.candidates(session('s1'), { query: 'file:view', position: 'leading', signal: new AbortController().signal })
    // The scope contributes no matching file, so there is no group for it — but the
    // workspace and path tiers are still there.
    expect(rows.map(row => row.name)).toEqual(['返回类别', 'view.ts', '▾ 路径匹配', 'notes.md'])
    // A rebuild after an ERRORED listing cannot redraw the scope either: the caller
    // refetches rather than silently dropping the tier it was showing.
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errored = harness({
      scopeFolder: vi.fn(async () => 'e:/outsidedir'),
      list: vi.fn(async () => { throw new Error('nope') }),
    })
    await errored.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(errored.rebuildRows(sid('s1'), 'file:')).toBeUndefined()
    quiet.mockRestore()
  })

  it('scopes a folder the workspace cannot hold (no index yet)', async () => {
    // An empty (or not-yet-settled) index has no workspace root to compare against,
    // so an absolute scope must still be treated as outside and listed.
    const list = vi.fn(async () => ({ path: 'e:/outsidedir', entries: [{ name: 'a.md', kind: 'file' as const }] }))
    const h = harness({ search: vi.fn(async () => []), scopeFolder: vi.fn(async () => 'e:/outsidedir'), list })
    const rows = await h.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(list).toHaveBeenCalledTimes(1)
    expect(rows[1]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 工作区外 · outsidedir 中的文件' })
  })

  it('drops the scope rows when the workspace name matches spend the budget', async () => {
    // Enough name matches to fill the whole ceiling, so the scope's own tier has no
    // room left: 区内 always keeps the top rows.
    const named = Array.from({ length: 30 }, (_, index) => ({
      path: `/ws/sub-${String(index)}.md`,
      relative: `sub-${String(index)}.md`,
      kind: 'file' as const,
    }))
    const { source } = harness({
      search: vi.fn(async () => named),
      scopeFolder: vi.fn(async () => 'e:/outsidedir'),
      list: vi.fn(async () => ({
        path: 'e:/outsidedir',
        entries: [{ name: 'sub-scope.md', kind: 'file' as const }],
      })),
    })
    const rows = await source.candidates(session('s1'), { query: 'file:sub', position: 'leading', signal: new AbortController().signal })
    expect(rows.length).toBeLessThanOrEqual(FILE_ROW_BUDGET)
    expect(rows.some(row => row.name === 'sub-scope.md')).toBe(false)
    expect(rows[1]!.name).toBe('sub-0.md')
  })

  it('lists only directories under the folder: prefix', async () => {    const { source } = harness()
    const rows = await source.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    // The picker row and the two group headers lead; every row that names a path
    // is a DIRECTORY (the file category is where files live).
    expect(rows.map(row => row.mentionKind)).toEqual(['back', 'folder-choose', 'dir-group', 'dir'])
    expect(rows.filter(row => row.value !== '' && row.mentionKind === 'dir').map(row => row.name)).toEqual(['src'])
  })

  it('offers the out-of-workspace folders the Host allows, under their own group', async () => {
    const external = vi.fn(async () => ({
      canDiscover: true,
      roots: [],
      folders: ['E:/outsidedir/Rust/DSH/deepseek-harness', 'E:/outsidedir/Rust/DSH/dsh-arcade'],
    }))
    const { source } = harness({ external })
    const rows = await source.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    // The order is the point (reported with a screenshot): back, the way OUT of the
    // workspace, the external group FOLDED, then the workspace's own folders — so a
    // dozen external checkouts can never push the workspace rows past the fold.
    expect(rows[0]!.mentionKind).toBe('back')
    expect(rows[1]).toMatchObject({ mentionKind: 'folder-choose', name: '选择文件夹…' })
    expect(rows[2]).toMatchObject({ mentionKind: 'dir-group', name: '▸ 工作区外文件夹' })
    expect(rows[3]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 工作区文件夹' })
    expect(rows[4]).toMatchObject({ name: 'src', value: 'src' })
    expect(external).toHaveBeenCalled()

    // Folding is per group and per session: unfolding the external group reveals
    // absolutely-spelled rows that say they are outside the workspace, and it never
    // disturbs the workspace group.
    const { source: folding, toggleGroup } = harness({ external })
    await folding.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    toggleGroup(session('s1').sessionId, 'folder:outside')
    const unfolded = await folding.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    expect(unfolded[2]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 工作区外文件夹' })
    expect(unfolded.slice(3, 5).map(row => row.name)).toEqual(['deepseek-harness/', 'dsh-arcade/'])
    expect(unfolded[3]).toMatchObject({
      mentionKind: 'dir',
      value: 'E:/outsidedir/Rust/DSH/deepseek-harness/',
      atFileKind: 'dir',
      description: '工作区外 · E:/outsidedir/Rust/DSH',
    })
    expect(unfolded.map(row => row.name)).toContain('src')

    // Filtering hits BOTH groups and unfolds them: that is what "filter 区内 and
    // 区外 together" asks for.
    const filtered = await folding.candidates(session('s1'), { query: 'folder:dsh-', position: 'leading', signal: new AbortController().signal })
    expect(filtered.map(row => row.mentionKind)).toEqual(['back', 'dir-group', 'dir'])
    expect(filtered[2]).toMatchObject({ name: 'dsh-arcade/' })

    // A Host that reports nothing external (narrow mode with an empty ledger)
    // adds no group at all, and one bad answer is not fatal.
    const none = harness({ external: vi.fn(async () => ({ canDiscover: false, roots: [], folders: [] })) })
    const noneRows = await none.source.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    expect(noneRows.map(row => row.name)).toEqual(['返回类别', '选择文件夹…', '▾ 工作区文件夹', 'src'])

    const failing = harness({ external: vi.fn(async () => { throw new Error('host down') }) })
    const failingRows = await failing.source.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    expect(failingRows.map(row => row.name)).toEqual(['返回类别', '选择文件夹…', '▾ 工作区文件夹', 'src'])

    // The file category never borrows them: they are folders, not files.
    const files = harness({ external })
    const fileRows = await files.source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(fileRows.every(row => row.mentionKind !== 'dir')).toBe(true)
  })

  it('starts the folder browser at the workspace root and walks the filesystem', async () => {
    const listing = vi.fn(async (_id: SessionId, path: string) => (path === 'E:/ws'
      ? { path: 'E:/ws', parent: 'E:/', entries: [{ name: 'src', kind: 'dir' as const }] }
      : { path: 'E:/', entries: [], drives: ['C:/', 'E:/'] }))
    const { source } = harness({
      search: vi.fn(async () => [
        { path: 'E:\\ws\\src\\view.ts', relative: 'src/view.ts', kind: 'file' },
        { path: 'E:\\ws\\src', relative: 'src', kind: 'dir' },
      ] as readonly FileEntry[]),
      list: listing,
    })
    // The picker row drafts the ABSOLUTE workspace root and keeps the menu open:
    // `continue` is the framework's own "stay open" flag (the drill flag).
    const denied = source.onPick({
      candidate: { name: '选择文件夹…', value: 'folder-choose', mentionKind: 'folder-choose' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })
    // No index settled yet: the root is unknown, so the walk starts at the top.
    expect(denied).toEqual({ text: '@/', continue: true })

    // A build WITH the product's own chooser: the row triggers it and inserts
    // nothing itself, because the chooser is async and takes the insertion over.
    const chosen: unknown[][] = []
    const withChooser = harness({
      chooseFolder: (id, span) => { chosen.push([id, span]); return true },
    })
    expect(withChooser.source.onPick({
      candidate: { name: '选择文件夹…', value: 'folder-choose', mentionKind: 'folder-choose' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 4, end: 12, draftRev: 7 },
    })).toBeUndefined()
    expect(chosen).toEqual([['s1', { start: 4, end: 12, draftRev: 7 }]])

    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(source.onPick({
      candidate: { name: '选择文件夹…', value: 'folder-choose', mentionKind: 'folder-choose' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: '@E:/ws/', continue: true })

    // A path in the draft browses it: the rows are the directory's own children,
    // with `..` first, and a drive root offers the other drives.
    const rows = await source.candidates(session('s1'), { query: 'E:/ws/', position: 'leading', signal: new AbortController().signal })
    expect(listing).toHaveBeenCalledWith(session('s1').sessionId, 'E:/ws', expect.anything())
    expect(rows.map(row => row.mentionKind)).toEqual(['browse-up', 'browse-dir'])
    expect(rows[0]).toMatchObject({ value: 'E:/' })
    expect(rows[1]).toMatchObject({ name: 'src/', value: 'E:/ws/src', drill: true })

    const drive = await source.candidates(session('s1'), { query: 'folder:E:/', position: 'leading', signal: new AbortController().signal })
    expect(drive.map(row => row.mentionKind)).toEqual(['browse-drive', 'browse-drive'])
    // A drive ROOT keeps its slash (`E:` alone is the drive-RELATIVE spelling and
    // would resolve against the current directory instead — observed live).
    expect(browseTarget('E:/')).toBe('E:/')
    expect(browseTarget('E:\\')).toBe('E:/')
    expect(browseTarget('folder:e:')).toBe('e:/')
    expect(browseTarget('folder:E:/ws/')).toBe('E:/ws')
    expect(browseTarget('/')).toBe('/')
    expect(browseTarget('src')).toBeUndefined()
    expect(browseTarget('folder:')).toBeUndefined()

    // Picks: `..` and a drive walk on (continue), a directory row is the reference
    // (and its drill walks in), a file row is a file reference.
    const pick = (mentionKind: string, value: string, action?: 'pick' | 'drill') => source.onPick({
      candidate: { name: value, value, mentionKind },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      action,
      span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(pick('browse-up', 'E:/')).toEqual({ text: '@E:/', continue: true })
    expect(pick('browse-drive', 'C:/')).toEqual({ text: '@C:/', continue: true })
    expect(pick('browse-dir', 'E:/ws/src')).toEqual({ text: '@E:/ws/src/ ' })
    expect(pick('browse-dir', 'E:/ws/src', 'drill')).toEqual({ text: '@E:/ws/src/', continue: true })
    expect(pick('browse-file', 'E:/ws/src/view.ts')).toEqual({ text: '@E:/ws/src/view.ts ' })
    // A refusal from the Host is a note the user reads, never an empty folder.
    const refused = harness({
      list: vi.fn(async (_id: SessionId, path: string) => ({ path, entries: [], error: 'outside' as const })),
      t: (key: string, params?: Record<string, string>) => fmt(zh[key] ?? key, params),
    })
    const refusedRows = await refused.source.candidates(session('s1'), { query: 'E:/elsewhere/', position: 'leading', signal: new AbortController().signal })
    expect(refusedRows).toHaveLength(1)
    expect(refusedRows[0]).toMatchObject({ mentionKind: 'browse-note', name: zh['folder.error.outside'] })
  })

  it('re-reads the out-of-workspace scope after a send, and refreshes a stale one', async () => {
    // The ledger grows when the user SENDS a reference, so a cached scope used to
    // hide a folder the Host already knew for a whole TTL (reported: `@folder:Ea`
    // did not offer the `e:/outsidedir` the user had just sent). A filtered query is the
    // reported shape, and it shows both groups unfolded.
    const answers = [
      { canDiscover: true, roots: [], folders: ['E:/ws/one'] },
      { canDiscover: true, roots: [], folders: ['E:/ws/one', 'e:/outsidedir'] },
    ]
    let call = 0
    const external = vi.fn(async () => answers[Math.min(call++, answers.length - 1)] as { canDiscover: boolean; roots: readonly string[]; folders: readonly string[] })
    const harnessed = harness({ external })
    const first = await harnessed.source.candidates(session('s1'), { query: 'folder:one', position: 'leading', signal: new AbortController().signal })
    expect(first.map(row => row.name)).toContain('one/')
    expect(first.map(row => row.name)).not.toContain('outsidedir/')
    // A send drops the scope: the next read asks the Host again and sees the ledger.
    harnessed.invalidateExternal(session('s1').sessionId)
    const after = await harnessed.source.candidates(session('s1'), { query: 'folder:outsidedir', position: 'leading', signal: new AbortController().signal })
    expect(after.map(row => row.name)).toContain('outsidedir/')
    expect(external).toHaveBeenCalledTimes(2)

    // Stale-while-revalidate: past the TTL the last scope answers at once and a
    // fresh one arrives in the background, so the NEXT keystroke already sees it.
    let staleCall = 0
    const staleAnswers = [
      { canDiscover: true, roots: [], folders: ['E:/ws/one'] },
      { canDiscover: true, roots: [], folders: ['E:/ws/one', 'E:/ws/two'] },
    ]
    const stale = harness({
      external: vi.fn(async () => staleAnswers[Math.min(staleCall++, 1)] as { canDiscover: boolean; roots: readonly string[]; folders: readonly string[] }),
    })
    await stale.source.candidates(session('s1'), { query: 'folder:one', position: 'leading', signal: new AbortController().signal })
    stale.tick(INDEX_TTL_MS + 1)
    // Past the TTL the scope refreshes as a side effect of asking (stale-while-
    // revalidate): the fresh value may land within the same keystroke or the next
    // one, and either way it arrives without an explicit invalidation.
    const immediate = await stale.source.candidates(session('s1'), { query: 'folder:two', position: 'leading', signal: new AbortController().signal })
    expect(immediate.map(row => row.name)).toContain('two/')
    await Promise.resolve()
    await Promise.resolve()
    const refreshed = await stale.source.candidates(session('s1'), { query: 'folder:two', position: 'leading', signal: new AbortController().signal })
    expect(refreshed.map(row => row.name)).toContain('two/')
    expect(staleCall).toBeGreaterThan(1)
  })

  it('ranks name matches above path-only matches, workspace first', async () => {
    // The user's口径: a one-letter query matches almost every path under an
    // `E:`-rooted workspace, and those path-only hits must not bury the folders
    // whose NAME matched. Name matches keep their groups (workspace, then outside);
    // path-only matches are folded into one group of their own.
    const external = vi.fn(async () => ({
      canDiscover: true,
      roots: [],
      folders: ['E:/ws/sub-outside', 'E:/ws/elsewhere'],
    }))
    const { source } = harness({
      search: vi.fn(async () => [
        { path: 'E:\\ws\\sub', relative: 'sub', kind: 'dir' },
        { path: 'E:\\ws\\sub\\deep', relative: 'sub/deep', kind: 'dir' },
        { path: 'E:\\ws\\other', relative: 'other', kind: 'dir' },
      ] as readonly FileEntry[]),
      external,
    })
    const rows = await source.candidates(session('s1'), { query: 'folder:sub', position: 'leading', signal: new AbortController().signal })
    expect(rows[0]!.mentionKind).toBe('back')
    // 1. NAME matches: workspace first, then outside the workspace.
    expect(rows[1]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 工作区文件夹' })
    expect(rows[2]).toMatchObject({ name: 'sub', value: 'sub' })
    expect(rows[3]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 工作区外文件夹' })
    expect(rows[4]).toMatchObject({ name: 'sub-outside/', value: 'E:/ws/sub-outside/' })
    // 2. PATH-only matches: ONE group of their own, spending the room the name
    // matches left it (the口径 is "如果多就折叠", and the BUDGET is that fold), while
    // folding it by hand stays the user's own gesture.
    expect(rows[5]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 路径匹配' })
    expect(rows[6]).toMatchObject({ name: 'deep', value: 'sub/deep' })
    expect(rows).toHaveLength(7)
    // An explicit fold wins over the fit: the group folds and keeps its header.
    const { source: folding, toggleGroup } = harness({
      search: vi.fn(async () => [
        { path: 'E:\\ws\\sub', relative: 'sub', kind: 'dir' },
        { path: 'E:\\ws\\sub\\deep', relative: 'sub/deep', kind: 'dir' },
      ] as readonly FileEntry[]),
      external: vi.fn(async () => ({ canDiscover: true, roots: [], folders: ['E:/ws/sub-out'] })),
    })
    await folding.candidates(session('s1'), { query: 'folder:sub', position: 'leading', signal: new AbortController().signal })
    toggleGroup(session('s1').sessionId, 'folder:path')
    const folded = await folding.candidates(session('s1'), { query: 'folder:sub', position: 'leading', signal: new AbortController().signal })
    expect(folded.map(row => row.name)).toEqual([
      '返回类别', '▾ 工作区文件夹', 'sub', '▾ 工作区外文件夹', 'sub-out/', '▸ 路径匹配',
    ])
  })

  it('never spends more than the row budget, and spends it on the name matches first', async () => {
    // The user's口径: keep the popup readable — at most ~10 rows — and let whatever
    // the budget DOES show be the name matches first. The path tier is not folded by
    // default: it spends the leftover room, so its flood shows as a few rows instead
    // of hiding behind a header.
    const many = Array.from({ length: 30 }, (_, index) => ({
      path: `E:\\ws\\sub\\deep-${String(index)}`,
      relative: `sub/deep-${String(index)}`,
      kind: 'dir' as const,
    }))
    const { source, toggleGroup } = harness({
      search: vi.fn(async () => [
        { path: 'E:\\ws\\sub', relative: 'sub', kind: 'dir' as const },
        { path: 'E:\\ws\\sub2', relative: 'sub2', kind: 'dir' as const },
        ...many,
      ] as readonly FileEntry[]),
      external: vi.fn(async () => ({ canDiscover: true, roots: [], folders: ['E:/ws/sub-out'] })),
    })
    const spent = await source.candidates(session('s1'), { query: 'folder:sub', position: 'leading', signal: new AbortController().signal })
    expect(spent.length).toBeLessThanOrEqual(FOLDER_ROW_BUDGET)
    // Name matches first (workspace, then outside); the path group takes what is left.
    expect(spent.slice(0, 6).map(row => row.name)).toEqual([
      '返回类别', '▾ 工作区文件夹', 'sub', 'sub2', '▾ 工作区外文件夹', 'sub-out/',
    ])
    expect(spent[6]).toMatchObject({ mentionKind: 'dir-group', name: '▾ 路径匹配' })
    expect(spent.slice(7).every(row => row.mentionKind === 'dir')).toBe(true)
    expect(spent.slice(7).length).toBe(FOLDER_ROW_BUDGET - 1 - 6)
    // Folding it by hand gives the same name matches and one header instead of rows.
    toggleGroup(session('s1').sessionId, 'folder:path')
    const folded = await source.candidates(session('s1'), { query: 'folder:sub', position: 'leading', signal: new AbortController().signal })
    expect(folded.map(row => row.name)).toEqual([
      '返回类别', '▾ 工作区文件夹', 'sub', 'sub2', '▾ 工作区外文件夹', 'sub-out/', '▸ 路径匹配',
    ])
    expect(folded.length).toBeLessThanOrEqual(FOLDER_ROW_BUDGET)
    // And unfolding that hand-folded group restores exactly the leftover rows.
    toggleGroup(session('s1').sessionId, 'folder:path')
    const reopened = await source.candidates(session('s1'), { query: 'folder:sub', position: 'leading', signal: new AbortController().signal })
    expect(reopened.map(row => row.name)).toEqual(spent.map(row => row.name))
  })

  it('drops the path group entirely when the name matches spend the whole budget', async () => {
    // A header that could not show a single row would be a dead gesture: once the
    // whole ceiling is gone, the path tier is left out rather than rendered as a
    // teaser. (The ceiling is MAX_CANDIDATES rows — the menu scrolls past what fits,
    // it does not drop rows to stay short.)
    const named = Array.from({ length: 19 }, (_, index) => ({
      path: `E:\\ws\\sub-${String(index)}`,
      relative: `sub-${String(index)}`,
      kind: 'dir' as const,
    }))
    const { source } = harness({
      search: vi.fn(async () => [
        ...named,
        { path: 'E:\\ws\\sub\\deep', relative: 'sub/deep', kind: 'dir' as const },
      ] as readonly FileEntry[]),
    })
    const rows = await source.candidates(session('s1'), { query: 'folder:sub', position: 'leading', signal: new AbortController().signal })
    expect(rows.length).toBeLessThanOrEqual(FOLDER_ROW_BUDGET)
    expect(rows.map(row => row.name)).toEqual([
      '返回类别', '▾ 工作区文件夹',
      ...Array.from({ length: FOLDER_ROW_BUDGET - 2 }, (_, index) => `sub-${String(index)}`),
    ])
    expect(rows.some(row => row.name.includes('路径匹配'))).toBe(false)
  })

  it('matches an out-of-workspace folder by a plain query too', async () => {
    // The reported gap: typing letters found the workspace's own folders only,
    // because the external rows are not in the index at all. They now compete on
    // the same query, tagged like every other leaf row.
    const external = vi.fn(async () => ({
      canDiscover: true,
      roots: [],
      folders: ['E:/outsidedir/Rust/DSH/outside-dir', 'E:/outsidedir/Rust/DSH/other'],
    }))
    const { source } = harness({ external })
    const primed = await source.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    expect(primed.some(row => row.mentionKind === 'folder-choose')).toBe(true)
    const rows = await source.candidates(session('s1'), { query: 'dir', position: 'leading', signal: new AbortController().signal })
    const outside = rows.find(row => row.value === 'E:/outsidedir/Rust/DSH/outside-dir/')
    expect(outside).toMatchObject({ mentionKind: 'dir', description: '工作区外 · E:/outsidedir/Rust/DSH' })
    expect(rows.some(row => row.value === 'E:/outsidedir/Rust/DSH/other/')).toBe(false)
  })

  it('lists skills under the skill: prefix grouped by tier and domain', async () => {
    const { source, listSkills } = harness()
    const rows = await source.candidates(session('s1'), { query: 'skill:blender', position: 'leading', signal: new AbortController().signal })
    expect(rows[0]!.mentionKind).toBe('back')
    expect(rows[1]).toMatchObject({ name: '▾ 自定义', mentionKind: 'skill-group' })
    expect(rows[2]).toMatchObject({ name: '▾ blender', mentionKind: 'skill-group' })
    expect(rows[2]!.groupKey).toBe('skill:custom:blender')
    expect(rows[3]).toMatchObject({ name: 'blender-modeling', mentionKind: 'skill' })
    // No framework glyph exists for a skill, so the row declares the neutral
    // `file` slot: the box is what indents the name, and this plugin draws the
    // skill glyph over it (see MenuIcons).
    expect(rows[3]!.icon).toBe('file')
    expect(listSkills).toHaveBeenCalled()
  })

  it('lists chats under the chat: prefix grouped by workspace with relative time', async () => {
    const { source } = harness()
    const rows = await source.candidates(session('s1'), { query: 'chat:rates', position: 'leading', signal: new AbortController().signal })
    expect(rows[0]!.mentionKind).toBe('back')
    expect(rows[1]).toMatchObject({ name: '▾ ws', mentionKind: 'chat-group' })
    // The header's groupKey must equal chatGroupKey(cwd) so the navigator
    // toggle collapses exactly this group (regression: it used to embed the
    // session id and silently miss the collapse filter).
    expect(rows[1]!.groupKey).toBe('chat:ws')
    expect(rows[2]).toMatchObject({
      name: 'Payment rates',
      value: 'sess-a',
      mentionKind: 'chat',
      chatUri: 'dsh-session:YQ',
    })
    // The row declares the framework slot (the box that indents the name); the
    // glyph inside it is drawn by this plugin, monochrome, over the top.
    expect(rows[2]!.icon).toBe('session')
    expect(rows[2]!.description).toMatch(/刚刚|分钟|小时|天/)
  })

  it('lists enabled plugins under the plugin: prefix grouped by scope', async () => {
    const { source, toggleGroup, rebuildRows } = harness()
    const rows = await source.candidates(session('s1'), { query: 'plugin:', position: 'leading', signal: new AbortController().signal })
    expect(rows[0]!.mentionKind).toBe('back')
    expect(rows[1]).toMatchObject({ name: '▾ 其他', mentionKind: 'plugin-group' })
    expect(rows[1]!.groupKey).toBe('plugin:其他')
    expect(rows[2]).toMatchObject({ name: 'dsh-atlas', mentionKind: 'plugin' })
    expect(rows[2]!.icon).toBe('file')
    toggleGroup(sid('s1'), 'plugin:其他')
    const closed = rebuildRows(sid('s1'), 'plugin:')
    expect(closed!.some(row => row.mentionKind === 'plugin')).toBe(false)
    expect(closed!.some(row => row.name === '▸ 其他')).toBe(true)
  })
})

describe('menu icon contract', () => {
  it('reserves a framework icon slot for every kind, and draws its own glyph in it', () => {
    // The slot is what lines the names up: the framework renders an icon box only
    // when the candidate declares a kind it knows, and it knows three.
    expect(menuIconKind('file')).toBe('file')
    expect(menuIconKind('folder')).toBe('folder')
    expect(menuIconKind('chat')).toBe('session')
    expect(menuIconKind('skill')).toBe('file')
    expect(menuIconKind('plugin')).toBe('file')
    expect(menuIconKind('back')).toBe('file')
    // The glyph comes from this plugin's own set — the dock's — monochrome, and a
    // provider that has a glyph of its own gets it.
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'provider', providerId: 'git' })))
      .toContain('tabler-icon-brand-git')
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'skill' }))).toContain('tabler-icon-bolt')
    // A file row gets the same language brand glyph the dock shows for it.
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'file', value: 'src/index.ts' })))
      .toContain('tabler-icon-brand-typescript')
    // A category row names itself by its prefix: the five built-ins each get
    // their own glyph, and a provider its declared one.
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'category', value: 'file:' }))).toContain('tabler-icon-file')
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'category', value: 'folder:' }))).toContain('tabler-icon-folder')
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'category', value: 'skill:' }))).toContain('tabler-icon-bolt')
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'category', value: 'chat:' }))).toContain('tabler-icon-message-circle')
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'category', value: 'plugin:' }))).toContain('tabler-icon-blocks')
    expect(renderToStaticMarkup(menuGlyph({ mentionKind: 'category', value: 'git:' }))).toContain('tabler-icon-brand-git')
  })

  it('declares a framework slot on every row it emits', async () => {
    // The framework draws a candidate's icon itself and knows exactly three kinds
    // (session/file/folder) — handing it an element leaves an EMPTY box behind,
    // which is how the glyphs disappeared once. So every row of ours declares one
    // of the three: that reserves the box, and MenuIcons draws this plugin's
    // glyph over it.
    const { source } = harness()
    // Structural rows (group headers, section dividers) carry no icon and need
    // none; every row that stands for something declares one of the three.
    const allowed = new Set(['file', 'folder', 'session', undefined])
    for (const query of ['', 'f', 'file:', 'folder:', 'skill:', 'chat:', 'plugin:']) {
      const rows = await source.candidates(session('s1'), {
        query,
        position: query === '' ? 'inline' : 'leading',
        signal: new AbortController().signal,
      })
      for (const row of rows) {
        expect(allowed.has(row.icon as string | undefined), `${query} → ${row.mentionKind} "${row.name}" carried ${String(row.icon)}`).toBe(true)
      }
    }
  })
})

describe('@ picks', () => {
  it('lands a plain @path for a file', async () => {
    const { source } = harness()
    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    const outcome = source.onPick({
      candidate: { name: 'view.ts', value: 'src/client/view.ts', mentionKind: 'file', atFileKind: 'file' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 4 },
    })
    expect(outcome).toEqual({ text: '@src/client/view.ts ' })
  })

  it('lands a trailing-slash @path for a directory', async () => {
    const { source } = harness()
    await source.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    const outcome = source.onPick({
      candidate: { name: 'src', value: 'src', mentionKind: 'dir', atFileKind: 'dir' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 4 },
    })
    expect(outcome).toEqual({ text: '@src/ ' })
  })

  it('lands an absolute @folder: path for an out-of-workspace row', async () => {
    // The external rows are offered for a path the workspace index can never
    // contain, so nothing may look them up there: a row that resolves to nothing
    // would close the menu on the click and draft no reference at all.
    const onUsage = vi.fn()
    const external = vi.fn(async () => ({ canDiscover: true, roots: [], folders: ['E:/outsidedir/Rust/DSH'] }))
    const { source } = harness({ external, onUsage })
    await source.candidates(session('s1'), { query: 'folder:', position: 'leading', signal: new AbortController().signal })
    const outcome = source.onPick({
      candidate: { name: 'DSH/', value: 'E:/outsidedir/Rust/DSH/', mentionKind: 'dir', atFileKind: 'dir' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 4 },
    })
    expect(outcome).toEqual({ text: '@E:/outsidedir/Rust/DSH/ ' })
    expect(onUsage).toHaveBeenCalledWith(session('s1').sessionId, 'dir', 'E:/outsidedir/Rust/DSH/')
    // However the row spells it, the token gets exactly ONE trailing separator.
    expect(source.onPick({
      candidate: { name: 'DSH', value: 'E:/outsidedir/Rust/DSH', mentionKind: 'dir', atFileKind: 'dir' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 4 },
    })).toEqual({ text: '@E:/outsidedir/Rust/DSH/ ' })
  })

  it('lands an @skill: token', () => {
    const { source } = harness()
    expect(source.onPick({
      candidate: { name: 'blender-modeling', value: 'blender-modeling', mentionKind: 'skill' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: '@skill:blender-modeling ' })
  })

  it('lands a markdown chat mention with the host URI', () => {
    const { source } = harness()
    expect(source.onPick({
      candidate: { name: 'Payment rates', value: 'sess-a', mentionKind: 'chat', chatUri: 'dsh-session:YQ' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: '@[Payment rates](dsh-session:YQ) ' })
  })

  it('lands an @plugin: token', () => {
    const { source } = harness()
    expect(source.onPick({
      candidate: { name: 'dsh-atlas', value: 'dsh-atlas', mentionKind: 'plugin' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: '@plugin:dsh-atlas ' })
  })

  it('misses cleanly when the candidate no longer resolves', () => {
    const { source } = harness()
    expect(source.onPick({
      candidate: { name: 'gone.ts', value: 'gone.ts', mentionKind: 'file' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toBeUndefined()
  })

  it('misses cleanly when a candidate has no source-owned value', () => {
    const { source } = harness()
    expect(source.onPick({
      candidate: { name: 'view.ts' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toBeUndefined()
  })
})

describe('@ caches and teardown', () => {
  it('serves the settled index as the @ decoration roll and notifies subscribers', async () => {
    const { source } = harness()
    const notified = vi.fn()
    const off = source.subscribeLexicon!(session('s1'), notified)
    expect(source.lexicon!(session('s1'))).toBeUndefined()
    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(source.lexicon!(session('s1'))).toEqual(['README.md', 'src', 'src/index.ts', 'src/client/view.ts'])
    expect(notified).toHaveBeenCalled()
    off()
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('joins an in-flight fresh fetch instead of refetching', async () => {
    let resolveSearch: (files: readonly FileEntry[]) => void = () => {}
    const search = vi.fn(() => new Promise<readonly FileEntry[]>(resolve => { resolveSearch = resolve }))
    const { source } = harness({ search })
    const first = source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    const second = source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    resolveSearch(FILES)
    await expect(first).resolves.toHaveLength(1 + FILES.filter(file => file.kind === 'file').length)
    await expect(second).resolves.toHaveLength(1 + FILES.filter(file => file.kind === 'file').length)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('caps the visible mixed rows at the design limit', async () => {
    const many: FileEntry[] = Array.from({ length: MAX_CANDIDATES + 5 }, (_, index) => ({
      path: `/ws/f${String(index).padStart(2, '0')}.ts`,
      relative: `f${String(index).padStart(2, '0')}.ts`,
      kind: 'file',
    }))
    const h = harness({ search: vi.fn(async () => many) })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'f0', position: 'leading', signal: new AbortController().signal })
    expect(rows.length).toBeLessThanOrEqual(MAX_CANDIDATES)
  })

  it('yields nothing when a superseded keystroke aborts the caller', async () => {
    const { source } = harness()
    const controller = new AbortController()
    const pending = source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toEqual([])
  })

  it('refetches once the index grows stale beyond the TTL', async () => {
    const { source, search, tick } = harness()
    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    tick(INDEX_TTL_MS + 1)
    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('drops a failed fetch so the next consumer retries', async () => {
    const search = vi.fn(async () => {
      if (search.mock.calls.length === 1) throw new Error('down')
      return FILES
    })
    const { source } = harness({ search })
    await expect(source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal }))
      .rejects.toThrow('down')
    const retried = await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(retried.length).toBeGreaterThan(1)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('prewarms through the signal-less fetch path and contains a warm failure', async () => {
    const search = vi.fn(async () => { throw new Error('down') })
    const { source } = harness({ search })
    source.warm!(session('s1'))
    // The fire-and-forget warmup must not surface as a rejection.
    await Promise.resolve()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('contains a throwing lexicon listener and still notifies the rest', async () => {
    const { source } = harness()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notified = vi.fn()
    source.subscribeLexicon!(session('s1'), () => { throw new Error('boom') })
    source.subscribeLexicon!(session('s1'), notified)
    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(notified).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] lexicon listener failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('invalidateAll aborts in-flight fetches, clears caches, and notifies listeners', async () => {
    const { source, invalidateAll, search } = harness()
    const notified = vi.fn()
    source.subscribeLexicon!(session('s1'), notified)
    const pending = source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    await pending
    invalidateAll()
    expect(search).toHaveBeenCalledTimes(1)
    // The cache is cold again: a fresh candidates pass refetches.
    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(search).toHaveBeenCalledTimes(2)
  })
})

describe('locale templates', () => {
  it('leaves unknown placeholders verbatim', () => {
    expect(fmt('x {a} {b}', { a: '1' })).toBe('x 1 {b}')
  })
})

describe('group collapse', () => {
  it('collapses and expands a chat workspace group', async () => {
    const { source, toggleGroup, isCollapsed } = harness()
    const open = await source.candidates(session('s1'), { query: 'chat:', position: 'leading', signal: new AbortController().signal })
    expect(open.some(row => row.mentionKind === 'chat')).toBe(true)
    toggleGroup(sid('s1'), 'chat:ws')
    expect(isCollapsed(sid('s1'), 'chat:ws')).toBe(true)
    const closed = await source.candidates(session('s1'), { query: 'chat:', position: 'leading', signal: new AbortController().signal })
    // The 'ws' group is collapsed; the ungrouped session stays visible.
    expect(closed.some(row => row.name === 'Payment rates')).toBe(false)
    expect(closed.some(row => row.name === 'Refactor plan')).toBe(true)
    expect(closed.some(row => row.name === '▸ ws' && row.mentionKind === 'chat-group')).toBe(true)
    toggleGroup(sid('s1'), 'chat:ws')
    const reopened = await source.candidates(session('s1'), { query: 'chat:', position: 'leading', signal: new AbortController().signal })
    expect(reopened.some(row => row.mentionKind === 'chat')).toBe(true)
  })

  it('collapses and expands a skill tier group', async () => {
    const { source, toggleGroup } = harness()
    toggleGroup(sid('s1'), 'skill:custom')
    const rows = await source.candidates(session('s1'), { query: 'skill:', position: 'leading', signal: new AbortController().signal })
    // The custom tier is collapsed; the plugin tier still shows its skill.
    expect(rows.some(row => row.name === 'blender-modeling')).toBe(false)
    expect(rows.some(row => row.name === 'dsh-plugin-guide')).toBe(true)
    expect(rows.some(row => row.name === '▸ 自定义')).toBe(true)
  })

  it('clears collapse state on invalidateAll', () => {
    const { toggleGroup, invalidateAll, isCollapsed } = harness()
    toggleGroup(sid('s1'), 'skill:custom')
    invalidateAll()
    expect(isCollapsed(sid('s1'), 'skill:custom')).toBe(false)
  })
})

describe('warm-once and plugin swr', () => {
  it('prewarms each session only once', async () => {
    const { source, search } = harness()
    await source.candidates(session('s1'), { query: '', position: 'leading', signal: new AbortController().signal })
    await Promise.resolve()
    expect(search).toHaveBeenCalledTimes(1)
    await source.candidates(session('s1'), { query: '', position: 'leading', signal: new AbortController().signal })
    await Promise.resolve()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('serves the stale plugin page immediately after the TTL and refreshes in the background', async () => {
    const { source, listPlugins, tick } = harness()
    await source.candidates(session('s1'), { query: 'plugin:', position: 'leading', signal: new AbortController().signal })
    await Promise.resolve()
    tick(INDEX_TTL_MS + 1)
    const rows = await source.candidates(session('s1'), { query: 'plugin:', position: 'leading', signal: new AbortController().signal })
    expect(rows.some(row => row.name === 'dsh-atlas')).toBe(true)
    expect(listPlugins).toHaveBeenCalledTimes(2)
  })
})

describe('stale-while-revalidate', () => {
  it('serves the previous page immediately after the TTL and refreshes in the background', async () => {
    const { source, search, tick } = harness()
    const first = await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(first.length).toBeGreaterThan(1)
    tick(INDEX_TTL_MS + 1)
    const second = await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    // Stale value returned synchronously…
    expect(second.length).toBeGreaterThan(1)
    // …and a background refresh started (the fetch resolves on a later tick).
    expect(search).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(search).toHaveBeenCalledTimes(2)
  })
})

describe('mixed sections and tags', () => {
  it('shows the most-used reference first, then a divider and the relevance section', async () => {
    const h = harness({
      usage: () => [
        { key: 'plugin:dsh-atlas', count: 9, at: 1 },
        { key: 'file:src/client/view.ts', count: 7, at: 2 },
        { key: 'skill:blender-modeling', count: 3, at: 3 },
      ],
    })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'src', position: 'inline', signal: new AbortController().signal })
    // Only the file row matches this query; the higher-count plugin row is
    // filtered out, so the section still leads with it. The sections come first
    // and the five pinned categories are the bottom band.
    const usageHeader = rows.findIndex(row => row.name === '─ 最常用')
    expect(usageHeader).toBe(0)
    expect(rows[usageHeader + 1]).toMatchObject({ name: 'view.ts', mentionKind: 'file' })
    const relevanceHeader = rows.findIndex(row => row.name === '─ 全部匹配')
    expect(relevanceHeader).toBeGreaterThan(usageHeader)
    const relevance = rows.slice(relevanceHeader + 1)
    expect(relevance.some(row => row.name === 'src' && row.mentionKind === 'dir')).toBe(true)
    expect(relevance.some(row => row.description?.includes('文件夹'))).toBe(true)
    // A usage row never repeats inside the relevance section.
    expect(relevance.some(row => row.value === 'src/client/view.ts')).toBe(false)
    expect(rows.slice(-CATEGORIES.length).every(row => row.mentionKind === 'category')).toBe(true)
  })

  it('ranks the most-used rows across categories by pick count', async () => {
    const h = harness({
      usage: () => [
        { key: 'skill:blender-modeling', count: 2, at: 5 },
        { key: 'plugin:dsh-atlas', count: 9, at: 1 },
      ],
    })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'l', position: 'inline', signal: new AbortController().signal })
    const header = rows.findIndex(row => row.name === '─ 最常用')
    expect(header).toBeGreaterThan(-1)
    expect(rows[header + 1]).toMatchObject({ mentionKind: 'plugin', name: 'dsh-atlas' })
    expect(rows[header + 2]).toMatchObject({ mentionKind: 'skill', name: 'blender-modeling' })
  })

  it('skips usage entries the live catalogs no longer know', async () => {
    const h = harness({
      usage: () => [
        { key: 'plugin:uninstalled-plugin', count: 9, at: 1 },
        { key: 'file:src/client/view.ts', count: 4, at: 2 },
      ],
    })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'n', position: 'inline', signal: new AbortController().signal })
    const header = rows.findIndex(row => row.name === '─ 最常用')
    if (header >= 0) {
      expect(rows.slice(header + 1).some(row => row.value === 'uninstalled-plugin')).toBe(false)
    }
    expect(rows.some(row => row.value === 'uninstalled-plugin')).toBe(false)
  })

  it('tags every relevance row with its category', async () => {
    const h = harness()
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'blender', position: 'inline', signal: new AbortController().signal })
    const skill = rows.find(row => row.mentionKind === 'skill')
    expect(skill?.description).toContain('Skill ·')
    const pluginRows = await source.candidates(session('s1'), { query: 'dsh-atlas', position: 'inline', signal: new AbortController().signal })
    const plugin = pluginRows.find(row => row.mentionKind === 'plugin')
    expect(plugin?.description).toContain('插件 ·')
  })

  it('picks a recent row before the workspace index settles', () => {
    const { source } = harness({ recentFiles: () => ['src/client/view.ts'] })
    expect(source.onPick({
      candidate: { name: 'view.ts', value: 'src/client/view.ts', mentionKind: 'file', recent: true },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: '@src/client/view.ts ' })
  })
})

describe('chat cache and instant collapse', () => {
  it('caches the initial @chat: page so repeated opens skip the remote', async () => {
    const { source, listChats } = harness()
    await source.candidates(session('s1'), { query: 'chat:', position: 'leading', signal: new AbortController().signal })
    await source.candidates(session('s1'), { query: 'chat:', position: 'leading', signal: new AbortController().signal })
    expect(listChats).toHaveBeenCalledTimes(1)
    expect(listChats.mock.calls[0]![1]).toBe('')
  })

  it('rebuilds rows synchronously after a toggle when the cache is settled', async () => {
    const { source, toggleGroup, rebuildRows } = harness()
    await source.candidates(session('s1'), { query: 'chat:', position: 'leading', signal: new AbortController().signal })
    toggleGroup(sid('s1'), 'chat:ws')
    const rows = rebuildRows(sid('s1'), 'chat:')
    expect(rows).toBeDefined()
    expect(rows!.some(row => row.name === 'Payment rates')).toBe(false)
    expect(rows!.some(row => row.name === 'Refactor plan')).toBe(true)
    expect(rows![0]!.mentionKind).toBe('back')
  })

  it('returns undefined when the chat cache is not settled yet', () => {
    const { rebuildRows } = harness()
    expect(rebuildRows(sid('s1'), 'chat:')).toBeUndefined()
    expect(rebuildRows(sid('s1'), 'plain query')).toBeUndefined()
  })
})

describe('recent files', () => {
  it('shows recently referenced files first in the @file: initial view', async () => {
    const { source } = harness({ recentFiles: () => ['src/client/view.ts', 'README.md'] })
    const rows = await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    const names = rows.filter(row => row.mentionKind === 'file').map(row => row.name)
    expect(names.slice(0, 2)).toEqual(['view.ts', 'README.md'])
  })

  it('keeps the @file: initial view bounded instead of settling the whole index', async () => {
    // The framework renders every row a source settles with (no virtualization),
    // so an uncapped first view put the entire workspace into the menu — measured
    // live at 180 rows, re-rendered on every keystroke while the query re-settled.
    // The bound is the SAME row budget every other view uses (the user asked for one
    // 口径): nine rows plus the back row, not the older twenty-row cap.
    const many: readonly FileEntry[] = Array.from({ length: 120 }, (_, index) => ({
      path: `/ws/file-${String(index).padStart(3, '0')}.ts`,
      relative: `file-${String(index).padStart(3, '0')}.ts`,
      kind: 'file' as const,
    }))
    const { source } = harness({ search: vi.fn(async () => many) })
    const rows = await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    expect(rows.filter(row => row.mentionKind === 'file')).toHaveLength(FILE_ROW_BUDGET - 1)
    // A typed query is bounded the same way.
    const typed = await source.candidates(session('s1'), { query: 'file:file-', position: 'leading', signal: new AbortController().signal })
    expect(typed.filter(row => row.mentionKind === 'file')).toHaveLength(FILE_ROW_BUDGET - 1)
  })

  it('records a file pick through onRecent', async () => {
    const onRecent = vi.fn()
    const { source } = harness({ onRecent })
    await source.candidates(session('s1'), { query: 'file:', position: 'leading', signal: new AbortController().signal })
    source.onPick({
      candidate: { name: 'view.ts', value: 'src/client/view.ts', mentionKind: 'file', atFileKind: 'file' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(onRecent).toHaveBeenCalledWith(session('s1').sessionId, 'src/client/view.ts')
  })

  it('derives the workspace from an absolute path and its relative', () => {
    expect(workspaceFromAbsolute('E:\\ws\\src\\view.ts', 'src/view.ts')).toBe('E:/ws')
    expect(workspaceFromAbsolute('/work/README.md', 'README.md')).toBe('/work')
  })

  it('keys a referenced path the same way whichever separator it was typed with', () => {
    // A verdict and the token it answers for do not always spell a path alike: the
    // Host canonicalizes an out-of-workspace path to forward slashes, a folder
    // token carries a trailing separator the path has not, and Windows users type
    // backslashes. One key for all of them (see `referenceKey`).
    expect(referenceKey('E:\\outsidedir\\AI.md')).toBe('E:/outsidedir/AI.md')
    expect(referenceKey('E:/outsidedir/AI.md')).toBe('E:/outsidedir/AI.md')
    expect(referenceKey('outsidedir/')).toBe('outsidedir')
    expect(referenceKey('src//')).toBe('src')
    expect(referenceKey('')).toBe('')
  })
})

describe('fuzzy search', () => {
  it('computes edit distance with transpositions', () => {
    expect(editDistance('qulity', 'quality')).toBe(1)
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('ab', 'ba')).toBe(1)
  })

  it('fuzzy-matches a typo against a word token', () => {
    expect(matchesFuzzy('qulity', 'animation-quality-gate')).toBe(true)
    expect(matchesFuzzy('qulity', 'quality gate')).toBe(true)
    expect(matchesFuzzy('blender', 'blender-modeling')).toBe(true)
    expect(matchesFuzzy('xyz', 'animation-quality-gate')).toBe(false)
  })

  it('finds a typo in the skill category and the mixed list', async () => {
    const skills: readonly SkillCandidate[] = [
      { name: 'animation-quality-gate', description: 'Validate Blender animation attempts', tier: 'custom' },
    ]
    const h = harness({ listSkills: vi.fn(async () => skills) })
    const source = await prime(h)
    const category = await source.candidates(session('s1'), { query: 'skill:qulity', position: 'leading', signal: new AbortController().signal })
    expect(category.some(row => row.name === 'animation-quality-gate' && row.mentionKind === 'skill')).toBe(true)
    const mixed = await source.candidates(session('s1'), { query: 'qulity', position: 'inline', signal: new AbortController().signal })
    expect(mixed.some(row => row.name === 'animation-quality-gate' && row.mentionKind === 'skill')).toBe(true)
  })

  it('fuzzy skill search stays false for unrelated typos', async () => {
    const h = harness()
    const source = await prime(h)
    const skillRows = await source.candidates(session('s1'), { query: 'skill:qulity', position: 'leading', signal: new AbortController().signal })
    expect(skillRows.some(row => row.name === 'dsh-plugin-guide' && row.mentionKind === 'skill')).toBe(false)
    const mixed = await source.candidates(session('s1'), { query: 'qulity', position: 'inline', signal: new AbortController().signal })
    expect(mixed.some(row => row.mentionKind === 'skill')).toBe(false)
  })
})

describe('cleanChatLabel', () => {
  it('strips leading markdown heading markers and trims', () => {
    expect(cleanChatLabel('# Instruction: fix the menu')).toBe('Instruction: fix the menu')
    expect(cleanChatLabel('##  Foo  bar ')).toBe('Foo bar')
    expect(cleanChatLabel('plain title')).toBe('plain title')
  })

  it('caps long titles with an ellipsis', () => {
    const long = 'x'.repeat(80)
    expect(cleanChatLabel(long)).toHaveLength(40)
    expect(cleanChatLabel(long).endsWith('…')).toBe(true)
  })
})

describe('relative time and grouping helpers', () => {
  it('buckets times like the sidebar workspace rows', () => {
    const now = 1_000_000_000_000
    expect(relativeTime(now - 30_000, now)).toEqual({ unit: 'now', n: 0 })
    expect(relativeTime(now - 5 * 60_000, now)).toEqual({ unit: 'minutes', n: 5 })
    expect(relativeTime(now - 3 * 3_600_000, now)).toEqual({ unit: 'hours', n: 3 })
    expect(relativeTime(now - 2 * 86_400_000, now)).toEqual({ unit: 'days', n: 2 })
    expect(relativeTime(now - 45 * 86_400_000, now)).toEqual({ unit: 'months', n: 1 })
    expect(relativeTime(now - 400 * 86_400_000, now)).toEqual({ unit: 'years', n: 1 })
  })

  it('renders sidebar-style labels with zh fallback and a bound locale', () => {
    const now = 1_000_000_000_000
    expect(relativeTimeLabel(now - 30_000, now)).toBe('刚刚')
    expect(relativeTimeLabel(now - 5 * 60_000, now)).toBe('5分钟')
    const t = (key: string, params?: Record<string, string>) => key === 'time.now' ? 'now' : `${params?.n ?? '?'}${key}`
    expect(relativeTimeLabel(now - 2 * 3_600_000, now, t)).toBe('2time.hours')
  })

  it('derives workspace titles from directory basenames', () => {
    expect(workspaceTitle('/work/project-a')).toBe('project-a')
    expect(workspaceTitle('C:\\work\\b')).toBe('b')
    expect(workspaceTitle(undefined)).toBe('未分组')
  })

  it('groups skills under their tier with bound labels', async () => {
    const { source } = harness()
    const t = (key: string) => key === 'tier.custom' ? 'CUSTOM' : key
    const rows = await source.candidates(session('s1'), { query: 'skill:', position: 'leading', signal: new AbortController().signal, ...{} } as never)
    void rows
    const withT = createMentionSource({
      search: async () => [],
      listSkills: async () => SKILLS,
      t,
    })
    const tiered = await withT.source.candidates(session('s1'), { query: 'skill:', position: 'leading', signal: new AbortController().signal })
    expect(tiered[1]).toMatchObject({ name: '▾ CUSTOM', mentionKind: 'skill-group' })
    expect(tiered[2]).toMatchObject({ name: '▾ blender', mentionKind: 'skill-group' })
    expect(tiered[3]).toMatchObject({ name: 'blender-modeling', mentionKind: 'skill' })
    expect(tiered[3]!.icon).toBe('file')
  })
})

describe('localized copy', () => {
  /** Minimal binder over a dictionary subset, with `{name}` substitution. */
  const bind = (dict: Record<string, string>) =>
    (key: string, params?: Record<string, string>): string =>
      (dict[key] ?? key).replace(/\{(\w+)\}/gu, (whole, name: string) => params?.[name] ?? whole)

  it('renders category rows, hints, tags, and the back row from the bound dictionary', () => {
    const t = bind({
      'cat.file': 'File',
      'cat.chat': 'Past chats',
      'cat.tag.chat': 'Chat',
      'hint.complete': 'Tab completes → {prefix}',
      'nav.back': 'All categories',
      'group.ungrouped': 'Ungrouped',
    })
    // The framework's row draws file/folder/session itself, so only the kinds it
    // cannot draw carry a text glyph (`menuRowName`).
    expect(categoryRows(t).map(row => row.name)).toEqual([
      'File',
      'cat.folder',
      'cat.skill',
      'Past chats',
      'cat.plugin',
    ])
    expect(hintRow(CATEGORIES[3] as never, t).description).toBe('Tab completes → chat:')
    expect(categoryTag('chat', t)).toBe('Chat')
    expect(backRow(t).name).toBe('All categories')
    expect(workspaceTitle(undefined, t)).toBe('Ungrouped')
  })

  it('keeps the built-in copy when no binder is wired', () => {
    expect(categoryRows().map(row => row.name)[0]).toBe('文件')
    expect(categoryTag('chat')).toBe('聊天')
    expect(backRow().name).toBe('返回类别')
    expect(workspaceTitle(undefined)).toBe('未分组')
  })

  it('keeps the English dictionary complete and free of Chinese copy', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [key, value] of Object.entries(en)) {
      expect(value, key).not.toMatch(/[\u4e00-\u9fff]/u)
    }
  })
})

describe('rankFilesWithFuzzy', () => {
  const FILES: readonly FileEntry[] = [
    { path: '/ws/src/client/view.ts', relative: 'src/client/view.ts', kind: 'file' },
    { path: '/ws/src/client/model.ts', relative: 'src/client/model.ts', kind: 'file' },
    { path: '/ws/docs/spec.pdf', relative: 'docs/spec.pdf', kind: 'file' },
    { path: '/ws/src', relative: 'src', kind: 'dir' },
  ]
  const relatives = (query: string, limit = 10): readonly string[] =>
    rankFilesWithFuzzy(FILES, query, limit).map(file => file.relative)

  it('never lets a near miss displace an exact match', () => {
    expect(relatives('model')).toEqual(['src/client/model.ts'])
  })

  it('reaches a file whose basename is mistyped', () => {
    expect(relatives('moel')).toEqual(['src/client/model.ts'])
    expect(relatives('veiw.ts')).toEqual(['src/client/view.ts'])
  })

  it('reaches files through a mistyped directory segment', () => {
    expect(relatives('clinet')).toEqual(['src/client/view.ts', 'src/client/model.ts'])
  })

  it('keeps short queries and slash queries on the exact path', () => {
    expect(relatives('zz')).toEqual([])
    // Typo tolerance is deliberately off for slash queries: the user already
    // named the directory, so `veiw` must not sweep every other segment.
    expect(relatives('src/veiw')).toEqual([])
    // The exact ranker keeps its own compact-subsequence rule.
    expect(relatives('src/moel')).toEqual(['src/client/model.ts'])
  })

  it('drops matches beyond the distance budget and honors the limit', () => {
    expect(relatives('zzzzzzzz')).toEqual([])
    expect(relatives('clinet', 1)).toEqual(['src/client/view.ts'])
  })
})

describe('provider categories', () => {
  it('claims a shortcut letter when it can, and gives it up rather than collide', () => {
    // The first letter of the id, upper-cased — `G` for `@git`.
    expect(providerCategories([{ id: 'git', display: 'Git' }])[0])
      .toMatchObject({ key: 'provider', providerId: 'git', prefix: 'git:', name: 'Git', shortcut: 'G', english: 'git' })
    // A letter a built-in already answers to is not taken...
    expect(providerCategories([{ id: 'folder-extra', display: 'Extra' }])[0]!.shortcut).toBe('')
    // ...and two providers never share one: the first keeps it.
    const both = providerCategories([{ id: 'git', display: 'Git' }, { id: 'gitlab', display: 'GitLab' }])
    expect(both.map(category => category.shortcut)).toEqual(['G', ''])
    // A query naming the provider resolves to its category, by letter or by id.
    const providers = providerCategories([{ id: 'git', display: 'Git' }])
    expect(completionTarget('g', providers)?.prefix).toBe('git:')
    expect(completionTarget('gi', providers)?.prefix).toBe('git:')
    // An id that cannot be a letter is still reachable through its prefix.
    expect(providerCategories([{ id: '9lives', display: 'Nine' }])[0]!.shortcut).toBe('')
  })

  it('answers a provider shortcut with the categories and its own hint row', async () => {
    const { source } = harness({
      atlasProviders: () => [registration],
    })
    const rows = await source.candidates(session('s1'), { query: 'g', position: 'leading', signal: new AbortController().signal })
    // No matches: a single shortcut letter shows the categories and the hint.
    expect(rows.slice(0, CATEGORIES.length + 1).every(row => row.mentionKind === 'category')).toBe(true)
    expect(rows.at(-1)).toMatchObject({ mentionKind: 'category', value: 'git:', completionHint: true })
    expect(rows.at(-1)!.description).toContain('git:')
  })

  /** One accepted registration, shaped like the seam registry's output. */
  const registration = {
    id: 'git',
    display: 'Git',
    scopes: ['process:git'],
    testedOn: ['0.1.5-rc.1'],
    verified: true,
    provider: {
      id: 'git',
      display: 'Git',
      scopes: ['process:git'],
      testedOn: ['0.1.5-rc.1'],
      list: async (query: string) => [
        { id: 'diff:src/a.ts', title: 'a.ts', preview: '+3 -1' },
        { id: 'diff:src/b.ts', title: 'b.ts' },
      ].filter(item => query === '' || item.id.includes(query)),
    },
  }
  const inline = (): { query: string; position: 'inline'; signal: AbortSignal } =>
    ({ query: '', position: 'inline', signal: new AbortController().signal })

  it('appends a registered provider to the category rows', async () => {
    const h = harness({ atlasProviders: () => [registration] })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), inline())
    expect(rows.some(row => row.mentionKind === 'category' && row.value === 'git:')).toBe(true)
    // The provider names itself: no locale key, no prefixed-raw-key label.
    expect(rows.find(row => row.value === 'git:')).toMatchObject({ name: 'Git' })
  })

  it('shows no provider category until one registers', async () => {
    const h = harness()
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), inline())
    expect(rows.every(row => row.value !== 'git:')).toBe(true)
    // A query naming an unregistered provider falls through to mixed search and
    // still yields nothing for it.
    const rows2 = await source.candidates(session('s1'), { ...inline(), query: 'git:diff' })
    expect(rows2.some(row => row.mentionKind === 'provider')).toBe(false)
  })

  it('fills the provider category from its own list', async () => {
    const h = harness({ atlasProviders: () => [registration] })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { ...inline(), query: 'git:' })
    const provider = rows.filter(row => row.mentionKind === 'provider')
    expect(provider).toHaveLength(2)
    expect(provider[0]).toMatchObject({ name: 'a.ts', value: 'diff:src/a.ts', providerId: 'git' })
    // The provider's preview reaches the row hint, not the model.
    expect(provider[0]).toMatchObject({ hint: '+3 -1' })
  })

  it('routes a provider pick into an @atlas: token and counts usage', () => {
    const { source } = harness({ atlasProviders: () => [registration] })
    const picked = source.onPick({
      candidate: { name: 'a.ts', value: 'diff:src/a.ts', mentionKind: 'provider', providerId: 'git' },
      session: session('s1'),
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    } as never)
    expect(picked).toEqual({ text: '@atlas:git/diff:src/a.ts ' })
  })

  it('contributes provider rows to the mixed view', async () => {
    const h = harness({ atlasProviders: () => [registration] })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { ...inline(), query: 'a.ts' })
    expect(rows.some(row => row.mentionKind === 'provider' && row.providerId === 'git')).toBe(true)
  })

  it('recalls a provider pick in the most-used section', async () => {
    const h = harness({
      atlasProviders: () => [registration],
      usage: () => [{ key: 'atlas:git/diff:src/a.ts', count: 4, at: 1 }],
    })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'diff', position: 'inline', signal: new AbortController().signal })
    const header = rows.findIndex(row => row.name === '─ 最常用')
    expect(header).toBeGreaterThan(-1)
    expect(rows[header + 1]).toMatchObject({ mentionKind: 'provider', providerId: 'git', value: 'diff:src/a.ts' })
  })

  it('skips a most-used pick whose provider is gone', async () => {
    const h = harness({ usage: () => [{ key: 'atlas:git/diff:src/a.ts', count: 4, at: 1 }] })
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query: 'a.ts', position: 'inline', signal: new AbortController().signal })
    expect(rows.some(row => row.mentionKind === 'provider')).toBe(false)
  })

  it('keeps a failing provider from taking the menu down', async () => {
    const failing = {
      ...registration,
      provider: { ...registration.provider, list: async () => { throw new Error('provider exploded') } },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = harness({ atlasProviders: () => [failing] })
      const source = await prime(h)
      const rows = await source.candidates(session('s1'), { ...inline(), query: 'git:' })
      expect(rows.some(row => row.mentionKind === 'provider')).toBe(false)
      // A category view still opens: just the back row, because the provider
      // answered with nothing rather than with an error.
      expect(rows[0]).toMatchObject({ mentionKind: 'back' })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('stays quiet when a provider "failure" is the superseded query', async () => {
    const failing = {
      ...registration,
      provider: {
        ...registration.provider,
        list: async () => { throw new Error('gateway/cancelled: Remote invocation was aborted') },
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = harness({ atlasProviders: () => [failing] })
      const source = await prime(h)
      const controller = new AbortController()
      controller.abort()
      const rows = await source.candidates(session('s1'), {
        query: 'git:',
        position: 'leading',
        signal: controller.signal,
      })
      expect(rows.some(row => row.mentionKind === 'provider')).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('source identity', () => {
  it('registers under the unified atlas group', () => {
    expect(SOURCE_NAME).toBe('atlas')
  })
})

describe('draft reference activation', () => {
  it('opens a token the client activated through the shared action', () => {
    const open = vi.fn()
    const { source } = harness({ actionFor: (_id, link) => () => { open(link) } })
    expect(source.openReference!(session('s1'), { ref: '@a.ts' })).toBe(true)
    expect(open).toHaveBeenCalledWith({ kind: 'file', path: 'a.ts' })
    // A decorated folder token (`@dir/`) opens the directory.
    expect(source.openReference!(session('s1'), { ref: '@src/' })).toBe(true)
    expect(open).toHaveBeenLastCalledWith({ kind: 'folder', path: 'src' })
    expect(source.openReference!(session('s1'), { ref: '@atlas:git/x.ts' })).toBe(true)
    expect(open).toHaveBeenLastCalledWith({ kind: 'atlas', provider: 'git', item: 'x.ts' })
  })

  it('leaves a foreign or actionless token to the next source', () => {
    const { source } = harness({ actionFor: () => undefined })
    // A `/skill` slash mention belongs to the skill source.
    expect(source.openReference!(session('s1'), { ref: '/review' })).toBe(false)
    expect(source.openReference!(session('s1'), { ref: '@plugin:dsh-atlas' })).toBe(false)
    // No action at all in this build (no bridge wired).
    expect(source.openReference!(session('s1'), { ref: '@a.ts' })).toBe(false)
    const { source: bare } = harness()
    expect(bare.openReference!(session('s1'), { ref: '@a.ts' })).toBe(false)
  })
})

describe('shortcut queries and the default highlight', () => {
  /** The real rows for a shortcut query, wrapped as the menu state the navigator sees. */
  const menuFor = async (query: string): Promise<MenuState> => {
    const h = harness()
    const source = await prime(h)
    const rows = await source.candidates(session('s1'), { query, position: 'leading', signal: new AbortController().signal })
    return {
      open: true,
      hit: { trigger: '@', query, position: 'leading', span: { start: 0, end: query.length + 1, draftRev: 1 } },
      generation: 1,
      groups: [{ source: SOURCE_NAME, status: 'ready', items: rows }],
      highlight: null,
    }
  }

  it('lands the default highlight on the named category, not on a match', async () => {
    const menu = await menuFor('s')
    const items = menu.groups[0]!.items
    // The hint row that enters `@skill:` is the LAST row (the bottom band)...
    expect(items.at(-1)).toMatchObject({ mentionKind: 'category', value: 'skill:' })
    expect(defaultHighlightIndex(menu)).toBe(items.length - 1)
    // ...and a single shortcut letter shows no matches at all, so there is
    // nothing for the old first-leaf rule to grab.
    expect(items.every(item => item.mentionKind === 'category')).toBe(true)
  })

  it('keeps the best-match default for a query that names no category', async () => {
    const menu = await menuFor('view')
    expect(defaultHighlightIndex(menu)).toBe(firstLeafIndex(menu))
  })
})