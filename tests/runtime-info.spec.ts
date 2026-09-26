/**
 * The seam's version gate input: an unreadable or versionless Harness manifest
 * must yield `undefined`, never a guess — an unproven provider has to keep
 * reading as unproven. The anchor chain is covered here too, because a wrong
 * anchor is how a correctly declared `testedOn` silently reads as unverified.
 */
import { describe, expect, it } from 'vitest'
import { readDshVersion, readFirstAvailable, versionAnchors } from '../src/runtime-info.ts'

describe('versionAnchors', () => {
  it('tries the process entry first, then this module', () => {
    expect(versionAnchors('/cli/bin.js', 'file:///plugin/index.js'))
      .toEqual(['/cli/bin.js', 'file:///plugin/index.js'])
  })

  it('falls back to this module alone without a process entry', () => {
    expect(versionAnchors(undefined, 'file:///plugin/index.js')).toEqual(['file:///plugin/index.js'])
    expect(versionAnchors('', 'file:///plugin/index.js')).toEqual(['file:///plugin/index.js'])
  })
})

describe('readFirstAvailable', () => {
  it('returns the first anchor that has a manifest', () => {
    const tried: string[] = []
    const raw = readFirstAvailable(['entry', 'self'], (anchor) => {
      tried.push(anchor)
      if (anchor === 'entry') throw new Error('not resolvable from the CLI')
      return '{"version":"0.1.5-rc.1"}'
    })
    expect(raw).toBe('{"version":"0.1.5-rc.1"}')
    expect(tried).toEqual(['entry', 'self'])
  })

  it('rethrows the last failure when no anchor has one', () => {
    expect(() => readFirstAvailable(['entry', 'self'], (anchor) => {
      throw new Error(`no manifest at ${anchor}`)
    })).toThrow('no manifest at self')
  })
})

describe('readDshVersion', () => {
  it('reads the version out of the manifest it is given', () => {
    expect(readDshVersion(() => '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.1"}'))
      .toBe('0.1.5-rc.1')
  })

  it('returns undefined for an unreadable manifest', () => {
    expect(readDshVersion(() => { throw new Error('not resolvable from here') })).toBeUndefined()
  })

  it('returns undefined for malformed, non-object, or versionless manifests', () => {
    expect(readDshVersion(() => 'not json')).toBeUndefined()
    expect(readDshVersion(() => 'null')).toBeUndefined()
    expect(readDshVersion(() => '"just a string"')).toBeUndefined()
    expect(readDshVersion(() => '{}')).toBeUndefined()
    expect(readDshVersion(() => '{"version":""}')).toBeUndefined()
    expect(readDshVersion(() => '{"version":42}')).toBeUndefined()
  })

  it('never fabricates a version through the real anchor chain', () => {
    // Whatever the anchors this install can or cannot resolve, the answer is
    // either a nonempty version or undefined — never an invented one.
    const version = readDshVersion()
    expect(version === undefined || version.length > 0).toBe(true)
  })
})
