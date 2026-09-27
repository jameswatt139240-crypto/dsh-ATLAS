// @vitest-environment jsdom
/**
 * Session-reference click-through rules.
 *
 * The two shapes a session mention leaves behind are pinned here against the
 * REAL payloads measured in the live GUI: `session-syw-v016-0001` encodes to
 * `InNlc3Npb24tc3l3LXYwMTYtMDAwMSI`, which is what the session log and the
 * composer both carried. The bare-label rule is pinned as hard as the wire form,
 * because promoting a label that also names a workspace file would hijack a
 * file reference the user actually made.
 */
import { describe, expect, it, vi } from 'vitest'
import { decodeSessionUri, resolveSessionLink, type SessionLinkDeps } from '../src/client/session-link.ts'

/** The live payload, spelled exactly as the Harness wrote it. */
const LIVE_URI = 'dsh-session:InNlc3Npb24tc3l3LXYwMTYtMDAwMSI'
const LIVE_ID = 'session-syw-v016-0001'

/** A lookup that answers one label, like the plugin's `ctx.sessions.list` reader. */
const deps = (one?: string): SessionLinkDeps => ({ matchLabel: () => one })

describe('decodeSessionUri', () => {
  it('decodes the canonical base64url payload the host writes', () => {
    expect(decodeSessionUri(LIVE_URI)).toBe(LIVE_ID)
    expect(decodeSessionUri(`dsh-session:${encode(LIVE_ID)}`)).toBe(LIVE_ID)
  })

  it('round-trips an id with characters that survive JSON, not paths', () => {
    for (const id of ['session-a', '会话-1', 'a b', 'x/y', 'ünïcode-✓']) {
      expect(decodeSessionUri(`dsh-session:${encode(id)}`)).toBe(id)
    }
  })

  it('refuses everything that is not one canonical session address', () => {
    expect(decodeSessionUri('')).toBeUndefined()
    expect(decodeSessionUri('dsh-session:')).toBeUndefined()
    expect(decodeSessionUri('dsh-session:%%%')).toBeUndefined()
    expect(decodeSessionUri('dsh-session:abc')).toBeUndefined()
    // Valid base64url, but the payload is not a JSON string.
    expect(decodeSessionUri(`dsh-session:${btoa('42').replaceAll('=', '')}`)).toBeUndefined()
    expect(decodeSessionUri(`dsh-session:${btoa('[1]').replaceAll('=', '')}`)).toBeUndefined()
    // A non-canonical spelling (padded) names no session, exactly as on the host.
    expect(decodeSessionUri(`dsh-session:${encode(LIVE_ID)}=`)).toBeUndefined()
    expect(decodeSessionUri('file:abc')).toBeUndefined()
  })
})

describe('resolveSessionLink', () => {
  it('opens the wire form by its own id, with no list lookup at all', () => {
    const lookup = vi.fn(() => undefined)
    expect(resolveSessionLink(`@[Label](${LIVE_URI})`, { matchLabel: lookup }, false)).toEqual({ sessionId: LIVE_ID })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('accepts a wire label that is empty or holds spaces', () => {
    expect(resolveSessionLink(`@[](${LIVE_URI})`, deps(), false)?.sessionId).toBe(LIVE_ID)
    expect(resolveSessionLink(`@[Two words](${LIVE_URI})`, deps(), false)?.sessionId).toBe(LIVE_ID)
  })

  it('never opens a bare label in a sent bubble', () => {
    expect(resolveSessionLink('@AGENTS.md', deps(LIVE_ID), false)).toBeUndefined()
    expect(resolveSessionLink(`@${LIVE_ID}`, deps(LIVE_ID), false)).toBeUndefined()
  })

  it('opens a bare draft label only on the lookup answer', () => {
    expect(resolveSessionLink(`@${LIVE_ID}`, deps(LIVE_ID), true))
      .toEqual({ sessionId: LIVE_ID, resolvedFrom: LIVE_ID })
    // Ambiguous or unknown labels answer nothing and stay inert.
    expect(resolveSessionLink(`@${LIVE_ID}`, deps(), true)).toBeUndefined()
    expect(resolveSessionLink('@AGENTS.md', deps(), true)).toBeUndefined()
  })

  it('refuses malformed wire forms instead of decoding a guess', () => {
    expect(resolveSessionLink('@[Label](dsh-session:%%%)', deps(), true)).toBeUndefined()
    expect(resolveSessionLink('@[Label](file:abc)', deps(), true)).toBeUndefined()
    expect(resolveSessionLink('@[unclosed', deps(), true)).toBeUndefined()
    expect(resolveSessionLink('@[Label](dsh-session)', deps(), true)).toBeUndefined()
  })

  it('ignores tokens that carry separators or nothing at all', () => {
    expect(resolveSessionLink('@', deps(LIVE_ID), true)).toBeUndefined()
    expect(resolveSessionLink('@a b', deps(LIVE_ID), true)).toBeUndefined()
    expect(resolveSessionLink('@a(b)', deps(LIVE_ID), true)).toBeUndefined()
    expect(resolveSessionLink('plain', deps(LIVE_ID), true)).toBeUndefined()
  })
})

/** Encode one id the way the host does, for building fixtures. */
function encode(sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
