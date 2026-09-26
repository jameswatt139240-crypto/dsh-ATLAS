/**
 * Host composition behavior: the plugin module boots over a real cordis
 * Context, registers the atFile service with the Gateway-visible binding, and
 * its search @Remote answers over a fixture workspace. This is the
 * REAL-composition evidence for the host half — the filesystem seam is real,
 * the Agent and settings provider are structural stubs (the gateway's `agent`
 * lookup resolves the live Agent in the assembled host, not in this unit).
 */
import { Context, symbols } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import type { AtFileRuntime, AtMentionRuntime } from '../src/runtime.ts'
import type { AtFileSettings } from '../src/contract.ts'
import { AtFileSettingsSchema } from '../src/settings.ts'

/** One structural Agent stub: only the session header the service reads. */
function agentWith(cwd: string | undefined): Agent {
  return { session: { header: { cwd } }, ctx: new Context() } as unknown as Agent
}

/** The unproxied service original (cordis caller-tracking may wrap instances). */
function originalOf(service: object): object {
  const original = Reflect.get(service, symbols.original) as object | undefined
  return original ?? service
}

/** A settings provider stub whose value is switchable per test. */
function settingsProvider(read: () => AtFileSettings) {
  let patch: Partial<AtFileSettings> = {}
  return {
    register: () => ({
      get: () => ({ ...read(), ...patch }),
      watch: () => () => {},
      update: async (next: Partial<AtFileSettings>) => { patch = { ...patch, ...next } },
      replace: async () => {},
    }),
  }
}

/** Mount the function-plugin module on a fresh context (harness test pattern). */
async function mount(
  ctx: Context,
  config?: plugin.Config,
  readSettings: () => AtFileSettings = () => ({
    enabled: true,
    ignoreFiles: [...plugin.DEFAULT_IGNORE_FILES],
    workspaceIgnoreFiles: [],
    ignorePastedMentions: true,
    enableSkills: true,
    enableChats: true,
    enablePlugins: true,
    candidateLimit: 50,
  }),
) {
  const registryFiber = ctx.plugin(TypertRegistry)
  await registryFiber
  ctx.provide('settings', settingsProvider(readSettings))
  ctx.provide('agents', { roots: () => [] })
  const fiber = ctx.plugin({ inject: plugin.inject, apply: plugin.apply }, config)
  await fiber
  return fiber
}

