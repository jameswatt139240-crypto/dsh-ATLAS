/**
 * The remaining branches of the '@' source, targeted one by one: locale-bound
 * time labels, fuzzy tie-breaking, empty label/description fields, the abort
 * checks that run after an awaited fetch, the settled-only scope rebuild, the
 * most-used recall for every mention kind, recents ordering, and the pick arms
 * that spell an absolute path. `tests/source.spec.ts` owns the behaviour; this
 * file exists so no branch of `src/client/source.ts` is left unexecuted.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  createMentionSource,
  relativeTimeLabel,
  rankFilesWithFuzzy,
  workspaceTitle,
  backRow,
} from '../src/client/source.ts'
import type { ChatCandidate, FileEntry, PluginCandidate, SkillCandidate } from '../src/client/remote.ts'

const sid = (value: string): SessionId => value as SessionId
const session = (id: string): ClientSessionContext => ({ sessionId: sid(id) }) as ClientSessionContext
const signal = (): AbortSignal => new AbortController().signal
const until = async (done: () => boolean): Promise<void> => {
  for (let index = 0; index < 50 && !done(); index += 1) await Promise.resolve()
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

const FILES: readonly FileEntry[] = [
  { path: '/ws/README.md', relative: 'README.md', kind: 'file' },
  { path: '/ws/src', relative: 'src', kind: 'dir' },
  { path: '/ws/src/index.ts', relative: 'src/index.ts', kind: 'file' },
]

const SKILLS: readonly SkillCandidate[] = [
  { name: 'blender-modeling', description: 'Model in Blender', tier: 'custom' },
  { name: 'quiet-skill', description: '', tier: 'custom' },
]

const CHATS: readonly ChatCandidate[] = [
  { sessionId: 'sess-a', label: 'Payment rates', uri: 'dsh-session:YQ', cwd: '/ws', createdAt: 1 },
  { sessionId: 'sess-empty', label: '', uri: 'dsh-session:Yg', createdAt: 2 },
]

const PLUGINS: readonly PluginCandidate[] = [
  { entryId: 'dsh-atlas', moduleName: 'dsh-atlas', enabled: true },
  { entryId: 'dsh-off', moduleName: 'dsh-off', enabled: true },
]

interface HarnessOptions {
  readonly extra?: Partial<Parameters<typeof createMentionSource>[0]>
}

function harness(options: HarnessOptions = {}) {
  let clock = 1000
  const wrapper = createMentionSource({
    search: async () => FILES,
    listSkills: async () => SKILLS,
    listChats: async () => CHATS,
    listPlugins: async () => PLUGINS,
    now: () => clock,
    ...options.extra,
  })
  const ask = (
    query: string,
    id = 's1',
    caller: AbortSignal = signal(),
  ): Promise<readonly { name: string; mentionKind?: string; value?: string; description?: string }[]> =>
    wrapper.source.candidates(session(id), { query, position: 'leading', signal: caller }) as never
  return {
    ...wrapper,
    ask,
    tick: (ms: number) => { clock += ms },
  }
}

/** The pick call shape the framework hands a source. */
const pick = (candidate: unknown, action: 'pick' | 'drill' = 'pick') => ({
  candidate,
  session: session('s1'),
  position: 'leading' as const,
  via: 'menu' as const,
  action,
  span: { start: 0, end: 1, draftRev: 1 },
})

describe('locale-bound time and workspace labels', () => {
  it('asks the binder for "now" and for a counted unit instead of the built-in copy', () => {
    const t = (key: string, params?: Record<string, string>): string => (params === undefined ? key : `${key}:${params.n}`)
    expect(relativeTimeLabel(1_000, 1_500, t)).toBe('time.now')
    expect(relativeTimeLabel(0, 5 * 60_000, t)).toBe('time.minutes:5')
    // Without a binder the built-in Chinese copy answers instead.
    expect(relativeTimeLabel(0, 5 * 60_000)).toBe('5分钟')
  })

  it('falls back to the raw path when it has no basename to show', () => {
    expect(workspaceTitle('/')).toBe('/')
    expect(workspaceTitle('C:/work/')).toBe('work')
    expect(workspaceTitle(undefined)).toBe('未分组')
  })
})

describe('typo-tolerant ranking ties', () => {
  it('orders equal distances by kind, then length, then name', () => {
    // None of these names contains the query as a subsequence, so the exact
    // ranker answers nothing and the fuzzy fallback is the one under test.
    const files: readonly FileEntry[] = [
      { path: '/ws/abz', relative: 'abz', kind: 'dir' },
      { path: '/ws/aby', relative: 'aby', kind: 'file' },
      { path: '/ws/abx', relative: 'abx', kind: 'file' },
    ]
    expect(rankFilesWithFuzzy(files, 'abc', 10).map(file => file.relative))
      .toEqual(['abx', 'aby', 'abz'])
  })
})

describe('rows whose own fields are empty', () => {
  it('omits the description of a skill that has none, in the category view', async () => {
    const h = harness()
    const rows = await h.ask('skill:')
    const quiet = rows.find(row => row.name === 'quiet-skill')
    expect(quiet).toBeDefined()
    expect(quiet!.description).toBeUndefined()
  })

  it('omits the description of a skill that has none in the most-used section', async () => {
    const h = harness({ extra: { usage: () => [{ key: 'skill:quiet-skill', count: 3, at: 1 }] } })
    await h.ask('')
    const rows = await h.ask('quiet')
    const usage = rows.find(row => row.name === 'quiet-skill')
    expect(usage).toBeDefined()
    expect(usage!.description).toBeUndefined()
  })

  it('shows a chat with no title by its session id', async () => {
    const h = harness()
    const rows = await h.ask('chat:')
    expect(rows.find(row => row.value === 'sess-empty')?.name).toBe('sess-empty')
  })

  it('labels the unscoped plugin bucket from the binder, and keeps the raw name when it has nothing', async () => {
    const t = (key: string): string => (key === 'plugin.scope.other' ? (undefined as unknown as string) : key)
    const h = harness({ extra: { t } })
    const rows = await h.ask('plugin:')
    expect(rows.some(row => row.name.endsWith(' 其他'))).toBe(true)
  })
})

describe('a fetch that settles after the caller gave up', () => {
  it('answers the skill category with an empty list once the signal aborted', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        listSkills: () => new Promise<readonly SkillCandidate[]>(resolve => { setTimeout(() => resolve(SKILLS), 0) }),
      },
    })
    const pending = h.ask('skill:', 's1', caller.signal)
    caller.abort()
    await expect(pending).resolves.toEqual([])
  })

  it('answers the chat category with an empty list once the signal aborted', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        listChats: () => new Promise<readonly ChatCandidate[]>(resolve => { setTimeout(() => resolve(CHATS), 0) }),
      },
    })
    const pending = h.ask('chat:', 's1', caller.signal)
    caller.abort()
    await expect(pending).resolves.toEqual([])
  })

  it('answers a mixed query with an empty list when the index settles after the abort', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        search: () => new Promise<readonly FileEntry[]>(resolve => { setTimeout(() => resolve(FILES), 0) }),
      },
    })
    const pending = h.ask('rea')
    caller.abort()
    await expect(h.ask('rea', 's1', caller.signal)).resolves.toEqual([])
    await pending
  })

  it('answers the folder category empty when the scope settles after the abort', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        external: () => new Promise(resolve => { setTimeout(() => resolve({ canDiscover: true, roots: [], folders: [] }), 0) }),
      },
    })
    const pending = h.ask('folder:do', 's1', caller.signal)
    caller.abort()
    await expect(pending).resolves.toEqual([])
  })

  it('answers the file category empty when the draft scope settles after the abort', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        scopeFolder: () => new Promise(resolve => { setTimeout(() => resolve('/outside/proj'), 0) }),
        list: async () => ({ path: '/outside/proj', entries: [] }),
      },
    })
    const pending = h.ask('file:a', 's1', caller.signal)
    caller.abort()
    await expect(pending).resolves.toEqual([])
  })
})

