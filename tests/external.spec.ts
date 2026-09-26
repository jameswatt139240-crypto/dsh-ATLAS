/**
 * Out-of-workspace references: the access gate and the durable ledger behind it.
 *
 * The framework does not forbid external paths (its file sandbox fences writes
 * only), so this rule is the plugin's own and its tests are the contract: full
 * access may discover anything, a narrower mode may only use what the ledger
 * already holds, and a path is never treated as inside a directory it merely
 * shares a name prefix with.
 */
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_ADDING_MODE,
  NO_EXTERNAL_DISCOVERY,
  allowsExternal,
  externalAccess,
  externalPath,
  isUnder,
} from '../src/external.ts'
import {
  MAX_EXTERNAL_REFS,
  MAX_EXTERNAL_WORKSPACES,
  externalKnownFor,
  externalLedgerFor,
  externalRootsFor,
  normalizeExternalRefs,
  recordExternalRef,
} from '../src/defaults.ts'
import type { AtFileSettings, ExternalRef } from '../src/contract.ts'

const settings = (refs?: readonly ExternalRef[]): AtFileSettings => ({
  enabled: true,
  ignoreFiles: [],
  workspaceIgnoreFiles: [],
  ...(refs === undefined ? {} : { externalRefs: refs }),
}) as AtFileSettings

const ref = (path: string, kind: 'file' | 'dir' = 'dir', extra: Partial<ExternalRef> = {}): ExternalRef => ({
  path, kind, count: 1, lastUsedAt: 1_000, ...extra,
})

describe('external access', () => {
  it('lets only the full-access mode discover new external paths', () => {
    expect(EXTERNAL_ADDING_MODE).toBe('danger-full-access')
    expect(externalAccess('danger-full-access', [])).toEqual({ canDiscover: true, roots: [], known: [] })
    // Every other mode — including an unknown/absent one — is ledger-only.
    for (const mode of ['read-only', 'workspace-write', 'something-else', undefined]) {
      expect(externalAccess(mode, ['E:/outside']).canDiscover).toBe(false)
    }
    expect(NO_EXTERNAL_DISCOVERY).toEqual({ canDiscover: false, roots: [], known: [] })
  })

  it('allows any path under full access and only ledger entries under a narrow mode', () => {
    const full = externalAccess('danger-full-access', [])
    expect(allowsExternal(full, 'E:/anything/at/all.ts')).toBe(true)

    const narrow = externalAccess('workspace-write', ['E:/outsidedir/Rust/DSH/deepseek-harness'], ['E:/notes/todo.md'])
    // The root itself, anything below it, in either separator spelling.
    expect(allowsExternal(narrow, 'E:/outsidedir/Rust/DSH/deepseek-harness')).toBe(true)
    expect(allowsExternal(narrow, 'E:\\outsidedir\\Rust\\DSH\\deepseek-harness\\packages\\a.ts')).toBe(true)
    // Case-insensitive on a drive-letter path (the ledger key is canonical).
    expect(allowsExternal(narrow, 'e:/outsidedir/rust/dsh/deepseek-harness/packages/a.ts')).toBe(true)
    // A path the ledger holds EXACTLY is allowed even though it is a file with no
    // directory of its own — "窄模式只放行账本里已有的外域" includes the files.
    expect(allowsExternal(narrow, 'E:/notes/todo.md')).toBe(true)
    expect(allowsExternal(narrow, 'E:/notes')).toBe(false)
    // A sibling that merely shares a name prefix is NOT inside.
    expect(allowsExternal(narrow, 'E:/outsidedir/Rust/DSH/deepseek-harness-extra/a.ts')).toBe(false)
    expect(allowsExternal(narrow, 'E:/outsidedir/Rust/DSH/other/a.ts')).toBe(false)
    // Nothing at all without a ledger.
    expect(allowsExternal(NO_EXTERNAL_DISCOVERY, 'E:/anything.ts')).toBe(false)
  })

  it('compares directories by canonical key with a separator boundary', () => {
    expect(isUnder('E:/a/b', 'E:/a/b')).toBe(true)
    expect(isUnder('E:/a/b/', 'E:/a/b/c.ts')).toBe(true)
    expect(isUnder('E:/a/b', 'E:/a/bc')).toBe(false)
    expect(isUnder('E:/a/b', 'E:/a')).toBe(false)
    // Empty inputs never match, so a blank ledger row cannot allow everything.
    expect(isUnder('', 'E:/a')).toBe(false)
    expect(isUnder('E:/a', '')).toBe(false)
  })

  it('spells an external path the way tokens and the ledger carry it', () => {
    expect(externalPath('E:\\outsidedir\\Rust\\DSH\\a.ts')).toBe('E:/outsidedir/Rust/DSH/a.ts')
    expect(externalPath('E:/outsidedir/Rust/DSH/a.ts')).toBe('E:/outsidedir/Rust/DSH/a.ts')
  })
})

