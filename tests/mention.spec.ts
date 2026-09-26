/**
 * Host @path reference behavior: token recognition, workspace confinement,
 * existence/kind markers, and the unknown-path/non-user-source skips.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expandMentions, mentionPreStep, scanMentions } from '../src/mention.ts'
import { externalAccess } from '../src/external.ts'
import { protectPastedMentions } from '../src/paste.ts'

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('out-of-workspace mentions', () => {
  it('accepts an absolute path only with access, marks it external, and reports it for the ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-atlas-outside-'))
    const far = join(outside, 'far.ts')
    await writeFile(far, 'outside content\n')
    const external = far.replaceAll('\\', '/')
    try {
      // No access: the absolute token stays plain prose (the previous behaviour).
      expect(await expandMentions([user(`read @${external}`)], root, new AbortController().signal)).toEqual([])

      // Full access: accepted, injected as an EXTERNAL reference, and handed to
      // the ledger callback.
      const seen: string[] = []
      const injections = await expandMentions(
        [user(`read @${external}`)],
        root,
        new AbortController().signal,
        true,
        externalAccess('danger-full-access', []),
        mention => { seen.push(`${mention.kind}:${mention.relative}`) },
      )
      expect(injections).toHaveLength(1)
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: `<external-reference path="${external}" kind="file" />`,
      })
      expect(injections[0]!.source).toEqual({ kind: 'at-file-mention', relative: external })
      expect(seen).toEqual([`file:${external}`])

      // A narrow mode may still use what the ledger holds — and nothing else.
      const narrow = externalAccess('read-only', [outside])
      const allowed = await expandMentions([user(`read @${external}`)], root, new AbortController().signal, true, narrow)
      expect(allowed).toHaveLength(1)
      const stranger = await mkdtemp(join(tmpdir(), 'dsh-atlas-stranger-'))
      const strangerFile = join(stranger, 'a.ts')
      await writeFile(strangerFile, 'x')
      try {
        expect(await expandMentions(
          [user(`read @${strangerFile.replaceAll('\\', '/')}`)],
          root,
          new AbortController().signal,
          true,
          narrow,
        )).toEqual([])
      } finally {
        await rm(stranger, { recursive: true, force: true })
      }

      // A workspace-relative range still works, and an external DIRECTORY takes
      // the directory marker.
      const directory = await expandMentions(
        [user(`see @${outside.replaceAll('\\', '/')}`)],
        root,
        new AbortController().signal,
        true,
        externalAccess('danger-full-access', []),
      )
      expect(directory[0]!.content[0]).toEqual({
        type: 'text',
        text: `<external-reference path="${outside.replaceAll('\\', '/')}" kind="directory" />`,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('scanMentions', () => {
  it('recognizes @path tokens, strips the directory slash, and deduplicates', () => {
    expect(scanMentions('fix @src/index.ts and @docs/ ')).toEqual(['src/index.ts', 'docs'])
    expect(scanMentions('@a.ts again @a.ts')).toEqual(['a.ts'])
  })

  it('skips protected pasted tokens by default and restores them when the setting is off', () => {
    const pasted = protectPastedMentions('read @a.ts')
    expect(scanMentions(pasted)).toEqual([])
    expect(scanMentions(pasted, false)).toEqual(['a.ts'])
  })
})

describe('expandMentions', () => {
  it('injects only a validated file reference, never its content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await writeFile(join(root, 'a.ts'), 'private content that must not be injected\n')
    try {
      const injections = await expandMentions([user('read @a.ts')], root, new AbortController().signal)
      expect(injections).toHaveLength(1)
      expect(injections[0]!.source).toEqual({ kind: 'at-file-mention', relative: 'a.ts' })
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: '<workspace-reference path="a.ts" kind="file" />',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('carries a line range on a file reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\n')
    try {
      const injections = await expandMentions([user('see @a.ts:2-3')], root, new AbortController().signal)
      expect(injections).toHaveLength(1)
      expect(injections[0]!.source).toEqual({ kind: 'at-file-mention', relative: 'a.ts', lines: '2-3' })
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: '<workspace-reference path="a.ts" kind="file" lines="2-3" />',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a line range on a directory and normalizes a reversed range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'a.ts'), 'x\n')
    try {
      expect(await expandMentions([user('@src:1-2')], root, new AbortController().signal)).toEqual([])
      const reversed = await expandMentions([user('@a.ts:9-4')], root, new AbortController().signal)
      expect(reversed[0]!.content[0]).toEqual({
        type: 'text',
        text: '<workspace-reference path="a.ts" kind="file" lines="4-9" />',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never opens the referenced file, so a range is not bounded by its length', async () => {
    // The Host validates syntax, existence, and kind only. Line numbers are the
    // agent's business when it reads the file; reading here would break the
    // "paths only, never content" promise.
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await writeFile(join(root, 'a.ts'), 'x\n')
    try {
      const injections = await expandMentions([user('@a.ts:99999')], root, new AbortController().signal)
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: '<workspace-reference path="a.ts" kind="file" lines="99999-99999" />',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a directory as one reference without indexing descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await writeFile(join(root, 'src', 'nested', 'large.bin'), Buffer.alloc(512 * 1024, 0xff))
    try {
      const injections = await expandMentions([user('inspect @src/')], root, new AbortController().signal)
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: '<workspace-reference path="src" kind="directory" />',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('represents the workspace root as one directory reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    try {
      const injections = await expandMentions([user('inspect @./')], root, new AbortController().signal)
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: '<workspace-reference path="." kind="directory" />',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('references large binary and PDF paths exactly like text paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await writeFile(join(root, 'report.pdf'), Buffer.alloc(512 * 1024, 0xff))
    try {
      const injections = await expandMentions([user('review @report.pdf')], root, new AbortController().signal)
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: '<workspace-reference path="report.pdf" kind="file" />',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('escapes a referenced path attribute', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    // Windows forbids the double quote in file names; the POSIX arm keeps the
    // full &quot; escaping coverage, the win32 arm still proves &amp;.
    const name = process.platform === 'win32' ? 'a&b.txt' : 'a&b".txt'
    const expected = process.platform === 'win32'
      ? '<workspace-reference path="a&amp;b.txt" kind="file" />'
      : '<workspace-reference path="a&amp;b&quot;.txt" kind="file" />'
    await writeFile(join(root, name), 'x')
    try {
      const injections = await expandMentions([user(`read @${name}`)], root, new AbortController().signal)
      expect(injections[0]!.content[0]).toEqual({
        type: 'text',
        text: expected,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips non-text blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: 'no mention' }, { type: 'image', attachment: { attachmentId: 'x' } as never }],
        source: { kind: 'user' },
      })
      expect(await expandMentions([message], root, new AbortController().signal)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips unknown paths and non-user message sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    try {
      expect(await expandMentions([user('read @missing.ts')], root, new AbortController().signal)).toEqual([])
      const plugin = createUserMessage({ content: [{ type: 'text', text: '@a.ts' }], source: { kind: 'plugin', plugin: 'x' } })
      await writeFile(join(root, 'a.ts'), 'x\n')
      expect(await expandMentions([plugin], root, new AbortController().signal)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses tokens that escape the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    const absolute = join(root, 'inside.ts')
    await writeFile(absolute, 'x\n')
    try {
      expect(await expandMentions([user(`read @${absolute}`)], root, new AbortController().signal)).toEqual([])
      expect(await expandMentions([user('read @../secret.ts')], root, new AbortController().signal)).toEqual([])
      expect(await expandMentions([user('read @src/../../secret.ts')], root, new AbortController().signal)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a relative cwd as unavailable', async () => {
    expect(await expandMentions([user('read @a.ts')], 'relative/cwd', new AbortController().signal)).toEqual([])
  })

  it('keeps cancellation fatal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    const controller = new AbortController()
    controller.abort(new Error('cancel reference'))
    try {
      await expect(expandMentions([user('@anything')], root, controller.signal)).rejects.toThrow('cancel reference')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('mentionPreStep', () => {
  const agent = { session: { header: { cwd: '/ws' } } }

  it('appends references to the downstream enter decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await writeFile(join(root, 'a.ts'), 'x\n')
    try {
      const decision = await mentionPreStep(
        { session: { header: { cwd: root } } },
        () => true,
        [user('read @a.ts')],
        new AbortController().signal,
        async () => ({ kind: 'enter', messages: [] }),
      )
      expect(decision.kind).toBe('enter')
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages![0]!.source).toEqual({ kind: 'at-file-mention', relative: 'a.ts' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns the downstream decision when disabled or rejected', async () => {
    const decision = async () => ({ kind: 'enter', messages: [] })
    const disabled = await mentionPreStep(agent, () => false, [user('@a.ts')], new AbortController().signal, decision)
    expect(disabled.messages).toEqual([])
    const rejected = await mentionPreStep(agent, () => true, [user('@a.ts')], new AbortController().signal, async () => ({ kind: 'reject' }))
    expect(rejected.kind).toBe('reject')
    const unmatched = await mentionPreStep(agent, () => true, [user('@missing.ts')], new AbortController().signal, decision)
    expect(unmatched.messages).toEqual([])
  })

  it('does not inject or expose pasted references when the setting is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await writeFile(join(root, 'a.ts'), 'x\n')
    try {
      const pasted = protectPastedMentions('please keep @a.ts as text')
      const decision = await mentionPreStep(
        { session: { header: { cwd: root } } },
        () => true,
        [user(pasted)],
        new AbortController().signal,
        async () => ({ kind: 'enter', messages: [user(pasted)] }),
      )
      expect(decision.kind).toBe('enter')
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages[0]!.content[0]).toEqual({ type: 'text', text: 'please keep @a.ts as text' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores the legacy behavior when pasted-mention filtering is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-mention-'))
    await writeFile(join(root, 'a.ts'), 'x\n')
    try {
      const pasted = protectPastedMentions('read @a.ts')
      const decision = await mentionPreStep(
        { session: { header: { cwd: root } } },
        () => true,
        [user(pasted)],
        new AbortController().signal,
        async () => ({ kind: 'enter', messages: [] }),
        () => false,
      )
      expect(decision.kind).toBe('enter')
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages[0]!.source).toEqual({ kind: 'at-file-mention', relative: 'a.ts' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