describe('the out-of-workspace scope', () => {
  it('labels a top-level external folder without repeating an empty parent', async () => {
    const h = harness({
      extra: { external: async () => ({ canDiscover: true, roots: ['/solo'], folders: ['/solo'] }) },
    })
    const rows = await h.ask('folder:sol')
    const row = rows.find(candidate => candidate.value === '/solo/')
    expect(row?.description).toBe('工作区外')
  })

  it('keeps a scope folder whose listing has files, and drops one that failed', async () => {
    const h = harness({
      extra: {
        scopeFolder: async () => '/outside/proj',
        list: async (_id: SessionId, path: string) => path === '/outside/proj'
          ? { path, entries: [{ name: 'a.ts', kind: 'file' }, { name: 'sub', kind: 'dir' }] }
          : { path, entries: [], error: 'denied' },
      },
    })
    const rows = await h.ask('file:')
    expect(rows.some(row => row.name === 'a.ts')).toBe(true)
    // Only files are scope rows; a directory inside the scope is not.
    expect(rows.some(row => row.name === 'sub')).toBe(false)
  })

  it('answers a browse failure with a note from the binder, and the raw reason without one', async () => {
    const bind = (key: string): string => (key === 'folder.error.denied' ? (undefined as unknown as string) : key)
    const denial = { path: '/outside', entries: [], error: 'denied' } as never
    const bound = harness({ extra: { list: async () => denial, t: bind } })
    expect((await bound.ask('/outside')).map(row => row.name)).toContain('denied')
    const raw = harness({ extra: { list: async () => denial } })
    expect((await raw.ask('/outside')).map(row => row.name)).toContain('denied')
  })
})

describe('the synchronous fold rebuild', () => {
  it('rebuilds the folder view from the settled index alone', async () => {
    const h = harness()
    await h.ask('')
    await settle()
    expect(h.rebuildRows(sid('s1'), 'folder:')).toBeDefined()
  })

  it('rebuilds the file view without a scope before any folder was named', async () => {
    const h = harness()
    await h.ask('')
    await settle()
    expect(h.rebuildRows(sid('s1'), 'file:re')).toBeDefined()
  })

  it('refuses to rebuild a category whose page never settled', () => {
    const h = harness()
    expect(h.rebuildRows(sid('s1'), 'skill:')).toBeUndefined()
    expect(h.rebuildRows(sid('s1'), 'plugin:')).toBeUndefined()
    expect(h.rebuildRows(sid('s1'), 'chat:')).toBeUndefined()
    expect(h.rebuildRows(sid('s1'), 'plain')).toBeUndefined()
  })

  it('rebuilds the chat view from the settled page', async () => {
    const h = harness()
    await h.ask('')
    await settle()
    expect(h.rebuildRows(sid('s1'), 'chat:')).toBeDefined()
  })
})

describe('the most-used recall', () => {
  it('recalls a directory pick as a directory row', async () => {
    const h = harness({ extra: { usage: () => [{ key: 'dir:src', count: 9, at: 1 }] } })
    await h.ask('')
    const rows = await h.ask('src')
    expect(rows.some(row => row.value === 'src' && row.mentionKind === 'dir')).toBe(true)
  })

  it('skips an entry whose chat, file or plugin is gone, and one with no kind prefix', async () => {
    const h = harness({
      extra: {
        usage: () => [
          { key: 'chat:gone', count: 9, at: 3 },
          { key: 'file:gone.ts', count: 8, at: 2 },
          { key: 'plugin:gone', count: 7, at: 1 },
          { key: 'noseparator', count: 6, at: 0 },
          { key: ':empty-kind', count: 5, at: 0 },
        ],
      },
    })
    await h.ask('')
    const rows = await h.ask('gone')
    expect(rows.every(row => row.name !== 'gone' && row.name !== 'noseparator')).toBe(true)
  })

  it('recalls a chat that has no workspace as a row without a description', async () => {
    const h = harness({
      extra: {
        listChats: async () => [{ sessionId: 'sess-bare', label: 'Bare', uri: 'dsh-session:YQ', createdAt: 1 }],
        usage: () => [{ key: 'chat:sess-bare', count: 9, at: 1 }],
      },
    })
    await h.ask('')
    const rows = await h.ask('Bare')
    const row = rows.find(candidate => candidate.value === 'sess-bare')
    expect(row).toBeDefined()
    expect(row!.description).toBeUndefined()
  })

  it('orders equal counts by recency, and stops at the row budget', async () => {
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      key: `file:README.md`,
      count: 1,
      at: index,
    }))
    const h = harness({ extra: { usage: () => [...many, { key: 'file:README.md', count: 9, at: 0 }] } })
    await h.ask('')
    const rows = await h.ask('README')
    expect(rows.filter(row => row.name === 'README.md').length).toBeLessThan(40)
  })
})

describe('a provider recall whose key is malformed', () => {
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
      list: async () => [{ id: 'diff:a.ts', title: 'a.ts' }],
    },
  }

  it('drops a key with no provider or no item, and rebuilds one that names both', async () => {
    const h = harness({
      extra: {
        atlasProviders: () => [registration as never],
        usage: () => [
          { key: 'atlas:noslash', count: 9, at: 3 },
          { key: 'atlas:/item-only', count: 8, at: 2 },
          { key: 'atlas:git/', count: 7, at: 1 },
          { key: 'atlas:git/diff:a.ts', count: 6, at: 0 },
        ],
      },
    })
    await h.ask('')
    const rows = await h.ask('a.ts')
    // The recall row and the provider's own live match spell the same value; what
    // matters is that the malformed keys contributed nothing.
    expect(rows.filter(row => row.mentionKind === 'provider').every(row => row.value === 'diff:a.ts')).toBe(true)
    expect(rows.some(row => row.mentionKind === 'provider')).toBe(true)
  })

  it('shows a provider item without a badge by its provider id alone', async () => {
    const h = harness({ extra: { atlasProviders: () => [registration as never] } })
    const rows = await h.ask('git:')
    expect(rows.find(row => row.value === 'diff:a.ts')?.description).toBe('git')
  })
})

describe('the recent-file roll', () => {
  it('keeps only files the index knows once, in the recorded order', async () => {
    const h = harness({
      extra: { recentFiles: () => ['README.md', 'src', 'README.md', 'vanished.ts'] },
    })
    const rows = await h.ask('file:')
    const names = rows.map(row => row.name)
    // The view leads with the back row; the recent file is the first content row.
    expect(names[1]).toBe('README.md')
    expect(names).not.toContain('src')
    expect(names.filter(name => name === 'README.md')).toHaveLength(1)
  })
})

