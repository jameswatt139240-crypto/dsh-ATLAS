/** Filter normalization shared by the Host and browser settings surface. */
import { describe, expect, it } from 'vitest'
import {
  MAX_RECENT_FILES,
  MAX_USAGE_ENTRIES,
  compileIgnoreRules,
  effectiveIgnoreFiles,
  ignoreRuleKey,
  ignoreFilesSettingsKey,
  normalizeIgnoreFiles,
  normalizeIgnoreRule,
  normalizeUsage,
  normalizeWorkspaceIgnoreFiles,
  normalizeWorkspaceRecentFiles,
  recentFilesFor,
  recordRecentFile,
  recordUsage,
  workspaceIgnoreFilesFor,
  workspacePathKey,
} from '../src/defaults.ts'
import type { AtFileSettings } from '../src/contract.ts'

function settings(over: Partial<AtFileSettings> = {}): AtFileSettings {
  return {
    enabled: true,
    ignoreFiles: [],
    workspaceIgnoreFiles: [],
    ...over,
  }
}

describe('workspace file filters', () => {
  it('normalizes legacy and structured rules while preserving their wire shape', () => {
    expect(normalizeIgnoreFiles([
      ' Legacy.tmp ',
      'legacy.TMP',
      { kind: 'exact', pattern: 'Case.tmp', caseSensitive: true },
      { kind: 'regex', pattern: ' \\.map$ ', caseSensitive: false },
      { kind: 'regex', pattern: '\\.map$', caseSensitive: false },
      '',
      { kind: 'exact', pattern: ' ', caseSensitive: false },
    ])).toEqual([
      'Legacy.tmp',
      { kind: 'exact', pattern: 'Case.tmp', caseSensitive: true },
      { kind: 'regex', pattern: '\\.map$', caseSensitive: false },
    ])
    expect(normalizeIgnoreRule('')).toBeUndefined()
    expect(ignoreRuleKey('')).toBe('')
    expect(compileIgnoreRules(['one.tmp'])).toEqual([
      { kind: 'exact', pattern: 'one.tmp', caseSensitive: false },
    ])
  })

  it('rejects invalid regular expressions during normalization', () => {
    expect(() => normalizeIgnoreFiles([{ kind: 'regex', pattern: '[', caseSensitive: false }]))
      .toThrow(/Invalid regular expression/)
  })

  it('normalizes Windows separators, drive casing, and trailing slashes', () => {
    expect(workspacePathKey('C:\\Users\\Liang\\Project\\')).toBe('c:/users/liang/project')
    expect(workspacePathKey('c:/users/liang/project')).toBe('c:/users/liang/project')
    expect(workspacePathKey('C:/')).toBe('c:/')
    expect(workspacePathKey('\\\\Server\\Share\\Project\\')).toBe('//server/share/project')
  })

  it('preserves POSIX case while removing trailing separators', () => {
    expect(workspacePathKey('/Users/Margoo/Project/')).toBe('/Users/Margoo/Project')
    expect(workspacePathKey('/users/margoo/project')).toBe('/users/margoo/project')
    expect(workspacePathKey('/')).toBe('/')
  })

  it('drops empty workspace rows and merges duplicate canonical paths', () => {
    expect(normalizeWorkspaceIgnoreFiles([
      { workspace: '', ignoreFiles: ['unused.tmp'] },
      { workspace: 'C:\\Work\\App', ignoreFiles: ['one.tmp', 'ONE.TMP'] },
      { workspace: 'c:/work/app/', ignoreFiles: ['two.tmp'] },
    ])).toEqual([
      { workspace: 'C:\\Work\\App', ignoreFiles: ['one.tmp', 'two.tmp'] },
    ])
  })

  it('returns only rules attached to the addressed workspace', () => {
    const entries = [
      { workspace: '/work/one', ignoreFiles: ['one.tmp'] },
      { workspace: '/work/two', ignoreFiles: ['two.tmp'] },
    ]
    expect(workspaceIgnoreFilesFor(entries, '/work/two/')).toEqual(['two.tmp'])
    expect(workspaceIgnoreFilesFor(entries, '/work/three')).toEqual([])
  })

  it('combines global and local rules without case-insensitive duplicates', () => {
    expect(effectiveIgnoreFiles(settings({
      ignoreFiles: ['global.tmp', 'shared.tmp'],
      workspaceIgnoreFiles: [{ workspace: '/work/one', ignoreFiles: ['SHARED.TMP', 'local.tmp'] }],
    }), '/work/one')).toEqual(['global.tmp', 'shared.tmp', 'local.tmp'])
    const legacy = { enabled: true, ignoreFiles: ['legacy.tmp'] } as AtFileSettings
    expect(effectiveIgnoreFiles(legacy, '/work/one')).toEqual(['legacy.tmp'])
  })

  it('builds an order-independent cache key covering every scope', () => {
    const first = settings({
      ignoreFiles: ['B.tmp', 'a.tmp'],
      workspaceIgnoreFiles: [
        { workspace: '/work/two', ignoreFiles: ['z.tmp'] },
        { workspace: '/work/one', ignoreFiles: ['B.tmp', 'a.tmp'] },
      ],
    })
    const reordered = settings({
      ignoreFiles: ['A.TMP', 'b.tmp'],
      workspaceIgnoreFiles: [
        { workspace: '/work/one', ignoreFiles: ['A.tmp', 'b.tmp'] },
        { workspace: '/work/two', ignoreFiles: ['Z.TMP'] },
      ],
    })
    expect(ignoreFilesSettingsKey(first)).toBe(ignoreFilesSettingsKey(reordered))
    expect(ignoreFilesSettingsKey(first)).not.toBe(ignoreFilesSettingsKey(settings({
      ...reordered,
      workspaceIgnoreFiles: [{ workspace: '/work/one', ignoreFiles: ['changed.tmp'] }],
    })))
    expect(ignoreFilesSettingsKey({ enabled: true, ignoreFiles: ['legacy.tmp'] } as AtFileSettings))
      .toBe(ignoreFilesSettingsKey(settings({ ignoreFiles: ['legacy.tmp'] })))
    expect(ignoreFilesSettingsKey(settings({
      ignoreFiles: [{ kind: 'regex', pattern: '\\.TS$', caseSensitive: true }],
    }))).not.toBe(ignoreFilesSettingsKey(settings({
      ignoreFiles: [{ kind: 'regex', pattern: '\\.TS$', caseSensitive: false }],
    })))
  })
})

