/**
 * The `@` seam registry: what it accepts, what it refuses, and the version gate
 * that keeps an unproven provider from reading as proven.
 */
import { describe, expect, it, vi } from 'vitest'
import { AtlasRegistry, validateAtlasItem, type AtlasProvider } from '../src/atlas.ts'

/** A minimal valid declaration; each test overrides the field it exercises. */
function provider(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'git',
    display: 'Git',
    list: async () => [{ id: 'a', title: 'a' }],
    resolve: async () => 'body',
    scopes: ['process:git'],
    testedOn: ['0.1.5-rc.1'],
    ...over,
  }
}

describe('AtlasRegistry registration rules', () => {
  it('accepts a complete declaration and hands it back', () => {
    const registry = new AtlasRegistry({ dshVersion: '0.1.5-rc.1' })
    const dispose = registry.register(provider())
    expect(registry.entries()).toHaveLength(1)
    expect(registry.get('git')).toMatchObject({
      id: 'git',
      display: 'Git',
      scopes: ['process:git'],
      testedOn: ['0.1.5-rc.1'],
      verified: true,
    })
    dispose()
    expect(registry.entries()).toHaveLength(0)
    expect(registry.get('git')).toBeUndefined()
  })

  it('refuses a non-object declaration', () => {
    expect(() => new AtlasRegistry().register(undefined)).toThrow(/must be an object/u)
    expect(() => new AtlasRegistry().register(null)).toThrow(/must be an object/u)
    expect(() => new AtlasRegistry().register('git')).toThrow(/must be an object/u)
  })

  it('refuses a malformed or missing @id', () => {
    for (const id of [undefined, '', 'Git', 'my_git', '-git', 42]) {
      expect(() => new AtlasRegistry().register(provider({ id })))
        .toThrow(/provider\.id must be a lowercase/u)
    }
  })

  it('refuses a missing display name', () => {
    for (const display of [undefined, '', '   ', 7]) {
      expect(() => new AtlasRegistry().register(provider({ display })))
        .toThrow(/"git" needs a nonempty display name/u)
    }
  })

  it('refuses missing callbacks', () => {
    expect(() => new AtlasRegistry().register(provider({ list: undefined })))
      .toThrow(/"git" needs a list\(query, ctx\) callback for its menu half/u)
    expect(() => new AtlasRegistry().register(provider({ resolve: undefined })))
      .toThrow(/"git" needs a resolve\(item, ctx\) callback for its injection half/u)
  })

  it('refuses a missing governance declaration', () => {
    expect(() => new AtlasRegistry().register(provider({ scopes: undefined })))
      .toThrow(/"git" must declare scopes/u)
    expect(() => new AtlasRegistry().register(provider({ testedOn: undefined })))
      .toThrow(/"git" must declare testedOn/u)
    // Arrays are required even when empty: silence is not a declaration.
    expect(() => new AtlasRegistry().register(provider({ scopes: 'process:git' })))
      .toThrow(/must declare scopes/u)
    expect(() => new AtlasRegistry().register(provider({ testedOn: '0.1.5' })))
      .toThrow(/must declare testedOn/u)
  })

  it('refuses a duplicate id and names the first registrant', () => {
    const registry = new AtlasRegistry()
    registry.register(provider({ display: 'Git (first)' }))
    expect(() => registry.register(provider({ display: 'Git (second)' })))
      .toThrow(/provider "git" is already registered by "Git \(first\)"/u)
    expect(registry.entries()).toHaveLength(1)
  })

  it('keeps registration order and disposes only its own entry', () => {
    const registry = new AtlasRegistry()
    const disposeFirst = registry.register(provider({ id: 'gh', display: 'GitHub' }))
    registry.register(provider({ id: 'db', display: 'Database' }))
    expect(registry.entries().map(entry => entry.id)).toEqual(['gh', 'db'])
    disposeFirst()
    expect(registry.entries().map(entry => entry.id)).toEqual(['db'])
  })
})

describe('AtlasRegistry version gate', () => {
  it('marks a provider verified only when the running version is declared', () => {
    const matching = new AtlasRegistry({ dshVersion: '0.1.5-rc.1' })
    matching.register(provider({ testedOn: ['0.1.4', '0.1.5-rc.1'] }))
    expect(matching.get('git')?.verified).toBe(true)

    const stale = new AtlasRegistry({ dshVersion: '0.1.7-rc.1' })
    stale.register(provider({ testedOn: ['0.1.5-rc.1'] }))
    expect(stale.get('git')?.verified).toBe(false)
  })

  it('never reads as verified when the runtime version is unknown', () => {
    const unknown = new AtlasRegistry()
    unknown.register(provider({ testedOn: ['0.1.5-rc.1'] }))
    expect(unknown.get('git')?.verified).toBe(false)
  })

  it('copies the declarations so later mutation cannot rewrite the verdict', () => {
    const registry = new AtlasRegistry({ dshVersion: '0.1.5-rc.1' })
    const scopes = ['process:git']
    const testedOn = ['0.1.5-rc.1']
    registry.register(provider({ scopes, testedOn }))
    scopes.push('network:any')
    testedOn.length = 0
    expect(registry.get('git')?.scopes).toEqual(['process:git'])
    expect(registry.get('git')?.testedOn).toEqual(['0.1.5-rc.1'])
    expect(registry.get('git')?.verified).toBe(true)
  })
})