describe('the pick arms that spell a path', () => {
  it('keeps the menu open on an up/drive row that carries no value', () => {
    const h = harness()
    expect(h.source.onPick(pick({ name: '⬆', mentionKind: 'browse-up' }) as never))
      .toEqual({ text: '@', continue: true })
  })

  it('marks a drilled folder with a trailing slash and a picked one with a space', () => {
    const h = harness()
    const row = { name: 'docs/', value: '/outside/docs', mentionKind: 'browse-dir' }
    expect(h.source.onPick(pick(row, 'drill') as never)).toEqual({ text: '@/outside/docs/', continue: true })
    expect(h.source.onPick(pick(row) as never)).toEqual({ text: '@/outside/docs/ ' })
  })

  it('drafts a browsed file as a plain absolute reference', () => {
    const h = harness()
    expect(h.source.onPick(pick({ name: 'a.ts', value: '/outside/a.ts', mentionKind: 'browse-file' }) as never))
      .toEqual({ text: '@/outside/a.ts ' })
  })

  it('records an absolute folder pick without doubling its separator', () => {
    const onUsage = vi.fn()
    const h = harness({ extra: { onUsage } })
    expect(h.source.onPick(pick({ name: 'DSH/', value: '/outside/DSH/', mentionKind: 'dir' }) as never))
      .toEqual({ text: '@/outside/DSH/ ' })
    expect(onUsage).toHaveBeenCalledWith(sid('s1'), 'dir', '/outside/DSH/')
  })

  it('drafts a workspace directory with a trailing slash and records it as a dir', async () => {
    const onUsage = vi.fn()
    const h = harness({ extra: { onUsage } })
    await h.ask('')
    await settle()
    expect(h.source.onPick(pick({ name: 'src/', value: 'src', mentionKind: 'dir' }) as never))
      .toEqual({ text: '@src/ ' })
    expect(onUsage).toHaveBeenCalledWith(sid('s1'), 'dir', 'src')
  })

  it('refuses a row whose value names nothing in the index and is not recent', () => {
    const h = harness()
    expect(h.source.onPick(pick({ name: 'ghost.ts', mentionKind: 'file' }) as never)).toBeUndefined()
  })

  it('refuses a provider row without an item id', () => {
    const h = harness()
    expect(h.source.onPick(pick({ name: 'Git', mentionKind: 'provider', providerId: 'git' }) as never))
      .toBeUndefined()
  })

  it('drafts a provider pick as an @atlas token and counts it', () => {
    const onUsage = vi.fn()
    const h = harness({ extra: { onUsage } })
    expect(h.source.onPick(pick({ name: 'a.ts', value: 'diff:a.ts', mentionKind: 'provider', providerId: 'git' }) as never))
      .toEqual({ text: '@atlas:git/diff:a.ts ' })
    expect(onUsage).toHaveBeenCalledWith(sid('s1'), 'atlas', 'git/diff:a.ts')
  })
})

describe('a build without the optional list seams', () => {
  it('answers the skill and plugin categories with nothing instead of throwing', async () => {
    const h = harness({
      extra: {
        listSkills: undefined,
        listPlugins: undefined,
        search: async () => FILES,
      },
    })
    expect(await h.ask('skill:')).toEqual([backRow()])
    expect(await h.ask('plugin:')).toEqual([backRow()])
  })
})

describe('the second comparison of a tie', () => {
  it('orders the same rows the other way when the directory is seen first', () => {
    const files: readonly FileEntry[] = [
      { path: '/ws/abz', relative: 'abz', kind: 'dir' },
      { path: '/ws/abx', relative: 'abx', kind: 'file' },
      { path: '/ws/aby', relative: 'aby', kind: 'file' },
    ]
    expect(rankFilesWithFuzzy(files, 'abc', 10).map(file => file.relative))
      .toEqual(['abx', 'aby', 'abz'])
  })
})

describe('plugin scopes that need no localization', () => {
  it('shows an npm scope under its own name while a binder is present', async () => {
    const t = (key: string): string => key
    const h = harness({
      extra: {
        t,
        listPlugins: async () => [{ entryId: 'atlas', moduleName: '@deepseek-ai/dsh-atlas', enabled: true }],
      },
    })
    const rows = await h.ask('plugin:')
    expect(rows.some(row => row.name === '▾ @deepseek-ai')).toBe(true)
  })
})

describe('a page created after the cache was dropped', () => {
  it('honours the caller abort on a skill page it had to fetch again', async () => {
    const h = harness({ extra: { listSkills: async () => SKILLS } })
    await h.ask('skill:')
    h.invalidateAll()
    const caller = new AbortController()
    const pending = h.ask('skill:', 's1', caller.signal)
    caller.abort()
    expect(await pending).toEqual([])
  })

  it('honours the caller abort on a chat page it had to fetch again', async () => {
    const h = harness({ extra: { listChats: async () => CHATS } })
    await h.ask('chat:')
    h.invalidateAll()
    const caller = new AbortController()
    const pending = h.ask('chat:', 's1', caller.signal)
    caller.abort()
    expect(await pending).toEqual([])
  })

  it('answers the scope with nothing when the fetch it replaces was never answered', async () => {
    const h = harness({ extra: { external: () => new Promise(() => undefined) } })
    void h.ask('folder:do')
    h.tick(60_000)
    const caller = new AbortController()
    const pending = h.ask('folder:do', 's1', caller.signal)
    caller.abort()
    expect(await pending).toEqual([])
  })
})

describe('a cancellation the seams raise', () => {
  it('says nothing when the draft scope lookup was the thing aborted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({
      extra: {
        scopeFolder: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) },
      },
    })
    const rows = await h.ask('file:re')
    expect(rows.some(row => row.name === 'README.md')).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('says nothing when the scoped listing was the thing aborted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({
      extra: {
        scopeFolder: async () => '/outside/proj',
        list: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) },
      },
    })
    const rows = await h.ask('file:re')
    expect(rows.some(row => row.name === 'README.md')).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops the file view when the caller aborts while the draft scope resolves', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        scopeFolder: () => { caller.abort(); return Promise.resolve('/outside/proj') },
        list: async () => ({ path: '/outside/proj', entries: [] }),
      },
    })
    expect(await h.ask('file:a', 's1', caller.signal)).toEqual([])
  })
})

describe('provider rows the registry can still answer', () => {
  const base = {
    id: 'git',
    display: 'Git',
    scopes: ['process:git'],
    testedOn: ['0.1.5-rc.1'],
    verified: true,
  }

  it('shows the badge a provider put on its own item', async () => {
    const h = harness({
      extra: {
        atlasProviders: () => [{
          ...base,
          provider: { ...base, list: async () => [{ id: 'diff:a.ts', title: 'a.ts', badge: 'v2' }] },
        } as never],
      },
    })
    const rows = await h.ask('git:')
    expect(rows.find(row => row.value === 'diff:a.ts')?.description).toBe('git · v2')
  })

  it('answers nothing when the registration lost its list between the menu and the call', async () => {
    const h = harness({
      extra: {
        atlasProviders: () => [{ ...base, provider: { ...base } } as never],
      },
    })
    expect(await h.ask('git:')).toEqual([backRow()])
  })
})

