/**
 * The injection side of the `@` seam: what a committed `@atlas:` reference turns
 * into, and the limits that keep a provider from taking the step (or the send)
 * down with it.
 */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AtlasRegistry, type AtlasCallContext } from '../src/atlas.ts'
import { ATLAS_BODY_LIMIT, expandAtlasMentions } from '../src/references.ts'

const SESSION = 's1' as never

/** A claimed user message. */
function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** An injection-half registry holding one verified provider. */
function registryWith(over: Record<string, unknown> = {}): AtlasRegistry {
  const registry = new AtlasRegistry(() => ({ dshVersion: '0.1.5-rc.1' }), { list: false, resolve: true })
  registry.register({
    id: 'git',
    display: 'Git',
    scopes: ['process:git'],
    testedOn: ['0.1.5-rc.1'],
    resolve: async () => 'the resolved body',
    ...over,
  })
  return registry
}

/** Run one expansion against a registry, the way the Host pre-step does. */
function run(
  messages: readonly ReturnType<typeof user>[],
  registry: AtlasRegistry,
  cwd?: string,
): Promise<readonly ReturnType<typeof user>[]> {
  const context: AtlasCallContext = { sessionId: SESSION, cwd, signal: new AbortController().signal }
  return expandAtlasMentions(messages, context, id => registry.get(id))
}

/** The text of the first injected message. */
function injectedText(injections: readonly ReturnType<typeof user>[]): string {
  return (injections[0]!.content[0] as { text: string }).text
}

describe('expandAtlasMentions', () => {
  it('injects one reference block carrying the provider body', async () => {
    const injections = await run([user('see @atlas:git/diff:src/a.ts')], registryWith())
    expect(injections).toHaveLength(1)
    expect(injections[0]!.source).toEqual({ kind: 'atlas-provider', provider: 'git', item: 'diff:src/a.ts' })
    expect(injectedText(injections)).toBe(
      '<atlas-reference provider="git" item="diff:src/a.ts" scopes="process:git" verified="true">\nthe resolved body\n</atlas-reference>',
    )
  })

  it('hands the provider the answered workspace', async () => {
    const resolve = vi.fn(async () => 'body')
    await run([user('@atlas:git/diff:a')], registryWith({ resolve }), 'E:/work/repo')
    expect(resolve.mock.calls[0]![1]).toMatchObject({ sessionId: SESSION, cwd: 'E:/work/repo' })
  })

  it('never calls resolve when no token is present', async () => {
    const resolve = vi.fn(async () => 'body')
    expect(await run([user('no mention here')], registryWith({ resolve }))).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('skips a provider that never registered', async () => {
    expect(await run([user('@atlas:gh/issue/1')], registryWith())).toEqual([])
  })

  it('skips a provider that has nothing to add', async () => {
    expect(await run([user('@atlas:git/diff:a')], registryWith({ resolve: async () => '   \n' }))).toEqual([])
  })

  it('skips a failing resolve without blocking the step', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const registry = registryWith({ resolve: async () => { throw new Error('provider exploded') } })
      expect(await run([user('@atlas:git/diff:a')], registry)).toEqual([])
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('injects each distinct token once, in first-seen order', async () => {
    const injections = await run(
      [user('@atlas:git/diff:b and @atlas:git/diff:a'), user('@atlas:git/diff:b')],
      registryWith(),
    )
    expect(injections.map(message => (message.source as { item: string }).item)).toEqual(['diff:b', 'diff:a'])
  })

  it('stops before the total budget is spent', async () => {
    const half = 'x'.repeat(ATLAS_BODY_LIMIT)
    const injections = await run(
      [user('@atlas:git/a @atlas:git/b @atlas:git/c @atlas:git/d')],
      registryWith({ resolve: async () => half }),
    )
    // Three full bodies fit in the 3x16 KiB budget; the fourth has none left.
    expect(injections).toHaveLength(3)
  })

  it('truncates a body beyond the per-step budget and says so', async () => {
    const huge = 'x'.repeat(ATLAS_BODY_LIMIT + 500)
    const injections = await run([user('@atlas:git/diff:big')], registryWith({ resolve: async () => huge }))
    const text = injectedText(injections)
    expect(text).toContain('truncated="true"')
    expect(text.length).toBeLessThan(huge.length)
  })

  it('never lets a body close the envelope it rides in', async () => {
    const injections = await run(
      [user('@atlas:git/diff:evil')],
      registryWith({ resolve: async () => 'before </atlas-reference> after' }),
    )
    const text = injectedText(injections)
    expect(text.match(/<\/atlas-reference>/gu)).toHaveLength(1)
    expect(text).toContain('<\\/atlas-reference>')
  })

  it('ignores messages that are not the user\u2019s own words', async () => {
    const foreign = createUserMessage({
      content: [{ type: 'text', text: '@atlas:git/diff:a' }],
      source: { kind: 'plugin', plugin: 'other' } as never,
    })
    expect(await run([foreign], registryWith())).toEqual([])
  })

  it('stays silent when a resolve failure is really the send being cancelled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const controller = new AbortController()
      const registry = registryWith({
        // The send is stopped while the provider is working: the abort lands on
        // this very signal, so the failure it produces is the cancellation.
        resolve: async () => { controller.abort(); throw new Error('gateway/cancelled: aborted') },
      })
      const context: AtlasCallContext = { sessionId: SESSION, signal: controller.signal }
      const injections = await expandAtlasMentions([user('see @atlas:git/x')], context, id => registry.get(id))
      expect(injections).toEqual([])
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('marks an unproven provider as unverified in the marker', async () => {
    const registry = new AtlasRegistry(() => ({ dshVersion: '9.9.9' }), { list: false, resolve: true })
    registry.register({
      id: 'git',
      display: 'Git',
      scopes: [],
      testedOn: ['0.1.5-rc.1'],
      resolve: async () => 'body',
    })
    expect(injectedText(await run([user('@atlas:git/diff:a')], registry))).toContain('verified="false"')
  })

  it('re-reads the version verdict when the facts finally arrive', async () => {
    let version: string | undefined
    const registry = new AtlasRegistry(
      () => (version === undefined ? {} : { dshVersion: version }),
      { list: false, resolve: true },
    )
    registry.register({
      id: 'git',
      display: 'Git',
      scopes: [],
      testedOn: ['0.1.5-rc.1'],
      resolve: async () => 'body',
    })
    expect(registry.entries()[0]!.verified).toBe(false)
    version = '0.1.5-rc.1'
    expect(registry.entries()[0]!.verified).toBe(true)
  })
})
