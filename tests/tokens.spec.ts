/** The shared `@` token grammar: path plus an optional `:start[-end]` line range. */
import { describe, expect, it } from 'vitest'
import { lineRangeLabel, splitLineRange } from '../src/tokens.ts'

describe('splitLineRange', () => {
  it('keeps a plain path when no range follows', () => {
    expect(splitLineRange('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(splitLineRange('docs/spec.pdf')).toEqual({ path: 'docs/spec.pdf' })
  })

  it('parses a range and a single line', () => {
    expect(splitLineRange('src/a.ts:12-40')).toEqual({ path: 'src/a.ts', lines: { start: 12, end: 40 } })
    expect(splitLineRange('src/a.ts:7')).toEqual({ path: 'src/a.ts', lines: { start: 7, end: 7 } })
  })

  it('normalizes a reversed range', () => {
    expect(splitLineRange('src/a.ts:40-12')).toEqual({ path: 'src/a.ts', lines: { start: 12, end: 40 } })
  })

  it('keeps colon-bearing tokens that are not ranges as plain paths', () => {
    // A Windows drive letter, category prefixes, and version-like suffixes must
    // all survive untouched: only `:digits[-digits]` at the very end is a range.
    expect(splitLineRange('C:\\src\\a.ts')).toEqual({ path: 'C:\\src\\a.ts' })
    expect(splitLineRange('file:src')).toEqual({ path: 'file:src' })
    expect(splitLineRange('notes:v2')).toEqual({ path: 'notes:v2' })
    expect(splitLineRange('src/a.ts:0')).toEqual({ path: 'src/a.ts:0' })
    expect(splitLineRange('src/a.ts:12-')).toEqual({ path: 'src/a.ts:12-' })
    expect(splitLineRange('src/a.ts:-40')).toEqual({ path: 'src/a.ts:-40' })
    expect(splitLineRange(':12-40')).toEqual({ path: ':12-40' })
  })

  it('renders the wire label used by the draft token and the injected attribute', () => {
    expect(lineRangeLabel({ start: 12, end: 40 })).toBe('12-40')
    expect(lineRangeLabel({ start: 7, end: 7 })).toBe('7-7')
  })
})