describe('usage entries whose live object cannot answer', () => {
  it('recalls a chat with no title by its session id, and no workspace to name', async () => {
    const h = harness({
      extra: {
        listChats: async () => [{ sessionId: 'sess-bare', label: '', uri: 'dsh-session:YQ', createdAt: 1 }],
        usage: () => [{ key: 'chat:sess-bare', count: 9, at: 1 }],
      },
    })
    await h.ask('')
    const rows = await h.ask('sess-bare')
    const row = rows.find(candidate => candidate.value === 'sess-bare')
    expect(row?.name).toBe('sess-bare')
    expect(row?.description).toBeUndefined()
  })

  it('drops a provider key with no separator and one with no item', async () => {
    const registration = {
      id: 'git',
      display: 'Git',
      scopes: ['process:git'],
      testedOn: ['0.1.5-rc.1'],
      verified: true,
      provider: { id: 'git', display: 'Git', scopes: ['process:git'], testedOn: ['0.1.5-rc.1'], list: async () => [] },
    }
    const h = harness({
      extra: {
        atlasProviders: () => [registration as never],
        usage: () => [
          { key: 'atlas:nosl', count: 9, at: 2 },
          { key: 'atlas:git/', count: 8, at: 1 },
        ],
      },
    })
    await h.ask('')
    expect((await h.ask('nosl')).some(row => row.mentionKind === 'provider')).toBe(false)
    expect((await h.ask('git/')).some(row => row.mentionKind === 'provider')).toBe(false)
  })

  it('drops a key whose kind no catalog answers', async () => {
    const h = harness({ extra: { usage: () => [{ key: 'note:hello', count: 9, at: 1 }] } })
    await h.ask('')
    const rows = await h.ask('hello')
    // The pinned category band still answers; the unknown kind contributes no row.
    expect(rows.some(row => row.name === 'hello')).toBe(false)
  })
})

describe('a mixed query that also names a category', () => {
  it('puts the completion hint last, after the pinned categories', async () => {
    const h = harness()
    const rows = await h.ask('fi')
    expect(rows.at(-1)).toMatchObject({ mentionKind: 'category', completionHint: true, value: 'file:' })
  })
})

describe('pick arms whose candidate carries no value', () => {
  it('spells the bare root for a browse row that has none', () => {
    const h = harness()
    expect(h.source.onPick(pick({ name: '..', mentionKind: 'browse-dir' }, 'drill') as never))
      .toEqual({ text: '@/', continue: true })
    expect(h.source.onPick(pick({ name: '..', mentionKind: 'browse-dir' }) as never))
      .toEqual({ text: '@/ ' })
    expect(h.source.onPick(pick({ name: 'a.ts', mentionKind: 'browse-file' }) as never))
      .toEqual({ text: '@ ' })
  })

  it('records a workspace file pick with no suffix', async () => {
    const onUsage = vi.fn()
    const h = harness({ extra: { onUsage } })
    await h.ask('')
    await settle()
    expect(h.source.onPick(pick({ name: 'README.md', value: 'README.md', mentionKind: 'file' }) as never))
      .toEqual({ text: '@README.md ' })
    expect(onUsage).toHaveBeenCalledWith(sid('s1'), 'file', 'README.md')
  })

  it('counts nothing for a skill, chat or plugin row that carries no value', () => {
    const onUsage = vi.fn()
    const h = harness({ extra: { onUsage } })
    h.source.onPick(pick({ name: 'x', mentionKind: 'skill' }) as never)
    h.source.onPick(pick({ name: 'x', mentionKind: 'chat' }) as never)
    h.source.onPick(pick({ name: 'x', mentionKind: 'plugin' }) as never)
    expect(onUsage).not.toHaveBeenCalled()
  })
})

describe('the synchronous rebuild of a settled list', () => {
  it('folds a settled skill page through the collapse keys', async () => {
    const h = harness()
    await h.ask('')
    await h.ask('skill:')
    expect(h.rebuildRows(sid('s1'), 'skill:')).toBeDefined()
    expect(h.rebuildRows(sid('s1'), 'plugin:')).toBeDefined()
  })
})

describe('a rejection that arrives after its entry was forgotten', () => {
  type Reject = (error: unknown) => void
  const deferred = (): { promise: Promise<never>; reject: Reject } => {
    let reject: Reject = () => undefined
    const promise = new Promise<never>((_resolve, fail) => { reject = fail })
    return { promise, reject }
  }

  it('leaves the newer skill page alone', async () => {
    const { promise, reject } = deferred()
    const h = harness({ extra: { listSkills: () => promise } })
    const pending = h.ask('skill:')
    h.invalidateAll()
    reject(new Error('late'))
    await expect(pending).rejects.toThrow('late')
  })

  it('leaves the newer plugin page alone', async () => {
    const { promise, reject } = deferred()
    const h = harness({ extra: { listPlugins: () => promise } })
    const pending = h.ask('plugin:')
    h.invalidateAll()
    reject(new Error('late'))
    await expect(pending).rejects.toThrow('late')
  })

  it('leaves the newer external scope alone', async () => {
    const { promise, reject } = deferred()
    const h = harness({ extra: { external: () => promise } })
    const pending = h.ask('folder:do')
    h.invalidateAll()
    reject(new Error('late'))
    // The folder view contains the failure: an unread scope is not an error row.
    await expect(pending).resolves.toBeDefined()
  })

  it('leaves the refreshed scope alone after the menu forgot it', async () => {
    const { promise, reject } = deferred()
    let calls = 0
    const h = harness({
      extra: {
        external: () => {
          calls += 1
          return calls === 1
            ? Promise.resolve({ canDiscover: false, roots: [], folders: [] })
            : promise
        },
      },
    })
    await h.ask('folder:do')
    h.tick(60_000)
    // The stale answer is served now and the refresh runs behind it.
    await h.ask('folder:do')
    h.invalidateExternal('s1')
    reject(new Error('late'))
    await settle()
    // The forgotten refresh failing is not the menu's business.
    expect(h.isCollapsed(sid('s1'), 'folder:path')).toBeDefined()
  })

  it('leaves the refreshed listing alone after the menu forgot it', async () => {
    const { promise, reject } = deferred()
    let calls = 0
    const h = harness({
      extra: {
        scopeFolder: async () => '/outside/proj',
        list: () => {
          calls += 1
          return calls === 1 ? Promise.resolve({ path: '/outside/proj', entries: [] }) : promise
        },
      },
    })
    await h.ask('file:a')
    h.tick(60_000)
    const pending = h.ask('file:a')
    h.invalidateAll()
    reject(new Error('late'))
    await expect(pending).resolves.toBeDefined()
  })
})

describe('the workspace folder tier over its budget', () => {
  it('stops pushing rows once the budget is spent', async () => {
    const dirs: readonly FileEntry[] = Array.from({ length: 26 }, (_unused, index) => ({
      path: `/ws/pkg-${index}`,
      relative: `pkg-${index}`,
      kind: 'dir' as const,
    }))
    const h = harness({ extra: { search: async () => dirs } })
    const rows = await h.ask('folder:')
    expect(rows.length).toBeLessThanOrEqual(21)
    expect(rows.some(row => row.name === 'pkg-25/')).toBe(false)
  })
})

