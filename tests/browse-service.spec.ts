/**
 * The `atFile/browse` service: what the folder chooser asks for while the user types.
 *
 * `browse` exists because a folder chooser cannot be built out of `list` alone. A
 * half-typed path (`/mnt/EShare/Pro`) must answer with the children of the nearest
 * REAL directory and the spelling that was asked for, and every row must say
 * whether it opens — otherwise the chooser has to guess, and the guesses are what
 * the reported bugs were: an error for every keystroke, and a folder row that was a
 * leap of faith. The two decisions the chooser cannot make for itself live here and
 * are asserted through the real service rather than in isolation:
 *
 * - `browseDefault`: the layer an empty request resolves to. `list` answers an empty
 *   path with `browseRoot` (the filesystem root); `browse` answers it with the
 *   nearest reachable ANCESTOR of the workspace, so the dialog opens somewhere the
 *   session may actually walk instead of on a refusal.
 * - `hasChildren`: attached to every directory row by probing it, under a deadline
 *   that may leave the flag off — but never wrong.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { AtFileRuntime } from '../src/runtime.ts'
import type { AtFileSettings } from '../src/contract.ts'

/** One structural Agent stub: only the session header the service reads. */
function agentWith(cwd: string | undefined): Agent {
  return { session: { header: { cwd } }, ctx: new Context() } as unknown as Agent
}

/** Mount the function-plugin module on a fresh context (harness test pattern). */
async function mount(
  ctx: Context,
  mode: 'danger-full-access' | 'read-only' = 'danger-full-access',
  enabled = true,
) {
  const registryFiber = ctx.plugin(
    (await import('@deepseek-ai/dsh-typert-registry')).default,
  )
  await registryFiber
  ctx.provide('settings', {
    register: () => ({
      get: (): AtFileSettings => ({
        enabled,
        ignoreFiles: [...plugin.DEFAULT_IGNORE_FILES],
        workspaceIgnoreFiles: [],
        ignorePastedMentions: true,
        enableSkills: true,
        enableChats: true,
        enablePlugins: true,
        candidateLimit: 50,
      }),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }),
  })
  ctx.provide('agents', { roots: () => [] })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode }) })
  const fiber = ctx.plugin({ inject: plugin.inject, apply: plugin.apply })
  await fiber
  return fiber
}

const slashed = (value: string): string => value.replaceAll('\\', '/')