describe('AtlasRegistry halves', () => {
  const MENU_HALF = { list: true, resolve: false }
  const HOST_HALF = { list: false, resolve: true }

  it('accepts a list-only declaration on the menu half', () => {
    const menu = new AtlasRegistry({}, MENU_HALF)
    menu.register(provider({ resolve: undefined }))
    expect(menu.get('git')?.provider.list).toBeTypeOf('function')
    expect(menu.get('git')?.provider.resolve).toBeUndefined()
  })

  it('accepts a resolve-only declaration on the injection half', () => {
    const host = new AtlasRegistry({}, HOST_HALF)
    host.register(provider({ list: undefined }))
    expect(host.get('git')?.provider.resolve).toBeTypeOf('function')
    expect(host.get('git')?.provider.list).toBeUndefined()
  })

  it('requires each half\'s own callback', () => {
    expect(() => new AtlasRegistry({}, MENU_HALF).register(provider({ list: undefined })))
      .toThrow(/menu half/u)
    expect(() => new AtlasRegistry({}, HOST_HALF).register(provider({ resolve: undefined })))
      .toThrow(/injection half/u)
  })

  it('governs both halves with the same metadata rules', () => {
    expect(() => new AtlasRegistry({}, MENU_HALF).register(provider({ scopes: undefined })))
      .toThrow(/must declare scopes/u)
    expect(() => new AtlasRegistry({}, HOST_HALF).register(provider({ testedOn: undefined })))
      .toThrow(/must declare testedOn/u)
  })

  it('keeps the optional open callback on the menu half only', () => {
    const menu = new AtlasRegistry({}, { ...MENU_HALF, open: true })
    menu.register(provider({ resolve: undefined, open: () => {} }))
    expect(menu.get('git')?.provider.open).toBeTypeOf('function')
    // A half that does not carry it refuses the declaration rather than keeping
    // a callback that could never be called.
    expect(() => new AtlasRegistry({}, MENU_HALF).register(provider({ resolve: undefined, open: () => {} })))
      .toThrow(/only the menu half carries/u)
    expect(() => new AtlasRegistry({}, HOST_HALF).register(provider({ open: () => {} })))
      .toThrow(/only the menu half carries/u)
  })

  it('refuses an open that is not a function', () => {
    const menu = new AtlasRegistry({}, { ...MENU_HALF, open: true })
    expect(() => menu.register(provider({ resolve: undefined, open: 'yes' })))
      .toThrow(/not a function/u)
  })

  it('leaves open optional: a menu-half provider without one still registers', () => {
    const menu = new AtlasRegistry({}, { ...MENU_HALF, open: true })
    menu.register(provider({ resolve: undefined }))
    expect(menu.get('git')?.provider.open).toBeUndefined()
  })
})

describe('validateAtlasItem', () => {
  it('accepts token-safe ids and rejects whitespace or empty titles', () => {
    expect(validateAtlasItem({ id: 'diff:src/a.ts', title: 'a.ts' }))
      .toEqual({ id: 'diff:src/a.ts', title: 'a.ts' })
    expect(() => validateAtlasItem({ id: 'a b', title: 'A' })).toThrow(/whitespace-free/u)
    expect(() => validateAtlasItem({ id: '', title: 'A' })).toThrow(/whitespace-free/u)
    expect(() => validateAtlasItem({ id: 'a', title: '   ' })).toThrow(/nonempty title/u)
    expect(() => validateAtlasItem(null)).toThrow(/must be an object/u)
  })
})

describe('AtlasProvider contract shape', () => {
  it('lets a provider answer list and resolve with the caller signal', async () => {
    const list = vi.fn(async () => [{ id: 'x', title: 'x', preview: 'p', badge: '1' }])
    const resolve = vi.fn(async () => 'the body')
    const declaration: AtlasProvider = {
      id: 'demo',
      display: 'Demo',
      list,
      resolve,
      scopes: [],
      testedOn: [],
    }
    const registry = new AtlasRegistry()
    registry.register(declaration)
    const entry = registry.get('demo')!
    const controller = new AbortController()
    const items = await entry.provider.list('q', { sessionId: 's1' as never, signal: controller.signal })
    expect(items).toEqual([{ id: 'x', title: 'x', preview: 'p', badge: '1' }])
    const body = await entry.provider.resolve(items[0]!, { sessionId: 's1' as never, signal: controller.signal })
    expect(body).toBe('the body')
  })
})