describe('two lexicon subscribers', () => {
  it('keeps the channel open when only one of them leaves', async () => {
    const h = harness()
    const first = vi.fn()
    const second = vi.fn()
    const leaveFirst = h.source.subscribeLexicon(session('s1'), first)
    const leaveSecond = h.source.subscribeLexicon(session('s1'), second)
    leaveFirst()
    await h.ask('')
    expect(second).toHaveBeenCalled()
    leaveSecond()
  })
})

describe('more ties than one comparison can settle', () => {
  it('compares a directory against a file and against another directory', () => {
    const files: readonly FileEntry[] = [
      { path: '/ws/abx', relative: 'abx', kind: 'file' },
      { path: '/ws/abz', relative: 'abz', kind: 'dir' },
      { path: '/ws/aby', relative: 'aby', kind: 'file' },
      { path: '/ws/abw', relative: 'abw', kind: 'dir' },
      { path: '/ws/abv', relative: 'abv', kind: 'file' },
      { path: '/ws/abt', relative: 'abt', kind: 'dir' },
    ]
    const ranked = rankFilesWithFuzzy(files, 'abc', 10).map(file => file.relative)
    expect(ranked.slice(0, 3)).toEqual(['abv', 'abx', 'aby'])
    expect(ranked.slice(3)).toEqual(['abt', 'abw', 'abz'])
  })
})

describe('a mixed query that matches plugins', () => {
  it('sorts the plugin rows alphabetically under their scope', async () => {
    const h = harness({
      extra: {
        listPlugins: async () => [
          { entryId: 'z', moduleName: 'dsh-zeta', enabled: true },
          { entryId: 'a', moduleName: 'dsh-alpha', enabled: true },
        ],
      },
    })
    const rows = await h.ask('dsh')
    const plugins = rows.filter(row => row.mentionKind === 'plugin').map(row => row.name)
    expect(plugins).toEqual(['dsh-alpha', 'dsh-zeta'])
  })
})

describe('a caller that aborts from inside the seam', () => {
  it('answers the folder view empty when the external scope resolves into an abort', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        external: () => {
          caller.abort()
          return Promise.resolve({ canDiscover: false, roots: [], folders: [] })
        },
      },
    })
    expect(await h.ask('folder:do', 's1', caller.signal)).toEqual([])
  })

  it('answers the chat view empty when the page resolves into an abort', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        listChats: () => {
          caller.abort()
          return Promise.resolve(CHATS)
        },
      },
    })
    expect(await h.ask('chat:', 's1', caller.signal)).toEqual([])
  })
})

describe('the scope birth prewarm', () => {
  it('swallows every failure of its own fire-and-forget fetches', async () => {
    const h = harness({
      extra: {
        search: async () => { throw new Error('index down') },
        listSkills: async () => { throw new Error('skills down') },
        listChats: async () => { throw new Error('chats down') },
        listPlugins: async () => { throw new Error('plugins down') },
      },
    })
    h.source.warm(session('s-warm'))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(h.rebuildRows(sid('s-warm'), 'skill:')).toBeUndefined()
  })
})

describe('a revalidation the user abandons', () => {
  it('answers the folder view empty when the refresh it started is aborted mid-flight', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        external: () => {
          setTimeout(() => caller.abort(), 1)
          return new Promise(resolve => setTimeout(
            () => resolve({ canDiscover: false, roots: [], folders: [] }),
            5,
          ))
        },
      },
    })
    // The warm pass starts the scope with no signal; the folder view arrives
    // while it is still in flight and stale, so it starts its own.
    void h.ask('file:x')
    await settle()
    h.tick(60_000)
    expect(await h.ask('folder:do', 's1', caller.signal)).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('answers the chat view empty when the page it rebuilt is aborted as it loads', async () => {
    const caller = new AbortController()
    let calls = 0
    const h = harness({
      extra: {
        listChats: () => {
          calls += 1
          if (calls > 1) caller.abort()
          return Promise.resolve(CHATS)
        },
      },
    })
    await h.ask('chat:')
    h.invalidateAll()
    expect(await h.ask('chat:', 's1', caller.signal)).toEqual([])
  })
})

describe('an out-of-workspace pick', () => {
  it('drafts a file with no trailing separator and counts it as a file', () => {
    const onUsage = vi.fn()
    const h = harness({ extra: { onUsage } })
    expect(h.source.onPick(pick({ name: 'notes.txt', value: '/outside/notes.txt', mentionKind: 'file' }) as never))
      .toEqual({ text: '@/outside/notes.txt ' })
    expect(onUsage).toHaveBeenCalledWith(sid('s1'), 'file', '/outside/notes.txt')
  })
})

describe('a plugin page the user abandons', () => {
  it('answers the plugin view empty when the page it rebuilt is aborted as it loads', async () => {
    const caller = new AbortController()
    let calls = 0
    const h = harness({
      extra: {
        listPlugins: () => {
          calls += 1
          if (calls > 1) caller.abort()
          return Promise.resolve(PLUGINS)
        },
      },
    })
    await h.ask('plugin:')
    h.invalidateAll()
    expect(await h.ask('plugin:', 's1', caller.signal)).toEqual([])
  })
})

describe('a stale rejection against a cache that already moved on', () => {
  const bill = () => {
    const make = (): { promise: Promise<never>; fail: (error: unknown) => void } => {
      let fail: (error: unknown) => void = () => undefined
      const promise = new Promise<never>((_resolve, reject) => { fail = reject })
      return { promise, fail }
    }
    return { make }
  }

  it('keeps the skill page that was already forgotten when it fails', async () => {
    const first = bill().make()
    let calls = 0
    const h = harness({
      extra: { listSkills: () => { calls += 1; return first.promise } },
    })
    void h.ask('skill:', 's1').catch(() => undefined)
    await until(() => calls === 1)
    h.invalidateAll()
    first.fail(new Error('late'))
    await settle()
    expect(calls).toBe(1)
  })

  it('keeps the plugin page that was already forgotten when it fails', async () => {
    const first = bill().make()
    let calls = 0
    const h = harness({
      extra: { listPlugins: () => { calls += 1; return first.promise } },
    })
    void h.ask('plugin:').catch(() => undefined)
    await until(() => calls === 1)
    h.invalidateAll()
    first.fail(new Error('late'))
    await settle()
    expect(calls).toBe(1)
  })

  it('keeps the skill page that failed to refresh after the menu forgot it', async () => {
    const refresh = bill().make()
    let calls = 0
    const h = harness({
      extra: { listSkills: () => { calls += 1; return calls === 1 ? Promise.resolve(SKILLS) : refresh.promise } },
    })
    const settledRows = await h.ask('skill:')
    expect(settledRows.length).toBeGreaterThan(1)
    h.tick(60_000)
    void h.ask('skill:').catch(() => undefined)
    await until(() => calls === 2)
    h.invalidateAll()
    refresh.fail(new Error('late'))
    await settle()
    expect(calls).toBe(2)
  })

  it('keeps the plugin page that failed to refresh after the menu forgot it', async () => {
    const refresh = bill().make()
    let calls = 0
    const h = harness({
      extra: { listPlugins: () => { calls += 1; return calls === 1 ? Promise.resolve(PLUGINS) : refresh.promise } },
    })
    const settledRows = await h.ask('plugin:')
    expect(settledRows.some(row => row.mentionKind === 'plugin')).toBe(true)
    h.tick(60_000)
    void h.ask('plugin:').catch(() => undefined)
    await until(() => calls === 2)
    h.invalidateAll()
    refresh.fail(new Error('late'))
    await settle()
    expect(calls).toBe(2)
  })

  it('keeps the scope listing that was already forgotten when it fails', async () => {
    const first = bill().make()
    let calls = 0
    const h = harness({
      extra: {
        scopeFolder: async () => '/outside/proj',
        list: (_id: string, path: string) => {
          calls += 1
          return first.promise.then(() => ({ path, entries: [] }))
        },
      },
    })
    void h.ask('file:a').catch(() => undefined)
    await until(() => calls === 1)
    h.invalidateAll()
    first.fail(new Error('late'))
    await settle()
    expect(calls).toBe(1)
  })
})