describe('dsh-atlas host composition', () => {
  it('upgrades the previous settings shape with an empty workspace rule list', () => {
    expect(AtFileSettingsSchema({ enabled: true, ignoreFiles: ['desktop.ini'] })).toEqual({
      enabled: true,
      ignoreFiles: ['desktop.ini'],
      workspaceIgnoreFiles: [],
      ignorePastedMentions: true,
      enableSkills: true,
      enableChats: true,
      enablePlugins: true,
      candidateLimit: 50,
      recentFiles: [],
      usage: [],
      externalRefs: [],
      folderOpen: 'both',
    })
    expect(AtFileSettingsSchema({
      enabled: true,
      ignoreFiles: [{ kind: 'regex', pattern: '\\.map$', caseSensitive: false }],
      workspaceIgnoreFiles: [{
        workspace: '/work',
        ignoreFiles: [{ kind: 'exact', pattern: 'Case.tmp', caseSensitive: true }],
      }],
    })).toEqual({
      enabled: true,
      ignoreFiles: [{ kind: 'regex', pattern: '\\.map$', caseSensitive: false }],
      workspaceIgnoreFiles: [{
        workspace: '/work',
        ignoreFiles: [{ kind: 'exact', pattern: 'Case.tmp', caseSensitive: true }],
      }],
      ignorePastedMentions: true,
      enableSkills: true,
      enableChats: true,
      enablePlugins: true,
      candidateLimit: 50,
      recentFiles: [],
      usage: [],
      externalRefs: [],
      folderOpen: 'both',
    })
  })

  it('boots the plugin and registers the atFile service under its own key', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    const runtime = ctx.get('atFile') as AtFileRuntime | undefined
    expect(runtime).toBeDefined()
    // The Gateway source-mode binding the wire dispatch relies on.
    expect(Reflect.get(originalOf(runtime as AtFileRuntime), 'typertRemote').namespace).toBe('atFile')
    await fiber.dispose()
  })

  it('registers the strict Typert manifest for search and settings', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    const registry = ctx.get('typert') as TypertRegistry
    expect(registry.local.get('atFile/search')).toMatchObject({ service: 'atFile', method: 'search' })
    expect(registry.local.get('atFile/getSettings')).toMatchObject({ service: 'atFile', method: 'getSettings' })
    expect(registry.local.get('atFile/updateSettings')).toMatchObject({ service: 'atFile', method: 'updateSettings' })
    expect(registry.local.get('atFile/inspect')).toMatchObject({ service: 'atFile', method: 'inspect' })
    expect(registry.local.get('atFile/external')).toMatchObject({ service: 'atFile', method: 'external' })
    await fiber.dispose()
    expect(registry.local.get('atFile/search')).toBeUndefined()
  })

  it('exports search and settings as Remote methods', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    const runtime = ctx.get('atFile') as AtFileRuntime
    expect(remoteMethods(originalOf(runtime)).map(marker => marker.method)).toEqual([
      'getSettings',
      'updateSettings',
      'search',
      'inspect',
      'external',
      'list',
    ])
    await fiber.dispose()
  })

  it('offers out-of-workspace sibling folders only where the session may discover them', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-atlas-siblings-'))
    const cwd = join(parent, 'workspace')
    await mkdir(cwd)
    await mkdir(join(parent, 'deepseek-harness'))
    await mkdir(join(parent, 'dsh-arcade'))
    // More hidden caches than the budget has slots: they must cost nothing.
    for (let index = 0; index < 14; index += 1) {
      await mkdir(join(parent, `.cache-scratch-${String(index)}`))
    }
    try {
      // A session with no resolved sandbox policy is ledger-only: no discovery,
      // and nothing is listed.
      const narrowCtx = new Context()
      const narrowFiber = await mount(narrowCtx)
      const narrow = narrowCtx.get('atFile') as AtFileRuntime
      const agent = agentWith(cwd)
      expect(await narrow.external(agent, new AbortController().signal))
        .toEqual({ canDiscover: false, roots: [], folders: [] })
      await narrowFiber.dispose()

      // Full access: the directory ABOVE the workspace comes first — that is the
      // case this exists for ("引用上层 DSH 目录") — then its visible sibling
      // checkouts. Hidden dot-directories are skipped INSIDE the walk (the
      // directory above a working tree is full of caches, and letting them spend
      // the budget left the user with two folders instead of the real checkouts),
      // and the workspace itself is never offered as an outside folder.
      const fullCtx = new Context()
      fullCtx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
      const fullFiber = await mount(fullCtx)
      const full = fullCtx.get('atFile') as AtFileRuntime
      const scope = await full.external(agent, new AbortController().signal)
      expect(scope.canDiscover).toBe(true)
      expect(scope.folders[0]).toBe(parent.replaceAll('\\', '/'))
      expect(scope.folders.slice(1).map(folder => folder.slice(parent.length + 1)))
        .toEqual(['deepseek-harness', 'dsh-arcade'])
      expect(scope.folders).not.toContain(cwd.replaceAll('\\', '/'))
      expect(scope.folders.some(folder => folder.includes('.cache-scratch'))).toBe(false)
      await fullFiber.dispose()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('lists one directory through the same gate a reference uses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-dirlist-'))
    const cwd = join(root, 'workspace')
    const outside = join(root, 'outside')
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'README.md'), 'x\n')
    await mkdir(outside)
    const slashed = (value: string): string => value.replaceAll('\\', '/')
    try {
      const ctx = new Context()
      const fiber = await mount(ctx)
      const runtime = ctx.get('atFile') as AtFileRuntime
      const agent = agentWith(cwd)
      const signal = new AbortController().signal
      // `''` is the session workspace root, and a listing carries BOTH kinds,
      // directories first — the folder browser starts here.
      const listing = await runtime.list(agent, '', signal)
      expect(listing.path).toBe(slashed(cwd))
      expect(listing.parent).toBe(slashed(root))
      expect(listing.entries).toEqual([{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }])
      // A workspace-relative path resolves against the session workspace.
      expect((await runtime.list(agent, 'src', signal)).path).toBe(slashed(join(cwd, 'src')))
      // A file is not a folder, and a name that is gone is gone — each says which.
      expect((await runtime.list(agent, 'README.md', signal)).error).toBe('notDirectory')
      expect((await runtime.list(agent, 'nope', signal)).error).toBe('missing')
      // Outside the workspace without the access: refused as a REASON (the browser
      // says it in its own words) rather than an exception.
      const denied = await runtime.list(agent, slashed(outside), signal)
      expect(denied.error).toBe('outside')
      expect(denied.entries).toEqual([])
      await fiber.dispose()

      const fullCtx = new Context()
      fullCtx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
      const fullFiber = await mount(fullCtx)
      const full = fullCtx.get('atFile') as AtFileRuntime
      const allowed = await full.list(agent, slashed(outside), signal)
      expect(allowed.error).toBeUndefined()
      expect(allowed.path).toBe(slashed(outside))
      await fullFiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers the other drives while a listing sits at a drive root', async (context) => {
    if (process.platform !== 'win32') return context.skip()
    const ctx = new Context()
    // A drive root is outside the workspace, so leaving the current drive is a
    // full-access move — the same gate every other out-of-workspace path meets.
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.list(agentWith(process.cwd()), 'C:/', new AbortController().signal)
      expect(listing.parent).toBeUndefined()
      expect(listing.drives).toContain('C:/')
    } finally {
      await fiber.dispose()
    }
  })

  it('disposes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    expect(ctx.get('atFile')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('atFile')).toBeUndefined()
  })

  it('reads and normalizes durable settings through the plugin Remote', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      expect(runtime.getSettings()).toEqual({
        enabled: true,
        ignoreFiles: [...plugin.DEFAULT_IGNORE_FILES],
        workspaceIgnoreFiles: [],
        ignorePastedMentions: true,
        enableSkills: true,
        enableChats: true,
        enablePlugins: true,
        candidateLimit: 50,
      })
      expect(await runtime.updateSettings({
        field: 'ignoreFiles',
        value: [' noise.log ', 'NOISE.LOG', ''],
      })).toMatchObject({ ignoreFiles: ['noise.log'] })
      expect(await runtime.updateSettings({
        field: 'workspaceIgnoreFiles',
        value: [
          { workspace: 'C:\\Work', ignoreFiles: ['first.tmp'] },
          { workspace: 'c:/work/', ignoreFiles: [' SECOND.tmp ', 'FIRST.TMP'] },
          { workspace: '', ignoreFiles: ['empty.tmp'] },
        ],
      })).toMatchObject({
        workspaceIgnoreFiles: [{
          workspace: 'C:\\Work',
          ignoreFiles: ['first.tmp', 'SECOND.tmp'],
        }],
      })
      expect(await runtime.updateSettings({
        field: 'ignoreFiles',
        value: [{ kind: 'regex', pattern: ' \\.map$ ', caseSensitive: false }],
      })).toMatchObject({
        ignoreFiles: [{ kind: 'regex', pattern: '\\.map$', caseSensitive: false }],
      })
      await expect(runtime.updateSettings({
        field: 'ignoreFiles',
        value: [{ kind: 'regex', pattern: '[', caseSensitive: false }],
      })).rejects.toThrow(/Invalid regular expression/)
      expect(await runtime.updateSettings({ field: 'enabled', value: false }))
        .toMatchObject({ enabled: false })
    } finally {
      await fiber.dispose()
    }
  })

  it('search indexes the addressed workspace, files and directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-runtime-'))
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'a.ts'), 'a\n')
    await writeFile(join(root, 'nested', 'b.ts'), 'b\n')
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const files = await runtime.search(agentWith(root), new AbortController().signal)
      expect(files.map(file => `${file.kind}:${file.relative}`)).toEqual([
        'file:a.ts',
        'dir:nested',
        'file:nested/b.ts',
      ])
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent workspace index walks into one scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-runtime-concurrent-'))
    await writeFile(join(root, 'a.ts'), 'a\n')
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const agent = agentWith(root)
      const signal = new AbortController().signal
      const [a, b] = await Promise.all([
        runtime.search(agent, signal),
        runtime.search(agent, signal),
      ])
      expect(a).toBe(b)
      expect(a).toHaveLength(1)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('caches the workspace index on the host for a TTL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-runtime-cache-'))
    await writeFile(join(root, 'a.ts'), 'a\n')
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const agent = agentWith(root)
      const signal = new AbortController().signal
      const first = await runtime.search(agent, signal)
      const second = await runtime.search(agent, signal)
      expect(first).toHaveLength(1)
      // The second call returns the cached array (same reference).
      expect(second).toBe(first)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('search refuses a session without a workspace', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      await expect(runtime.search(agentWith(undefined), new AbortController().signal))
        .rejects.toThrow(/no workspace directory/)
    } finally {
      await fiber.dispose()
    }
  })

  it('search refuses while the settings switch is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-runtime-'))
    const ctx = new Context()
    const fiber = await mount(ctx, undefined, () => ({
      enabled: false,
      ignoreFiles: [...plugin.DEFAULT_IGNORE_FILES],
      workspaceIgnoreFiles: [],
    }))
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      await expect(runtime.search(agentWith(root), new AbortController().signal))
        .rejects.toThrow(/disabled in Settings/)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('search applies the live case-insensitive file-name filters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-runtime-'))
    await writeFile(join(root, 'desktop.ini'), 'metadata\n')
    await writeFile(join(root, 'keep.txt'), 'keep\n')
    let ignoreFiles: string[] = ['DESKTOP.INI']
    const ctx = new Context()
    const fiber = await mount(ctx, undefined, () => ({ enabled: true, ignoreFiles, workspaceIgnoreFiles: [] }))
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      expect((await runtime.search(agentWith(root), new AbortController().signal)).map(file => file.relative)).toEqual(['keep.txt'])
      ignoreFiles = []
      expect((await runtime.search(agentWith(root), new AbortController().signal)).map(file => file.relative)).toEqual(['desktop.ini', 'keep.txt'])
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds only the addressed workspace filters to the global list', async () => {
    const first = await mkdtemp(join(tmpdir(), 'dsh-atlas-runtime-first-'))
    const second = await mkdtemp(join(tmpdir(), 'dsh-atlas-runtime-second-'))
    for (const root of [first, second]) {
      await writeFile(join(root, 'global.tmp'), 'global\n')
      await writeFile(join(root, 'local.tmp'), 'local\n')
      await writeFile(join(root, 'keep.txt'), 'keep\n')
    }
    const ctx = new Context()
    const fiber = await mount(ctx, undefined, () => ({
      enabled: true,
      ignoreFiles: ['global.tmp'],
      workspaceIgnoreFiles: [{ workspace: first, ignoreFiles: ['LOCAL.TMP'] }],
    }))
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      expect((await runtime.search(agentWith(first), new AbortController().signal)).map(file => file.relative))
        .toEqual(['keep.txt'])
      expect((await runtime.search(agentWith(second), new AbortController().signal)).map(file => file.relative))
        .toEqual(['keep.txt', 'local.tmp'])
    } finally {
      await fiber.dispose()
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  it('validates configuration through the exported schema', () => {
    expect(plugin.Config({})).toEqual({
      maxIndexedFiles: 2000,
      ignoreDirs: [...plugin.DEFAULT_IGNORE_DIRS],
      injectSkillBody: false,
    })
    expect(plugin.DEFAULT_IGNORE_FILES).toEqual(['desktop.ini', 'Thumbs.db', '.DS_Store'])
    expect(plugin.Config({ ignoreDirs: [] }).ignoreDirs).toEqual([])
    expect(() => plugin.Config({ maxIndexedFiles: 0 })).toThrow()
  })
})

