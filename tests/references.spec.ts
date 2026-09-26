/**
 * Host category reference behavior: @skill / @plugin markers, @chat snapshot
 * preparation, chat text normalization, and the mentionPreStep integration
 * that orders context before the user's own words and markers after.
 */
import { describe, expect, it, vi } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { encodeSessionReferenceUri } from '@deepseek-ai/dsh-session-reference'
import {
  cleanChatMentions,
  collectChatReferences,
  escapeReferenceAttribute,
  expandChatMentions,
  expandPluginMentions,
  expandSkillMentions,
  PLUGIN_MENTION_PATTERN,
  SKILL_MENTION_PATTERN,
  type ChatResolver,
} from '../src/references.ts'
import { mentionPreStep, type ReferenceExpansion } from '../src/mention.ts'

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'assistant' } })
}

/** Build a `dsh-session:` markdown mention for one session id. */
function chatMention(sessionId: string, label: string): string {
  return `@[${label}](${encodeSessionReferenceUri(sessionId)})`
}

/** A fresh, unaborted caller signal (the pre-step's lifetime). */
const SIGNAL = new AbortController().signal
const agentStub = { session: { header: {} } } as never

describe('escapeReferenceAttribute', () => {
  it('escapes the four XML-like attribute characters', () => {
    expect(escapeReferenceAttribute('a&b"c<d>e')).toBe('a&amp;b&quot;c&lt;d&gt;e')
    expect(escapeReferenceAttribute('plain-name')).toBe('plain-name')
  })
})

describe('mention token patterns', () => {
  it('recognizes @skill: and @plugin: names without whitespace or @', () => {
    expect('use @skill:blender-modeling now'.match(SKILL_MENTION_PATTERN)?.[0]).toBe('@skill:blender-modeling')
    expect('try @plugin:dsh-atlas'.match(PLUGIN_MENTION_PATTERN)?.[0]).toBe('@plugin:dsh-atlas')
  })
})

describe('expandSkillMentions', () => {
  it('injects a marker for known skills and skips unknown names', async () => {
    const injections = await expandSkillMentions(
      [user('do @skill:blender-modeling with @skill:unknown and again @skill:blender-modeling')],
      name => name === 'blender-modeling',
      SIGNAL,
    )
    expect(injections).toHaveLength(1)
    expect(injections[0]!.source).toEqual({ kind: 'atlas-skill', name: 'blender-modeling' })
    expect(injections[0]!.content[0]).toEqual({
      type: 'text',
      text: '<skill-reference name="blender-modeling" />',
    })
  })

  it('appends the skill body when the loader is provided', async () => {
    const injections = await expandSkillMentions(
      [user('use @skill:fit-repair-optimizer')],
      () => true,
      SIGNAL,
      async name => name === 'fit-repair-optimizer' ? 'body-of-skill' : undefined,
    )
    expect(injections[0]!.content[0]).toEqual({
      type: 'text',
      text: '<skill-reference name="fit-repair-optimizer" />\n\n<skill-body>\nbody-of-skill\n</skill-body>',
    })
  })

  it('skips non-user sources and non-text blocks', async () => {
    const injections = await expandSkillMentions(
      [assistant('@skill:blender-modeling')],
      () => true,
      SIGNAL,
    )
    expect(injections).toEqual([])
  })
})

describe('expandPluginMentions', () => {
  it('injects a marker for enabled plugins and skips disabled ones', async () => {
    const injections = await expandPluginMentions(
      [user('with @plugin:dsh-atlas and @plugin:dsh-off')],
      name => name === 'dsh-atlas',
      SIGNAL,
    )
    expect(injections).toHaveLength(1)
    expect(injections[0]!.source).toEqual({ kind: 'atlas-plugin', moduleName: 'dsh-atlas' })
    expect(injections[0]!.content[0]).toEqual({
      type: 'text',
      text: '<plugin-reference name="dsh-atlas" />',
    })
  })
})

describe('collectChatReferences', () => {
  it('collects markdown mentions in order, deduplicates, and normalizes text', () => {
    const a = chatMention('sess-a', 'Payment rates')
    const b = chatMention('sess-b', 'Refactor plan')
    const { references, cleaned } = collectChatReferences([user(`see ${a} and ${b} and again ${a}`)])
    expect(references.map(reference => reference.sessionId)).toEqual(['sess-a', 'sess-b'])
    expect(references[0]!.label).toBe('Payment rates')
    expect(cleaned[0]!.content[0]).toEqual({
      type: 'text',
      text: 'see @Payment rates and @Refactor plan and again @Payment rates',
    })
  })

  it('accepts bare canonical URIs with the session id as the label', () => {
    const uri = encodeSessionReferenceUri('sess-x')
    const { references, cleaned } = collectChatReferences([user(`recall ${uri}`)])
    expect(references.map(reference => reference.sessionId)).toEqual(['sess-x'])
    expect(cleaned[0]!.content[0]).toEqual({ type: 'text', text: 'recall @sess-x' })
  })

  it('passes through non-user sources and non-text blocks unchanged', () => {
    const { references, cleaned } = collectChatReferences([
      assistant(chatMention('sess-a', 'A')),
      user('plain text without references'),
    ])
    expect(references).toEqual([])
    expect(cleaned[0]!.content[0]).toEqual({ type: 'text', text: chatMention('sess-a', 'A') })
    expect(cleaned[1]!.content[0]).toEqual({ type: 'text', text: 'plain text without references' })
  })
})