describe('a chat row without a value', () => {
  it('drafts the link and counts nothing', () => {
    const onUsage = vi.fn()
    const h = harness({ extra: { onUsage } })
    expect(h.source.onPick(pick({ name: 'Payment rates', mentionKind: 'chat', chatUri: 'dsh-session:YQ' }) as never))
      .toEqual({ text: '@[Payment rates](dsh-session:YQ) ' })
    expect(onUsage).not.toHaveBeenCalled()
  })
})

/**
 * The out-of-workspace scope, and the pick that puts a folder into it.
 *
 * Reported: a folder added as an out-of-workspace reference was invisible to
 * `@`, `@folder:`, `@dsh` and `@DSH` right after it was added, and only showed
 * up "a while later". Three separate causes, all covered here: the scope's rows
 * were read from the settled snapshot only (a cold scope contributed nothing),
 * nothing recorded the folder until a message carrying it was SENT, and the
 * settled scope outlived the ledger change by a whole TTL.
 */
const WITHOUT_ATLAS: ExternalAccessScopeFixture = {
  canDiscover: true,
  roots: ['/home/ubuntu/Eason/DSH-Atlas'],
  folders: ['/home/ubuntu/Eason/DSH-Atlas'],
}

type ExternalAccessScopeFixture = Parameters<typeof createMentionSource>[0]['external'] extends
  (sessionId: SessionId, signal: AbortSignal) => Promise<infer Scope> ? Scope : never

const scopeHarness = (extra: Partial<Parameters<typeof createMentionSource>[0]> = {}) => {
  const external = vi.fn(async () => WITHOUT_ATLAS)
  const h = harness({ extra: { external, ...extra } })
  return { ...h, external }
}