describe('recent files per workspace', () => {
  it('drops empty rows, duplicate workspaces, blank paths and duplicates, and caps the list', () => {
    const rows = normalizeWorkspaceRecentFiles([
      { workspace: '', files: ['a'] },
      { workspace: '/w', files: [' a ', 'a', '', 'b', ...Array.from({ length: MAX_RECENT_FILES + 5 }, (_, index) => `f${index}`)] },
      // A second row for the same canonical workspace is a duplicate, not a new list.
      { workspace: '/w/', files: ['z'] },
      { workspace: '/empty', files: ['  '] },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.workspace).toBe('/w')
    expect(rows[0]!.files[0]).toBe('a')
    expect(rows[0]!.files[1]).toBe('b')
    expect(rows[0]!.files).toHaveLength(MAX_RECENT_FILES)
  })

  it('reads one workspace through the canonical path, and nothing for a workspace with no row', () => {
    const settings = { recentFiles: [{ workspace: '/w/', files: ['a'] }] } as unknown as AtFileSettings
    expect(recentFilesFor(settings, '/W')).toEqual([])
    expect(recentFilesFor(settings, '/w')).toEqual(['a'])
    expect(recentFilesFor({} as AtFileSettings, '/w')).toEqual([])
  })

  it('moves a re-referenced file to the front, keeps the cap, and appends a new workspace row', () => {
    const before = { recentFiles: [{ workspace: '/w', files: ['a', 'b'] }] } as unknown as AtFileSettings
    expect(recordRecentFile(before, '/w', 'b')).toEqual([{ workspace: '/w', files: ['b', 'a'] }])
    // A blank reference changes nothing at all.
    expect(recordRecentFile(before, '/w', '   ')).toEqual([{ workspace: '/w', files: ['a', 'b'] }])
    expect(recordRecentFile(before, '/other', ' c ')).toEqual([
      { workspace: '/w', files: ['a', 'b'] },
      { workspace: '/other', files: ['c'] },
    ])
    const full = { recentFiles: [{ workspace: '/w', files: Array.from({ length: MAX_RECENT_FILES }, (_, index) => `f${index}`) }] } as unknown as AtFileSettings
    expect(recordRecentFile(full, '/w', 'fresh')[0]!.files).toHaveLength(MAX_RECENT_FILES)
    expect(recordRecentFile(full, '/w', 'fresh')[0]!.files[0]).toBe('fresh')
  })
})

describe('cross-category usage counters', () => {
  it('keeps the highest count per key, ignores blank keys and empty rows, and sorts by count then recency', () => {
    const rows = normalizeUsage([
      { key: ' file:a ', count: 1, at: 10 },
      { key: '', count: 5, at: 1 },
      { key: 'file:a', count: 3, at: 20 },
      { key: 'file:b', count: 0, at: 30 },
      { key: 'file:c', count: 3, at: 40 },
    ] as never)
    expect(rows).toEqual([
      { key: 'file:c', count: 3, at: 40 },
      { key: 'file:a', count: 3, at: 20 },
    ])
  })

  it('caps the table so one session cannot grow it without bound', () => {
    const rows = normalizeUsage(Array.from({ length: MAX_USAGE_ENTRIES + 10 }, (_, index) => ({ key: `file:f${index}`, count: 1, at: index })) as never)
    expect(rows).toHaveLength(MAX_USAGE_ENTRIES)
  })

  it('counts one more pick, moves the pick to the front, and ignores a blank key', () => {
    const settings = { usage: [{ key: 'file:a', count: 2, at: 5 }, { key: 'file:b', count: 1, at: 6 }] } as unknown as AtFileSettings
    expect(recordUsage(settings, 'file:b', 99)).toEqual([
      { key: 'file:b', count: 2, at: 99 },
      { key: 'file:a', count: 2, at: 5 },
    ])
    expect(recordUsage(settings, '  ', 99)).toHaveLength(2)
    expect(recordUsage({} as AtFileSettings, 'file:new', 7)).toEqual([{ key: 'file:new', count: 1, at: 7 }])
  })
})
