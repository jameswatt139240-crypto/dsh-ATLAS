import { describe, expect, it } from 'vitest'
import { decodeSessionUri, wireMentionAt, wireSessionUri } from '../src/client/session-link.ts'

/** The host's canonical encoding: base64url of one JSON string, unpadded. */
const uriOf = (id: string): string =>
  `dsh-session:${Buffer.from(JSON.stringify(id), 'utf8').toString('base64url')}`

describe('the session link grammar', () => {
  it('answers only at the offset a mention would start', () => {
    const mention = `@[Payment rates](${uriOf('sess-a')})`
    expect(wireMentionAt(mention, 0)).toEqual({ end: mention.length })
    expect(wireSessionUri(mention)).toBe(uriOf('sess-a'))
    // The same text read one character later is no longer a mention start.
    expect(wireMentionAt(`x${mention.slice(1)}`, 0)).toBeUndefined()
    expect(wireMentionAt('nothing here', 3)).toBeUndefined()
  })

  it('rejects a payload that does not decode to a non-empty string', () => {
    const payload = (raw: string): string => `dsh-session:${Buffer.from(raw, 'utf8').toString('base64url')}`
    // A JSON empty string and a JSON number are both "not a session id".
    expect(decodeSessionUri(payload('""'))).toBeUndefined()
    expect(decodeSessionUri(payload('123'))).toBeUndefined()
    // Not JSON at all, and a payload that decodes to an id but is not spelled the
    // way this host spells it (padded base64) — both are refused.
    expect(decodeSessionUri(payload('not json'))).toBeUndefined()
    const padded = `dsh-session:${Buffer.from(JSON.stringify('sess-a'), 'utf8').toString('base64')}`
    expect(decodeSessionUri(padded)).toBeUndefined()
    // The round trip of a real id still answers.
    expect(decodeSessionUri(uriOf('sess-a'))).toBe('sess-a')
  })
})