describe('dsh-atlas atMention service and reference wiring', () => {
  it('registers the atMention service and its Remote methods', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      expect(runtime).toBeDefined()
      expect(remoteMethods(originalOf(runtime)).map(marker => marker.method)).toEqual([
        'listSkills',
        'listChats',
        'listPlugins',
      ])
      const registry = ctx.get('typert') as TypertRegistry
      expect(registry.local.get('atMention/listSkills')).toMatchObject({ service: 'atMention', method: 'listSkills' })
      expect(registry.local.get('atMention/listChats')).toMatchObject({ service: 'atMention', method: 'listChats' })
      expect(registry.local.get('atMention/listPlugins')).toMatchObject({ service: 'atMention', method: 'listPlugins' })
    } finally {
      await fiber.dispose()
    }
  })

  it('lists skills through the skills service and honors the settings gate', async () => {
    const ctx = new Context()
    const skills = {
      list: vi.fn(async () => [{ name: 'blender-modeling', description: 'Model in Blender' }]),
      get: vi.fn(async () => undefined),
    }
    ctx.provide('skills', skills)
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      const signal = new AbortController().signal
      expect(await runtime.listSkills(agentWith('/work'), signal)).toEqual([
        { name: 'blender-modeling', description: 'Model in Blender', tier: 'custom' },
      ])
      expect(skills.list).toHaveBeenCalledWith({ cwd: '/work', signal })
    } finally {
      await fiber.dispose()
    }
  })

  it('coalesces concurrent skill scans into one host discovery', async () => {
    const ctx = new Context()
    const list = vi.fn(async () => [{ name: 'blender-modeling', description: 'd', source: 'custom' }])
    ctx.provide('skills', { list, get: vi.fn() })
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      const agent = { id: 'skill-concurrent', session: { header: { cwd: '/work' } } } as never
      const signal = new AbortController().signal
      const [a, b] = await Promise.all([
        runtime.listSkills(agent, signal),
        runtime.listSkills(agent, signal),
      ])
      expect(a).toEqual(b)
      expect(list).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('caches skill discovery on the host for a TTL', async () => {
    const ctx = new Context()
    const list = vi.fn(async () => [{ name: 'blender-modeling', description: 'd', source: 'custom' }])
    ctx.provide('skills', { list, get: vi.fn() })
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      const signal = new AbortController().signal
      const agent = { id: 'skill-cache-agent', session: { header: { cwd: '/work' } } } as never
      await runtime.listSkills(agent, signal)
      await runtime.listSkills(agent, signal)
      expect(list).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('returns an empty list when the skills service is missing or disabled', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx, undefined, () => ({
      enabled: true,
      enableSkills: false,
      ignoreFiles: [],
      workspaceIgnoreFiles: [],
    }))
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      expect(await runtime.listSkills(agentWith('/work'), new AbortController().signal)).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('caches past-chat candidates on the host for a TTL', async () => {
    const ctx = new Context()
    const listCandidates = vi.fn(async () => [
      { sessionId: 'sess-a', label: 'Payment rates', cwd: '/work', createdAt: 123 },
    ])
    ctx.provide('sessionReferenceResolver', { listCandidates, prepare: vi.fn() })
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      const signal = new AbortController().signal
      const agent = { id: 'chat-cache-agent', session: { header: { cwd: '/work' } } } as never
      await runtime.listChats(agent, 'pay', 5, signal)
      await runtime.listChats(agent, 'pay', 5, signal)
      expect(listCandidates).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('maps skill sources onto the sidebar management tiers', () => {
    expect(plugin.skillTier('user-dsh', undefined)).toBe('user')
    expect(plugin.skillTier('project-agents', undefined)).toBe('project')
    expect(plugin.skillTier('bundled', 'filesystem')).toBe('system')
    expect(plugin.skillTier('bundled', 'dsh-badge')).toBe('system')
    expect(plugin.skillTier('bundled', 'some-plugin')).toBe('plugin')
    expect(plugin.skillTier('weird-source', undefined)).toBe('custom')
  })

  it('lists past chats through the session reference resolver', async () => {
    const ctx = new Context()
    ctx.provide('sessionReferenceResolver', {
      listCandidates: vi.fn(async (_agent: unknown, query: string, _limit: number) => [
        { sessionId: 'sess-a', label: 'Payment rates', cwd: '/work', createdAt: 123 },
      ]),
      prepare: vi.fn(),
    })
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      const candidates = await runtime.listChats(agentWith('/work'), 'pay', 5, new AbortController().signal)
      expect(candidates).toEqual([{
        sessionId: 'sess-a',
        label: 'Payment rates',
        uri: expect.stringMatching(/^dsh-session:/),
        cwd: '/work',
        createdAt: 123,
      }])
    } finally {
      await fiber.dispose()
    }
  })

  it('lists enabled plugins through the plugin inventory', async () => {
    const ctx = new Context()
    // The Harness gateway's list() is async: the sync read this mock once
    // returned was the bug behind `Cannot read properties of undefined`.
    ctx.provide('pluginInventory', {
      list: async () => ({
        entries: [
          { moduleName: 'dsh-atlas', enabled: true },
          { moduleName: 'dsh-off', enabled: false },
        ],
      }),
    })
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atMention') as AtMentionRuntime
      const plugins = await runtime.listPlugins(new AbortController().signal)
      expect(plugins).toEqual([
        { entryId: 'dsh-atlas', moduleName: 'dsh-atlas', enabled: true },
        { entryId: 'dsh-off', moduleName: 'dsh-off', enabled: false },
      ])
    } finally {
      await fiber.dispose()
    }
  })

  it('persists the category toggles through the settings Remote', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      expect(await runtime.updateSettings({ field: 'enableSkills', value: false }))
        .toMatchObject({ enableSkills: false })
      expect(await runtime.updateSettings({ field: 'enableChats', value: false }))
        .toMatchObject({ enableChats: false })
      expect(await runtime.updateSettings({ field: 'enablePlugins', value: false }))
        .toMatchObject({ enablePlugins: false })
      expect(await runtime.updateSettings({ field: 'candidateLimit', value: 12 }))
        .toMatchObject({ candidateLimit: 12 })
      expect(await runtime.updateSettings({ field: 'ignorePastedMentions', value: false }))
        .toMatchObject({ ignorePastedMentions: false })
      expect(await runtime.updateSettings({
        field: 'recentFiles',
        value: [
          { workspace: '/work', files: ['b.ts', 'a.ts', 'b.ts', ''] },
          { workspace: '/work', files: ['dup.ts'] },
        ],
      })).toMatchObject({
        recentFiles: [{ workspace: '/work', files: ['b.ts', 'a.ts'] }],
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('registers the model-facing mention tools when the tools registry is up', async () => {
    const ctx = new Context()
    const registered: string[] = []
    ctx.provide('tools', {
      register: (tool: { name: string }) => {
        registered.push(tool.name)
        return () => {}
      },
    })
    const fiber = await mount(ctx)
    try {
      expect(registered.sort()).toEqual(['past_chats', 'plugin_info', 'read_past_chat'])
    } finally {
      await fiber.dispose()
    }
  })

  it('builds reference expansions that gate on the live settings', async () => {
    const ctx = new Context() as unknown as { get(key: string): unknown }
    const read = () => ({ enabled: true, enableChats: true, enableSkills: true, enablePlugins: true } as AtFileSettings)
    const agent = { session: { header: { cwd: '/work' } } } as never
    const { get } = ctx as unknown as { get(key: string): unknown }
    const skillsFace = {
      list: vi.fn(async () => [{ name: 'blender-modeling', description: 'd' }]),
      get: vi.fn(async () => undefined),
    }
    const inventoryFace = { list: async () => ({ entries: [{ moduleName: 'dsh-atlas', enabled: true }] }) }
    const resolver = { prepare: vi.fn() }
    const stubCtx = {
      get: (key: string) => key === 'skills' ? skillsFace : key === 'sessionReferenceResolver' ? resolver : key === 'pluginInventory' ? inventoryFace : undefined,
    } as unknown as Context
    const expansion = plugin.buildReferenceExpansion(stubCtx, agent, plugin.Config({}), read)
    const messages = [createUserMessage({ content: [{ type: 'text', text: '@skill:blender-modeling @plugin:dsh-atlas' }], source: { kind: 'user' } })]
    const skillRefs = await expansion.expandSkills(messages, new AbortController().signal)
    expect(skillRefs).toHaveLength(1)
    const pluginRefs = await expansion.expandPlugins(messages, new AbortController().signal)
    expect(pluginRefs).toHaveLength(1)
    const chatContext = await expansion.expandChats(messages, new AbortController().signal)
    expect(chatContext).toBeUndefined()
  })
})