describe('external ledger', () => {
  it('normalizes: drops blanks, deduplicates by canonical key, newest first', () => {
    const rows = normalizeExternalRefs([
      ref('E:\\outsidedir\\Rust\\DSH\\deepseek-harness\\', 'dir', { count: 1, lastUsedAt: 10 }),
      ref('E:/outsidedir/Rust/DSH/other', 'file', { count: 2, lastUsedAt: 30 }),
      ref('   ', 'file', { count: 9, lastUsedAt: 99 }),
      ref('E:/outsidedir/Rust/DSH/deepseek-harness', 'file', { count: 4, lastUsedAt: 20 }),
    ])
    expect(rows.map(row => row.path)).toEqual([
      'E:/outsidedir/Rust/DSH/other',
      'E:/outsidedir/Rust/DSH/deepseek-harness',
    ])
    // The duplicate merged: counts add up, the newest use wins, and a directory
    // stays a directory (only directories can become search roots).
    expect(rows[1]).toMatchObject({ kind: 'dir', count: 5, lastUsedAt: 20 })
    expect(normalizeExternalRefs(undefined)).toEqual([])
  })

  it('records a use: counts it, moves it to the front, remembers the workspace', () => {
    const first = recordExternalRef(settings(), 'E:/outside', 'dir', 'E:/ws-a', 5_000)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ path: 'E:/outside', kind: 'dir', count: 1, lastUsedAt: 5_000, workspaces: ['E:/ws-a'] })

    const twice = recordExternalRef(settings(first), 'E:/outside', 'dir', 'E:/ws-b', 6_000)
    expect(twice[0]).toMatchObject({ count: 2, lastUsedAt: 6_000, workspaces: ['E:/ws-b', 'E:/ws-a'] })
    // The same workspace is never listed twice, and the list is bounded.
    const again = recordExternalRef(settings(twice), 'E:/outside', 'dir', 'E:/ws-a', 7_000)
    expect(again[0]!.workspaces).toEqual(['E:/ws-a', 'E:/ws-b'])
    const many = Array.from({ length: MAX_EXTERNAL_WORKSPACES + 4 }, (_unused, index) => `E:/ws-${String(index)}`)
      .reduce((current, workspace, index) => recordExternalRef(settings(current), 'E:/outside', 'dir', workspace, 8_000 + index), again)
    expect(many[0]!.workspaces).toHaveLength(MAX_EXTERNAL_WORKSPACES)

    // A blank path is not a reference: the ledger is returned unchanged.
    expect(recordExternalRef(settings(first), '   ', 'file', 'E:/ws-a', 9_000)).toHaveLength(1)
    // A directory wins over a file for the same path.
    const upgraded = recordExternalRef(settings([ref('E:/x', 'file')]), 'E:/x', 'dir', 'E:/ws-a', 9_500)
    expect(upgraded[0]!.kind).toBe('dir')
  })

  it('bounds the ledger by the plugin maximum', () => {
    const rows = Array.from({ length: MAX_EXTERNAL_REFS + 20 }, (_unused, index) =>
      ref(`E:/dir-${String(index)}`, 'dir', { lastUsedAt: index }))
    const normalized = normalizeExternalRefs(rows)
    expect(normalized).toHaveLength(MAX_EXTERNAL_REFS)
    // The most recently used survive.
    expect(normalized[0]!.path).toBe(`E:/dir-${String(MAX_EXTERNAL_REFS + 19)}`)
  })

  it('offers this workspace\'s directories first, then the rest of the ledger', () => {
    const rows = [
      ref('E:/mine', 'dir', { lastUsedAt: 3, workspaces: ['E:/ws-a'] }),
      ref('E:/other', 'dir', { lastUsedAt: 2, workspaces: ['E:/ws-b'] }),
      ref('E:/loose', 'dir', { lastUsedAt: 1 }),
      ref('E:/a-file.ts', 'file', { lastUsedAt: 9, workspaces: ['E:/ws-a'] }),
    ]
    // Files are never roots; the workspace's own directory leads, the rest
    // follows in ledger order (most recently used first).
    expect(externalRootsFor(settings(rows), 'E:\\WS-A\\')).toEqual(['E:/mine', 'E:/other', 'E:/loose'])
    // "Known" keeps the files too (they may be referenced exactly), and splits
    // this workspace's entries from the rest.
    expect(externalKnownFor(settings(rows), 'E:/ws-a')).toEqual([
      'E:/a-file.ts',
      'E:/mine',
      'E:/other',
      'E:/loose',
    ])
    expect(externalLedgerFor(settings(rows), 'E:/ws-a')).toEqual({
      roots: ['E:/mine', 'E:/other', 'E:/loose'],
      known: ['E:/a-file.ts', 'E:/mine', 'E:/other', 'E:/loose'],
    })
    expect(externalRootsFor(settings(), 'E:/ws-a')).toEqual([])
    expect(externalKnownFor(settings(), 'E:/ws-a')).toEqual([])
  })
})
