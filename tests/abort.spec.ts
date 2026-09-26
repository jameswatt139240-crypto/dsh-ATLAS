/**
 * Cancellation versus failure: the plugin's own aborts must not be reported as
 * failures, and a real failure must not be excused by a misleading message.
 */
import { describe, expect, it } from 'vitest'
import { isCancellation } from '../src/abort.ts'

describe('isCancellation', () => {
  it('treats the caller signal as the authority', () => {
    const controller = new AbortController()
    expect(isCancellation(new Error('boom'), controller.signal)).toBe(false)
    controller.abort()
    expect(isCancellation(new Error('boom'), controller.signal)).toBe(true)
  })

  it('honours a detached AbortError', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(isCancellation(error)).toBe(true)
  })

  it('never excuses a plain failure, whatever its message says', () => {
    expect(isCancellation(new Error('this was cancelled by an operator'))).toBe(false)
    expect(isCancellation('cancelled')).toBe(false)
    expect(isCancellation(undefined)).toBe(false)
    expect(isCancellation(null)).toBe(false)
    expect(isCancellation(new Error('boom'), new AbortController().signal)).toBe(false)
  })
})