describe('cleanChatMentions', () => {
  it('normalizes URIs without preparing any context', () => {
    const mention = chatMention('sess-a', 'A')
    const cleaned = cleanChatMentions([user(`read ${mention}`)])
    expect(cleaned[0]!.content[0]).toEqual({ type: 'text', text: 'read @A' })
  })
})

describe('expandChatMentions', () => {
  it('returns undefined without calling the resolver when nothing references a session', async () => {
    const prepare = vi.fn()
    const resolver = { prepare } as unknown as ChatResolver
    expect(await expandChatMentions(agentStub, resolver, [user('no references here')], SIGNAL)).toBeUndefined()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('prepares one snapshot context and returns the additionalContext message', async () => {
    const context = createUserMessage({ content: [{ type: 'text', text: '<context/>' }], source: { kind: 'session-reference', version: 1, references: [] } } as never)
    const prepare = vi.fn().mockResolvedValue({ content: [], additionalContext: context })
    const resolver = { prepare } as unknown as ChatResolver
    const mention = chatMention('sess-a', 'A')
    const result = await expandChatMentions(agentStub, resolver, [user(`use ${mention}`)], SIGNAL)
    expect(result).toBe(context)
    expect(prepare).toHaveBeenCalledTimes(1)
    const [, content, references] = prepare.mock.calls[0] as [unknown, unknown[], unknown[]]
    expect((content[0] as { text: string }).text).toBe('use @A')
    expect(references).toHaveLength(1)
  })

  it('returns undefined when the resolver produced no context', async () => {
    const resolver = { prepare: vi.fn().mockResolvedValue({ content: [] }) } as unknown as ChatResolver
    const mention = chatMention('sess-a', 'A')
    expect(await expandChatMentions(agentStub, resolver, [user(`use ${mention}`)], SIGNAL)).toBeUndefined()
  })
})

describe('mentionPreStep with category references', () => {
  const context = createUserMessage({ content: [{ type: 'text', text: '<past-chat context/>' }], source: { kind: 'session-reference' } } as never)

  it('orders chat context before the user words and markers after them', async () => {
    const mention = chatMention('sess-a', 'A')
    const expansion: ReferenceExpansion = {
      expandChats: async () => context,
      expandSkills: async () => [createUserMessage({ content: [{ type: 'text', text: '<skill-reference name="s" />' }], source: { kind: 'atlas-skill', name: 's' } } as never)],
      expandPlugins: async () => [createUserMessage({ content: [{ type: 'text', text: '<plugin-reference name="p" />' }], source: { kind: 'atlas-plugin', moduleName: 'p' } } as never)],
    }
    const decision = await mentionPreStep(
      { session: { header: {} } } as never,
      () => true,
      [user(`check ${mention} @skill:s @plugin:p`)],
      SIGNAL,
      async () => ({ kind: 'enter', messages: [user(`check ${mention} @skill:s @plugin:p`)] }),
      () => true,
      expansion,
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const texts = decision.messages.map(message => (message.content[0] as { text: string }).text)
    expect(texts[0]).toBe('<past-chat context/>')
    expect(texts[1]).toBe('check @A @skill:s @plugin:p')
    expect(texts.slice(2).sort()).toEqual([
      '<plugin-reference name="p" />',
      '<skill-reference name="s" />',
    ])
  })

  it('logs and continues when chat expansion fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const expansion: ReferenceExpansion = {
      expandChats: async () => { throw new Error('boom') },
      expandSkills: async () => [],
      expandPlugins: async () => [],
    }
    const decision = await mentionPreStep(
      { session: { header: {} } } as never,
      () => true,
      [user('plain')],
      SIGNAL,
      async () => ({ kind: 'enter', messages: [user('plain')] }),
      () => true,
      expansion,
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages).toHaveLength(1)
      expect((decision.messages[0]!.content[0] as { text: string }).text).toBe('plain')
    }
    expect(errorSpy).toHaveBeenCalledWith('[dsh-atlas] past-chat expansion failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('stays silent when an expansion was cancelled rather than failed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new AbortController()
    controller.abort()
    const expansion: ReferenceExpansion = {
      expandChats: async () => { throw new Error('gateway/cancelled: the turn was stopped') },
      expandSkills: async () => [],
      expandPlugins: async () => [],
    }
    const decision = await mentionPreStep(
      { session: { header: {} } } as never,
      () => true,
      [user('plain')],
      controller.signal,
      async () => ({ kind: 'enter', messages: [user('plain')] }),
      () => true,
      expansion,
    )
    expect(decision.kind).toBe('enter')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('skips every expansion while the settings switch is off', async () => {
    const expandChats = vi.fn()
    const expandSkills = vi.fn()
    const expandPlugins = vi.fn()
    const decision = await mentionPreStep(
      { session: { header: {} } } as never,
      () => false,
      [user('@skill:s')],
      SIGNAL,
      async () => ({ kind: 'enter', messages: [user('@skill:s')] }),
      () => true,
      { expandChats, expandSkills, expandPlugins } as unknown as ReferenceExpansion,
    )
    expect(decision.kind).toBe('enter')
    expect(expandChats).not.toHaveBeenCalled()
    expect(expandSkills).not.toHaveBeenCalled()
    expect(expandPlugins).not.toHaveBeenCalled()
  })
})
