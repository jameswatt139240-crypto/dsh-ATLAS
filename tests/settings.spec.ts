/**
 * The settings entry point: the namespace registration the runtime depends on,
 * and the defaults-only fallback that keeps a profile without a namespace API
 * serving switches instead of taking the plugin down.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AT_FILE_NAMESPACE,
  AtFileSettingsSchema,
  registerAtFileSettings,
  type AtFileSettings,
} from '../src/settings.ts'

/** A settings service that answers the legacy registration, recording its call. */
function registeringService() {
  const scope = { get: () => AtFileSettingsSchema({} as AtFileSettings), update: async () => {} }
  const register = vi.fn(() => scope)
  return { service: { register }, scope }
}

/** The shape a profile without the namespace API hands the plugin. */
const bareService = {}

describe('registerAtFileSettings', () => {
  it('registers the namespace with the schema and asks for live application', () => {
    const { service, scope } = registeringService()
    const returned = registerAtFileSettings({ settings: service } as unknown as Context)

    expect(returned).toBe(scope)
    expect(service.register).toHaveBeenCalledTimes(1)
    const [namespace, schema, options] = service.register.mock.calls[0] as unknown as [
      string,
      unknown,
      { applies?: string },
    ]
    expect(namespace).toBe(AT_FILE_NAMESPACE)
    expect(schema).toBe(AtFileSettingsSchema)
    expect(options).toEqual({ applies: 'live' })
  })

  it('falls back to the schema defaults, loudly, when the service offers no namespace API', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const scope = registerAtFileSettings({ settings: bareService } as unknown as Context)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no namespace API'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(AT_FILE_NAMESPACE))
    warn.mockRestore()
  })

  it('keeps the fallback scope live in memory, so a toggle still answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scope = registerAtFileSettings({ settings: bareService } as unknown as Context)
    warn.mockRestore()

    // The contract default is the turn-grained ladder (A-33); the fallback must
    // resolve the SAME value the schema would, or the panel and the ladder drift.
    expect(scope.get().historyJumpFrames).toBe('turn')
    expect(scope.get().enabled).toBe(true)

    await scope.update({ enabled: false, historyJumpFrames: 'message' })

    expect(scope.get().enabled).toBe(false)
    expect(scope.get().historyJumpFrames).toBe('message')
    // Untouched fields keep their resolved defaults rather than vanishing.
    expect(scope.get().historyJumpReuseMode).toBe('replace')
    expect(scope.get().historyJumpSmartFollow).toBe(false)
  })
})