/** A workspace with a child that has children, a child that has none, and a file. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-browse-'))
  const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'with-child', 'inner'), { recursive: true })
  await mkdir(join(cwd, 'empty'), { recursive: true })
  await writeFile(join(cwd, 'notes.txt'), 'x', 'utf8')
  return cwd
}

describe('browse answers while the user is still typing', () => {
  it('answers a half-typed name with its longest valid prefix and the spelling asked for', async () => {
    // The keystroke case: `/workspace/sr` does not exist, and the useful answer is
    // the children of `/workspace` filtered by `sr` — not an error.
    const cwd = await workspace()
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const asked = join(cwd, 'sr')
      const listing = await runtime.browse(agentWith(cwd), asked, new AbortController().signal)
      expect(slashed(listing.path)).toBe(slashed(cwd))
      expect(listing.error).toBeUndefined()
      expect(slashed(listing.requested ?? '')).toBe(slashed(asked))
      // The chooser SLICES the needle out of `requested` with `path` as the prefix,
      // so a `requested` that does not start with `path` would filter on nonsense.
      expect(slashed(listing.requested ?? '').startsWith(slashed(listing.path))).toBe(true)
      expect(listing.entries.some(entry => entry.name === 'with-child')).toBe(true)
    } finally {
      await fiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })

  it('walks up from a file name exactly like from a missing name', async () => {
    // Naming a file is the same shape of promise as naming a half-typed folder.
    const cwd = await workspace()
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.browse(
        agentWith(cwd),
        join(cwd, 'notes.txt'),
        new AbortController().signal,
      )
      expect(slashed(listing.path)).toBe(slashed(cwd))
      expect(slashed(listing.requested ?? '')).toBe(slashed(join(cwd, 'notes.txt')))
    } finally {
      await fiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })

  it('carries no `requested` when the path named a real directory', async () => {
    // A flag the chooser reads: "you are exactly where you asked to be".
    const cwd = await workspace()
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.browse(agentWith(cwd), cwd, new AbortController().signal)
      expect(listing.requested).toBeUndefined()
      expect(listing.path).toBeDefined()
    } finally {
      await fiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })

  it('says whether each row opens, so a row is not a leap of faith', async () => {
    const cwd = await workspace()
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.browse(agentWith(cwd), cwd, new AbortController().signal)
      const byName = new Map(listing.entries.map(entry => [entry.name, entry]))
      expect(byName.get('with-child')?.hasChildren).toBe(true)
      expect(byName.get('empty')?.hasChildren).toBe(false)
      // A file is not a directory and never carries the flag.
      expect(byName.get('notes.txt')?.hasChildren).toBeUndefined()
    } finally {
      await fiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })

  it('answers a path that climbs past every real directory with what it did find', async () => {
    // There is no "not found" on POSIX: `/` is always a directory, so the walk-up
    // ends there. Windows has a genuinely absent top (a drive that does not exist),
    // and that is the only shape that reports `missing`.
    const cwd = await workspace()
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      // The asked-for spelling is per platform because only one shape is absent
      // at the TOP: `Z:/x` is absolute on Windows, where drive Z: need not
      // exist, while on POSIX that same text is a RELATIVE path (folded under
      // the cwd, which always exists). The POSIX shape that climbs past every
      // real directory is an absent child of `/`.
      const asked = process.platform === 'win32' ? 'Z:/no-such-place' : '/no-such-place'
      const listing = await runtime.browse(agentWith(cwd), asked, new AbortController().signal)
      if (process.platform === 'win32') {
        expect(listing.error).toBe('missing')
        expect(listing.entries).toEqual([])
      } else {
        expect(listing.path).toBe('/')
        expect(listing.error).toBeUndefined()
      }
    } finally {
      await fiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })
})

describe('browse respects the same gate as every other reference', () => {
  it('refuses a level outside what the session may reach', async () => {
    // The refusal is DATA, not a throw: the chooser shows it in the tree.
    const cwd = await workspace()
    const outside = dirname(cwd)
    const ctx = new Context()
    const fiber = await mount(ctx, 'read-only')
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.browse(agentWith(cwd), outside, new AbortController().signal)
      expect(listing.error).toBe('outside')
      expect(listing.entries).toEqual([])
      // The path still names the place that was refused, so the dialog can say which.
      expect(slashed(listing.path)).toBe(slashed(outside))
    } finally {
      await fiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })

  it('opens an empty request on the nearest reachable ancestor, not on a refusal', async () => {
    // `browseDefault`. With full access that is the workspace's parent; with a
    // narrow session there is nothing above the workspace to step up to, so the
    // workspace itself is the floor.
    const cwd = await workspace()
    const wide = new Context()
    const wideFiber = await mount(wide, 'danger-full-access')
    const narrow = new Context()
    const narrowFiber = await mount(narrow, 'read-only')
    try {
      const wideListing = await (wide.get('atFile') as AtFileRuntime)
        .browse(agentWith(cwd), '', new AbortController().signal)
      expect(slashed(wideListing.path)).toBe(slashed(dirname(cwd)))
      expect(wideListing.error).toBeUndefined()
      // An empty request is not the same as `list`'s empty request: `list` opens at
      // the filesystem root, `browse` at the layer the dialog should show.
      const narrowListing = await (narrow.get('atFile') as AtFileRuntime)
        .browse(agentWith(cwd), '', new AbortController().signal)
      expect(slashed(narrowListing.path)).toBe(slashed(cwd))
      expect(narrowListing.error).toBeUndefined()
    } finally {
      await wideFiber.dispose()
      await narrowFiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })

  it('refuses a session with no workspace before any level is chosen', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      await expect(runtime.browse(agentWith(undefined), '', new AbortController().signal)).rejects.toThrow(
        'at-file: the session has no workspace directory',
      )
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses everything while the plugin is switched off', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx, 'danger-full-access', false)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      await expect(runtime.browse(agentWith(process.cwd()), '', new AbortController().signal)).rejects.toThrow(
        'at-file is disabled in Settings',
      )
    } finally {
      await fiber.dispose()
    }
  })
})

describe('browse reaches the top of the machine', () => {
  it('names the level a folder came from, so the dialog can offer a way up', async () => {
    const cwd = await workspace()
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.browse(agentWith(cwd), join(cwd, 'with-child'), new AbortController().signal)
      expect(slashed(listing.parent ?? '')).toBe(slashed(cwd))
    } finally {
      await fiber.dispose()
      await rm(dirname(cwd), { recursive: true, force: true })
    }
  })

  it('answers a filesystem root with the drives this machine has, never absent', async () => {
    // `/` on POSIX and a drive root on Windows are both "the top": the field is
    // COLLECTED, so an empty array still proves the chooser asked the right question
    // (a missing field is what made Linux render a drive crumb with nothing behind it).
    const top = process.platform === 'win32' ? 'C:/' : '/'
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.browse(agentWith(process.cwd()), top, new AbortController().signal)
      expect(Array.isArray(listing.drives)).toBe(true)
      expect(listing.parent).toBeUndefined()
      expect(listing.entries.length).toBeGreaterThan(0)
      if (process.platform === 'win32') expect(listing.drives?.length).toBeGreaterThan(0)
      else expect(listing.drives).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })
})
