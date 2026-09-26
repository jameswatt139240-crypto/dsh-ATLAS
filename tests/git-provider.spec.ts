/**
 * The built-in `@git` provider's menu half: it must stay cheap, stay quiet when
 * the Host cannot answer, and never offer a row the `@atlas:` token cannot carry.
 */
import { describe, expect, it, vi } from 'vitest'
import { createGitMenuProvider, GIT_ITEM_LIMIT, gitChangeItem } from '../src/client/git-provider.ts'
import type { GitChange } from '../src/contract.ts'

const SESSION = 's1' as never

/** One provider bound to a fixed change list. */
function providerOver(changes: readonly GitChange[]) {
  return createGitMenuProvider({ changes: async () => changes, open: () => {} })
}

const context = { sessionId: SESSION, signal: new AbortController().signal }

describe('gitChangeItem', () => {
  it('shows the diffstat and the status letter', () => {
    expect(gitChangeItem({ path: 'src/a.ts', status: 'M', added: 12, removed: 3 })).toEqual({
      id: 'src/a.ts',
      title: 'src/a.ts',
      preview: '+12 \u22123',
      badge: 'M',
    })
  })

  it('marks an untracked path without inventing a diffstat', () => {
    expect(gitChangeItem({ path: 'b.txt', status: '??' })).toEqual({
      id: 'b.txt',
      title: 'b.txt',
      preview: undefined,
      badge: '\u2022',
    })
  })
})

describe('createGitMenuProvider', () => {
  it('declares the same governance facts as its Host half', () => {
    expect(providerOver([])).toMatchObject({
      id: 'git',
      display: 'Git',
      scopes: ['process:git'],
      testedOn: ['0.1.5-rc.1'],
    })
  })

  it('lists every change when the query is still just the prefix', async () => {
    const provider = providerOver([
      { path: 'src/a.ts', status: 'M' },
      { path: 'README.md', status: '??' },
    ])
    expect((await provider.list!('', context)).map(item => item.id)).toEqual(['src/a.ts', 'README.md'])
  })

  it('filters by substring, ignoring case', async () => {
    const provider = providerOver([
      { path: 'src/a.ts', status: 'M' },
      { path: 'docs/b.md', status: 'M' },
    ])
    expect((await provider.list!('DOCS', context)).map(item => item.id)).toEqual(['docs/b.md'])
  })

  it('drops a path the @atlas: token cannot carry', async () => {
    const provider = providerOver([
      { path: 'with space.ts', status: 'M' },
      { path: 'plain.ts', status: 'M' },
    ])
    expect((await provider.list!('', context)).map(item => item.id)).toEqual(['plain.ts'])
  })

  it('caps the list so the menu stays a menu', async () => {
    const many = Array.from({ length: GIT_ITEM_LIMIT + 10 }, (_value, index) => ({
      path: `f${index}.ts`,
      status: 'M',
    }))
    expect(await providerOver(many).list!('', context)).toHaveLength(GIT_ITEM_LIMIT)
  })

  it('offers nothing, loudly, when the Host cannot answer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = createGitMenuProvider({ changes: async () => { throw new Error('no remote') }, open: () => {} })
      expect(await provider.list!('', context)).toEqual([])
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('stays quiet when the lookup was superseded, not failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const controller = new AbortController()
      const provider = createGitMenuProvider({
        changes: async () => { throw new Error('gateway/cancelled: Remote invocation was aborted') },
        open: () => {},
      })
      controller.abort()
      // The menu re-asks on every keystroke and aborts the previous call: that is
      // the menu working, so it earns neither a line nor an error row.
      await expect(provider.list!('', { sessionId: SESSION, signal: controller.signal })).resolves.toEqual([])
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('opens one of its own items through the viewer bridge', () => {
    const open = vi.fn()
    const provider = createGitMenuProvider({ changes: async () => [], open })
    // A git item IS a workspace path, and this provider is the one saying so.
    provider.open!('.dsh-atlas-git-smoke.md', context)
    expect(open).toHaveBeenCalledWith(SESSION, '.dsh-atlas-git-smoke.md')
  })

  it('passes the viewer outcome through, so a gone path reads stale', () => {
    const provider = createGitMenuProvider({ changes: async () => [], open: () => 'gone' })
    expect(provider.open!('x.ts', context)).toBe('gone')
  })
})