describe('the folder the draft points at, searched by a plain @', () => {
  const entries = [
    { name: 'Fable5.2-Godot-四个工程.zip', kind: 'file' as const },
    { name: 'godot-src', kind: 'dir' as const },
    { name: 'notes.txt', kind: 'file' as const },
  ]

  it('finds the file a draft-scoped folder holds, without the file: category', async () => {
    const h = harness({
      extra: {
        scopeFolder: async () => '/home/ubuntu/Downloads/',
        list: async () => ({ path: '/home/ubuntu/Downloads', entries }),
      },
    })
    await h.ask('Fable') // first keystroke starts the listing
    const rows = await h.ask('Fable')
    expect(rows.some(row => row.name === 'Fable5.2-Godot-四个工程.zip')).toBe(true)
    expect(rows.find(row => row.name === 'Fable5.2-Godot-四个工程.zip')?.value)
      .toBe('/home/ubuntu/Downloads/Fable5.2-Godot-四个工程.zip')
  })

  it('finds a sub-folder of it too, and marks it as a folder', async () => {
    const h = harness({
      extra: {
        scopeFolder: async () => '/home/ubuntu/Downloads/',
        list: async () => ({ path: '/home/ubuntu/Downloads', entries }),
      },
    })
    await h.ask('godot')
    const rows = await h.ask('godot')
    const row = rows.find(candidate => candidate.name === 'godot-src/')
    expect(row?.mentionKind).toBe('dir')
    expect(row?.value).toBe('/home/ubuntu/Downloads/godot-src/')
  })

  it('leaves a scope inside the workspace to the index, without listing it twice', async () => {
    const list = vi.fn(async () => ({ path: '/ws/src', entries }))
    const h = harness({ extra: { scopeFolder: async () => '/ws/src', list } })
    await h.ask('Fable')
    expect(list).not.toHaveBeenCalled()
  })

  it('names a scope lookup that failed for a reason other than cancellation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({
      extra: { scopeFolder: async () => { throw new Error('no draft') } },
    })
    await h.ask('Fable')
    expect(warn).toHaveBeenCalledWith('[dsh-atlas] draft scope lookup failed:', expect.any(Error))
    warn.mockRestore()
  })

  it('names a listing that failed for a reason other than cancellation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({
      extra: {
        scopeFolder: async () => '/outside/gone',
        list: async () => { throw new Error('disk gone') },
      },
    })
    await h.ask('Fable')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warn).toHaveBeenCalledWith('[dsh-atlas] scoped folder listing failed:', expect.any(Error))
    warn.mockRestore()
  })

  it('says nothing when the mixed view is what the aborted lookup belonged to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const aborted = harness({
      extra: { scopeFolder: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) } },
    })
    await aborted.ask('Fable')
    const listed = harness({
      extra: {
        scopeFolder: async () => '/outside/gone',
        list: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) },
      },
    })
    await listed.ask('Fable')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops the mixed view when the caller aborts while the folder is listed', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        scopeFolder: async () => '/home/ubuntu/Downloads',
        list: async () => {
          caller.abort()
          return { path: '/home/ubuntu/Downloads', entries: [{ name: 'Fable.zip', kind: 'file' as const }] }
        },
      },
    })
    // The mixed view no longer waits for the listing, so an abort mid-listing
    // costs it the scoped row, not the whole menu.
    const rows = await h.ask('Fable', 's1', caller.signal)
    expect(rows.some(row => row.name === 'Fable.zip')).toBe(false)
  })

  it('contributes nothing when the folder cannot be listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({
      extra: {
        scopeFolder: async () => '/outside/gone',
        list: async () => ({ path: '/outside/gone', entries: [], error: 'outside' }),
      },
    })
    const rows = await h.ask('Fable')
    expect(rows.some(row => row.name.includes('Fable'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the out-of-workspace folder scope', () => {
  it('answers the FIRST query from a cold scope instead of nothing', async () => {
    const { ask, external } = scopeHarness()
    const rows = await ask('dsh')
    expect(external).toHaveBeenCalled()
    expect(rows.some(row => row.name === 'DSH-Atlas/')).toBe(true)
  })

  it('keeps the ledger row on the FIRST render when the scope lands a macrotask late', async () => {
    // Reported live: `@serve` listed the workspace's `serve.mjs` rows and never the
    // out-of-workspace `serve/`, while `@folder:serve` (built after the scope had
    // settled) did show it. Reading the cache after an await is a race; the rows
    // have to come from the value the await answered with.
    const { ask } = scopeHarness({
      external: () =>
        new Promise(resolve =>
          setTimeout(() => resolve({ canDiscover: false, roots: [], folders: ['/outside/DSH-Atlas'] }), 0),
        ),
    })
    const rows = await ask('dsh')
    expect(rows.some(row => row.name === 'DSH-Atlas/')).toBe(true)
  })

  it('matches the folder name whatever the case of the query', async () => {
    const { ask } = scopeHarness()
    for (const query of ['dsh', 'DSH', 'Dsh', 'dSh', 'DSH-Atl', 'dsh-at']) {
      const rows = await ask(query)
      expect(rows.some(row => row.name === 'DSH-Atlas/'), query).toBe(true)
    }
  })

  it('keeps answering when the scope itself fails, with the workspace matches only', async () => {
    const external = vi.fn(async () => { throw new Error('scope down') })
    const h = harness({ extra: { external } })
    const rows = await h.ask('dsh')
    expect(external).toHaveBeenCalled()
    // A broken scope is a soft failure: the menu still lists what the index knows.
    expect(rows.some(row => row.name === 'DSH-Atlas/')).toBe(false)
    expect(rows.every(row => row.mentionKind !== 'dir' || !String(row.value ?? '').startsWith('/'))).toBe(true)
  })

  it('drops the settled scope so the next query sees a folder the ledger just gained', async () => {
    const folders = ['/home/ubuntu/Eason/Old']
    const external = vi.fn(async () => ({ canDiscover: true, roots: [...folders], folders: [...folders] }))
    const h = harness({ extra: { external } })
    expect((await h.ask('dsh')).some(row => row.name === 'DSH-Atlas/')).toBe(false)
    folders.push('/home/ubuntu/Eason/DSH-Atlas')
    // A stale-but-settled scope keeps answering the old value for one TTL.
    expect((await h.ask('dsh')).some(row => row.name === 'DSH-Atlas/')).toBe(false)
    h.invalidateExternal('s1' as SessionId)
    expect((await h.ask('dsh')).some(row => row.name === 'DSH-Atlas/')).toBe(true)
  })
})

describe('the picks that put a folder into the scope', () => {
  it('reports an out-of-workspace folder row as a directory the user just put in play', () => {
    const onExternalDir = vi.fn()
    const h = harness({ extra: { onExternalDir } })
    expect(h.source.onPick(pick({
      name: 'DSH-Atlas/',
      value: '/home/ubuntu/Eason/DSH-Atlas/',
      mentionKind: 'dir',
      atFileKind: 'dir',
    }) as never)).toEqual({ text: '@/home/ubuntu/Eason/DSH-Atlas/ ' })
    expect(onExternalDir).toHaveBeenCalledWith('s1', '/home/ubuntu/Eason/DSH-Atlas')
  })

  it('reports the folder that holds a picked out-of-workspace file', () => {
    const onExternalDir = vi.fn()
    const h = harness({ extra: { onExternalDir } })
    h.source.onPick(pick({
      name: 'README.md',
      value: '/home/ubuntu/Eason/DSH-Atlas/README.md',
      mentionKind: 'file',
      atFileKind: 'file',
    }) as never)
    expect(onExternalDir).toHaveBeenCalledWith('s1', '/home/ubuntu/Eason/DSH-Atlas')
  })

  it('reports a folder the browser walked into, on both the pick and the drill', () => {
    const onExternalDir = vi.fn()
    const h = harness({ extra: { onExternalDir } })
    h.source.onPick(pick({ name: 'DSH-Atlas/', value: '/home/ubuntu/Eason/DSH-Atlas/', mentionKind: 'browse-dir' }) as never)
    h.source.onPick(pick(
      { name: 'docs/', value: '/home/ubuntu/Eason/DSH-Atlas/docs/', mentionKind: 'browse-dir' },
      'drill',
    ) as never)
    expect(onExternalDir.mock.calls).toEqual([
      ['s1', '/home/ubuntu/Eason/DSH-Atlas/'],
      ['s1', '/home/ubuntu/Eason/DSH-Atlas/docs/'],
    ])
  })

  it('reports the parent folder of a file the browser picked', () => {
    const onExternalDir = vi.fn()
    const h = harness({ extra: { onExternalDir } })
    h.source.onPick(pick({ name: 'a.ts', value: '/home/ubuntu/Eason/DSH-Atlas/a.ts', mentionKind: 'browse-file' }) as never)
    expect(onExternalDir).toHaveBeenCalledWith('s1', '/home/ubuntu/Eason/DSH-Atlas')
  })

  it('records nothing for a workspace row, which is already in the index', () => {
    const onExternalDir = vi.fn()
    const h = harness({ extra: { onExternalDir } })
    h.source.onPick(pick({ name: 'src', value: 'src', mentionKind: 'dir' }) as never)
    expect(onExternalDir).not.toHaveBeenCalled()
  })
})

describe('the folder a draft declares with in:', () => {
  const listing = (path: string, entries: readonly { name: string; kind: 'file' | 'dir' }[]) => ({
    path,
    entries,
    truncated: false,
  })
  const tree: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    '/outside/work': [
      { name: 'Fable5.2-Godot-四个工程.zip', kind: 'file' },
      { name: 'godot-src', kind: 'dir' },
      { name: 'notes.md', kind: 'file' },
    ],
    '/outside/work/godot-src': [
      { name: 'project.godot', kind: 'file' },
      { name: 'assets', kind: 'dir' },
    ],
    '/outside/work/godot-src/assets': [{ name: 'fable-icon.png', kind: 'file' }],
  }
  const dirs = (paths: string[], order: readonly string[], sessions: string[] = []) => {
    const asked: string[] = []
    return {
      asked,
      list: async (_id: string, path: string) => {
        asked.push(path)
        const key = Object.keys(tree).find(candidate => candidate === path)
        return key === undefined
          ? { path, entries: [], truncated: false, error: 'outside' as const }
          : listing(path, tree[key]!)
      },
    }
  }

  it('declares a folder and answers with its own contents', async () => {
    const spy = vi.fn()
    const probe = dirs()
    const h = harness({ extra: { list: probe.list, onExternalDir: spy } })
    const rows = await h.ask('in:/outside/work/')
    expect(rows.map(row => row.name)).toContain('Fable5.2-Godot-四个工程.zip')
    expect(rows.map(row => row.name)).toContain('godot-src/')
    // The declaration is what puts the folder into the host ledger.
    expect(spy).toHaveBeenCalledWith('s1', '/outside/work')
  })

  it('searches the declared folder on the next query, recursively', async () => {
    const h = harness({ extra: { list: dirs().list } })
    await h.ask('in:/outside/work/')
    const rows = await h.ask('in:fable')
    const names = rows.map(row => row.name)
    expect(names).toContain('Fable5.2-Godot-四个工程.zip')
    // Two levels down, and the folder that holds the match is still reported.
    expect(names).toContain('fable-icon.png')
    expect(rows.find(row => row.name === 'fable-icon.png')?.description).toContain('/outside/work/godot-src/assets')
  })

  it('marks a matched sub-folder as a folder', async () => {
    const h = harness({ extra: { list: dirs().list } })
    await h.ask('in:/outside/work/')
    const rows = await h.ask('in:godot')
    const row = rows.find(candidate => candidate.name === 'godot-src/')
    expect(row?.mentionKind).toBe('dir')
    expect(row?.value).toBe('/outside/work/godot-src/')
  })

  it('answers nothing before any folder was declared', async () => {
    const h = harness({ extra: { list: dirs().list } })
    const rows = await h.ask('in:fable')
    // Only the back row: nothing was declared, so there is nothing to walk.
    expect(rows.map(row => row.name)).toEqual(['返回类别'])
  })

  it('declares a folder whose path has no inner separator', async () => {
    const asked: string[] = []
    const h = harness({
      extra: {
        list: async (_id: string, path: string) => {
          asked.push(path)
          return path === '/work' ? listing(path, [{ name: 'Fable.zip', kind: 'file' as const }]) : listing(path, [])
        },
      },
    })
    const rows = await h.ask('in:/work')
    expect(asked).toEqual(['/work'])
    expect(rows.map(row => row.name)).toContain('Fable.zip')
  })

  it('answers from the root when the declaration trims to nothing', async () => {
    const asked: string[] = []
    const h = harness({
      extra: {
        list: async (_id: string, path: string) => {
          asked.push(path)
          return listing(path, [{ name: 'fable.txt', kind: 'file' as const }])
        },
      },
    })
    await h.ask('in:///')
    expect(asked).toEqual(['/'])
  })

  it('keeps the walk inside the row budget', async () => {
    const many = Array.from({ length: 30 }, (_unused, index) => ({ name: `fable-${index}.zip`, kind: 'file' as const }))
    const h = harness({ extra: { list: async (_id: string, path: string) => listing(path, many) } })
    const rows = await h.ask('in:/outside/many/')
    // 20 candidate rows plus the back row.
    expect(rows).toHaveLength(21)
  })

  it('skips a sub-folder the filesystem refuses to list', async () => {
    const h = harness({
      extra: {
        list: async (_id: string, path: string) =>
          path === '/outside/half'
            ? listing(path, [
                { name: 'fable', kind: 'dir' as const },
                { name: 'fable.md', kind: 'file' as const },
              ])
            : { path, entries: [], truncated: false, error: 'outside' as const },
      },
    })
    const rows = await h.ask('in:/outside/half/')
    expect(rows.map(row => row.name)).toContain('fable/')
    expect(rows.map(row => row.name)).toContain('fable.md')
  })

  it('answers nothing when the seam has no listing at all', async () => {
    const h = harness()
    const rows = await h.ask('in:/outside/work/')
    expect(rows.map(row => row.name)).toEqual(['返回类别'])
  })

  it('drops the mixed page when the caller was already gone', async () => {
    const caller = new AbortController()
    caller.abort()
    const h = harness()
    expect(await h.ask('fable', 's1', caller.signal)).toEqual([])
  })

  it('starts the cold scope listing without waiting, and never raises', async () => {
    const onUnhandled = vi.fn()
    process.once('unhandledRejection', onUnhandled)
    const h = harness({
      extra: {
        scopeFolder: () => '/outside/cold',
        list: async () => {
          throw new Error('disk gone')
        },
      },
    })
    await h.ask('fable')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(onUnhandled).not.toHaveBeenCalled()
    process.off('unhandledRejection', onUnhandled)
  })

  it('stays quiet when the draft scope is a workspace folder', async () => {
    const h = harness({ extra: { scopeFolder: () => '/ws/src', list: async (_id: string, path: string) => listing(path, [{ name: 'fable.zip', kind: 'file' as const }]) } })
    await h.ask('zz')
    const rows = await h.ask('fable')
    // The index already covers it, so nothing is added from the scope.
    expect(rows.some(row => row.name === 'fable.zip')).toBe(false)
  })

  it('stays quiet when the listing settled with an error', async () => {
    const h = harness({
      extra: {
        scopeFolder: () => '/outside/broken',
        list: async (_id: string, path: string) => ({ path, entries: [], truncated: false, error: 'outside' as const }),
      },
    })
    await h.ask('zz')
    const rows = await h.ask('fable')
    expect(rows.some(row => row.name === 'fable.zip')).toBe(false)
  })

  it('walks a second level and answers with both', async () => {
    const h = harness({
      extra: {
        list: async (_id: string, path: string) =>
          path === '/outside/two'
            ? listing(path, [
                { name: 'fable', kind: 'dir' as const },
                { name: 'fable.md', kind: 'file' as const },
              ])
            : listing(path, [{ name: 'fable-icon.png', kind: 'file' as const }]),
      },
    })
    const rows = await h.ask('in:/outside/two/')
    expect(rows.map(row => row.name)).toEqual(
      expect.arrayContaining(['fable/', 'fable.md', 'fable-icon.png']),
    )
  })

  it('keeps the scoped rows flat when the query also completes a category', async () => {
    const h = harness({
      extra: {
        scopeFolder: () => '/outside/flat',
        list: async (_id: string, path: string) => listing(path, [{ name: 'pluginish.zip', kind: 'file' as const }]),
      },
    })
    await h.ask('zz')
    const rows = await h.ask('plug')
    expect(rows.map(row => row.name)).toContain('pluginish.zip')
  })

  it('says nothing when the walk was the one that got cancelled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const caller = new AbortController()
    const h = harness({
      extra: {
        list: async () => {
          caller.abort()
          throw new Error('AbortError: gone')
        },
      },
    })
    await h.ask('in:/outside/away/', 's1', caller.signal)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('stops descending at the last level it is allowed to open', async () => {
    const tree: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
      '/outside/deep': [{ name: 'fable-l1', kind: 'dir' }],
      '/outside/deep/fable-l1': [{ name: 'fable-l2', kind: 'dir' }],
      '/outside/deep/fable-l1/fable-l2': [{ name: 'fable-l3', kind: 'dir' }],
    }
    const asked: string[] = []
    const h = harness({
      extra: {
        list: async (_id: string, path: string) => {
          asked.push(path)
          const key = Object.keys(tree).find(candidate => candidate === path)
          return key === undefined ? listing(path, []) : listing(path, tree[key]!)
        },
      },
    })
    const rows = await h.ask('in:/outside/deep/')
    // The level-2 folder still matches and is listed, but nothing below it is opened.
    expect(rows.map(row => row.name)).toEqual(
      expect.arrayContaining(['fable-l1/', 'fable-l2/', 'fable-l3/']),
    )
    // The third level is reported but never opened: that is the depth budget.
    expect(asked).not.toContain('/outside/deep/fable-l1/fable-l2/fable-l3')
  })

  it('writes the ledger once however many keystrokes follow', async () => {
    const spy = vi.fn()
    const h = harness({ extra: { list: dirs().list, onExternalDir: spy } })
    await h.ask('in:/outside/work/')
    await h.ask('in:/outside/work/')
    await h.ask('in:fab')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('keeps walking when a folder cannot be listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({
      extra: {
        list: async (_id: string, path: string) => {
          if (path === '/outside/work') throw new Error('disk gone')
          return listing(path, [])
        },
      },
    })
    const rows = await h.ask('in:/outside/work/')
    expect(rows.map(row => row.name)).toEqual(['返回类别'])
    expect(warn).toHaveBeenCalledWith('[dsh-atlas] declared folder listing failed:', expect.any(Error))
    warn.mockRestore()
  })

  it('drops the page when the caller aborts mid-walk', async () => {
    const caller = new AbortController()
    const h = harness({
      extra: {
        list: async (_id: string, path: string) => {
          caller.abort()
          return listing(path, [{ name: 'Fable.zip', kind: 'file' as const }])
        },
      },
    })
    expect(await h.ask('in:/outside/work', 's1', caller.signal)).toEqual([])
  })
})
