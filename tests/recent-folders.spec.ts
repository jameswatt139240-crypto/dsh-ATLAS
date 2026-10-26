/**
 * Specs for the recent/neighbouring folder candidates.
 *
 * The load-bearing claim is the ORDER, because the menu is bounded: the whole
 * point of ranking is that the eight rows a user sees are the eight that
 * mattered, so a tier that silently sorts wrong is the feature failing while
 * every row still renders.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RECENT_FOLDER_LIMIT,
  ledgerPath,
  parseWorkspaces,
  rankRecentFolders,
  readWorkspaces,
  type RecentFolder,
} from '../src/recent-folders.ts'

const folder = (path: string): RecentFolder => ({ path, name: path.slice(path.lastIndexOf('/') + 1), reason: 'recent' })

/** The real shape of the Harness ledger: a versioned store with named tables. */
function ledger(paths: readonly string[]): string {
  return JSON.stringify({
    version: 2,
    tables: {
      workspaces: Object.fromEntries(paths.map((path, index) => [
        `id-${String(index)}`,
        { path: path.replace(/\//gu, '\\'), title: 'x', sessionIds: ['a'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      ])),
    },
  })
}

describe('parseWorkspaces', () => {
  it('reads the workspace table and canonicalises each path', () => {
    expect(parseWorkspaces(ledger(['E:/Eason/Rust/DSH']))).toEqual([
      { path: 'E:/Eason/Rust/DSH', name: 'DSH', reason: 'recent' },
    ])
  })

  it('answers no candidates for a document that is not JSON', () => {
    expect(parseWorkspaces('{ not json')).toEqual([])
  })

  it('answers no candidates when the workspace table is absent', () => {
    expect(parseWorkspaces(JSON.stringify({ version: 2, tables: {} }))).toEqual([])
  })

  it('answers no candidates when the table is not an object', () => {
    expect(parseWorkspaces(JSON.stringify({ tables: { workspaces: 7 } }))).toEqual([])
  })

  it('answers no candidates for a JSON scalar document', () => {
    expect(parseWorkspaces('7')).toEqual([])
  })

  it('drops a row with no usable path instead of offering a folder that browses nowhere', () => {
    const text = JSON.stringify({ tables: { workspaces: {
      a: { path: 'E:/keep' },
      b: { path: '' },
      c: { path: 42 },
      d: null,
      e: { title: 'no path at all' },
    } } })
    expect(parseWorkspaces(text).map(row => row.path)).toEqual(['E:/keep'])
  })
})

describe('ledgerPath', () => {
  it('honours DSH_HOME so a test never touches the real home', () => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = 'D:/somewhere'
    try {
      expect(ledgerPath()).toBe(join('D:/somewhere', 'storages', 'workspace.json'))
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('falls back to the account home when DSH_HOME is empty or unset', () => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = ''
    try {
      expect(ledgerPath().endsWith(join('storages', 'workspace.json'))).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })
})

describe('readWorkspaces', () => {
  it('reads a real ledger file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-recent-'))
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      await mkdir(join(dir, 'storages'), { recursive: true })
      await writeFile(join(dir, 'storages', 'workspace.json'), ledger(['E:/A', 'E:/B']), { encoding: 'utf8' })
      const rows = await readWorkspaces(new AbortController().signal)
      expect(rows.map(row => row.path)).toEqual(['E:/A', 'E:/B'])
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('answers no candidates when there is no ledger at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-recent-none-'))
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = join(dir, 'missing')
    try {
      expect(await readWorkspaces(new AbortController().signal)).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('aborts rather than reading a ledger the caller no longer wants', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readWorkspaces(controller.signal)).rejects.toThrow()
  })
})

describe('rankRecentFolders', () => {
  const cwd = 'E:/Eason/Rust/DSH/dsh-atlas'

  it('orders siblings above family above unrelated, and drops the current workspace', () => {
    const all = [
      folder('E:/Eason/Rust/DSH/dsh-atlas'),
      folder('E:/Elsewhere/atlas-tools'),
      folder('E:/Eason/Rust/DSH/dsh-arcade'),
      folder('E:/Eason/Rust/DSH'),
      folder('E:/Far/Away'),
    ]
    expect(rankRecentFolders(all, cwd).map(row => [row.name, row.reason])).toEqual([
      ['dsh-arcade', 'sibling'],
      ['DSH', 'parent'],
      ['atlas-tools', 'family'],
      ['Away', 'recent'],
    ])
  })

  it('recognises an enclosing project as a child even when it is not the immediate parent', () => {
    const ranked = rankRecentFolders([folder('E:/Eason/Rust')], cwd)
    expect(ranked.map(row => row.reason)).toEqual(['child'])
  })

  it('sorts a child-tier folder by its tier rather than by arrival order', () => {
    const ranked = rankRecentFolders([folder('E:/Far/Away'), folder('E:/Eason/Rust')], cwd)
    expect(ranked.map(row => [row.name, row.reason])).toEqual([
      ['Rust', 'child'],
      ['Away', 'recent'],
    ])
  })

  it('treats everything as merely recent when the session has no workspace', () => {
    const ranked = rankRecentFolders([folder('E:/A'), folder('E:/B')], '')
    expect(ranked.map(row => row.reason)).toEqual(['recent', 'recent'])
  })

  it('does not let a common path prefix claim the parent tier', () => {
    // `E:/Eason/Rust/DSH-extra` shares the TEXT but is not an ancestor.
    const ranked = rankRecentFolders([folder('E:/Eason/Rust/DSH-extra')], cwd)
    expect(ranked.map(row => row.reason)).toEqual(['family'])
  })

  it('offers each folder once, keeping its best-ranked tier', () => {
    const ranked = rankRecentFolders([folder('E:/Eason/Rust/DSH/dsh-arcade'), folder('E:/Eason/Rust/DSH/dsh-arcade')], cwd)
    expect(ranked).toHaveLength(1)
  })

  it('bounds the list so the menu cannot grow without limit', () => {
    const many = Array.from({ length: 30 }, (_unused, index) => folder(`E:/Far/Project${String(index)}`))
    expect(rankRecentFolders(many, cwd)).toHaveLength(RECENT_FOLDER_LIMIT)
  })

  it('ignores name fragments too short to relate two projects', () => {
    // `dsh` alone is a family token; `at` and `as` are noise and must not relate them.
    const ranked = rankRecentFolders([folder('E:/Far/at')], cwd)
    expect(ranked.map(row => row.reason)).toEqual(['recent'])
  })

  it('reads a bare drive root without inventing a parent', () => {
    const ranked = rankRecentFolders([folder('E:/')], 'E:/')
    expect(ranked).toEqual([])
  })
})
