/**
 * The default level the folder browser opens at, on both platforms.
 *
 * The reported Linux defect lived here: the Host resolved an empty path against
 * the session workspace (`resolve(cwd, '.')`), so a POSIX user opening the browser
 * landed inside their own project instead of at the top of the filesystem — and
 * then could not climb out, because the root crumb was missing too. On Windows the
 * same code was invisible, because a workspace is reached by picking a drive and
 * the dialog already opened at a drive root.
 *
 * `browseRoot` is asserted through the REAL `list()` seam rather than in isolation:
 * the decision is only worth anything if the composed service actually applies it,
 * and the Windows-visible half of this spec (`''` still means the workspace's own
 * drive root) is what proves the POSIX fix was not bought at Windows' cost.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { AtFileRuntime } from '../src/runtime.ts'
import type { AtFileSettings } from '../src/contract.ts'

/** One structural Agent stub: only the session header the service reads. */
function agentWith(cwd: string | undefined): Agent {
  return { session: { header: { cwd } }, ctx: new Context() } as unknown as Agent
}

/** Mount the function-plugin module on a fresh context (harness test pattern). */
async function mount(ctx: Context, mode: 'danger-full-access' | 'read-only' = 'danger-full-access') {
  const registryFiber = ctx.plugin(
    (await import('@deepseek-ai/dsh-typert-registry')).default,
  )
  await registryFiber
  ctx.provide('settings', {
    register: () => ({
      get: (): AtFileSettings => ({
        enabled: true,
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

describe('the folder browser opens at a top-level place, not inside the workspace', () => {
  it('opens a POSIX session at the filesystem root', async () => {
    // The reported defect, end to end through the service the Gateway calls: an
    // empty path is what the dialog sends when it opens, and on Linux that must
    // land at `/`. Before the fix it landed on the workspace itself, so the first
    // thing a Linux user saw was their own project rather than the places above it.
    if (process.platform === 'win32') return
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.list(agentWith('/home/omarchy/Projects'), '', '', new AbortController().signal)
      expect(listing.path).toBe('/')
      expect(listing.parent).toBeUndefined()
      // `/` is the top: the drive list is the Windows mechanism for climbing out,
      // and it is COLLECTED-but-empty here rather than absent, so the chooser's own
      // "is this a root" test still holds on Linux.
      expect(listing.drives).toEqual([])
      expect(listing.entries.length).toBeGreaterThan(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('falls back to the workspace when the session may not browse the filesystem root', async () => {
    // The fifth defect, and the one the browser caught: `/` is outside every
    // workspace, so in a session without external discovery (`read-only`) the gate
    // below answers the default listing with `error: 'outside'`. Measured on Linux
    // in the real dialog: it opened at `/`, showed the refusal notice and the
    // shortcut list, and no directory at all — the reported symptom, restored.
    //
    // A default level has to be a level this session may walk, so the reachability
    // gate decides it: `danger-full-access` keeps `/` (pinned above), a narrow
    // session opens on the workspace. This case runs on BOTH platforms on purpose:
    // on Windows it is an invariant (the default was already the workspace), and on
    // Linux it is the regression — the Host-side proof that the old code answered
    // a refusal here is the guest run recorded in docs/history-jump.md A.17.9.
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-narrow-'))
    const cwd = join(root, 'workspace')
    await mkdir(join(cwd, 'src'), { recursive: true })
    const ctx = new Context()
    const fiber = await mount(ctx, 'read-only')
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.list(agentWith(cwd), '', '', new AbortController().signal)
      expect(listing.path).toBe(slashed(cwd))
      expect(listing.error).toBeUndefined()
      expect(listing.entries.length).toBeGreaterThan(0)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens a Windows session inside the workspace, exactly as it always did', async () => {
    // The half that must NOT change. On Windows `browseRoot` answers `'.'`, which is
    // the `resolve(cwd, '.')` this call site has always used, so an empty path keeps
    // landing on the workspace. That is not an oversight: the dialog reaches the rest
    // of the machine from the workspace through the `盘符` crumb, which only exists
    // because a listing carries `drives`. POSIX has no such crumb, which is precisely
    // why the same default was a dead end there and is not one here.
    if (process.platform !== 'win32') return
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const cwd = process.cwd()
      const listing = await runtime.list(agentWith(cwd), '', '', new AbortController().signal)
      expect(listing.path).toBe(slashed(cwd))
      // A workspace level is not a drive root, so it offers a way up rather than a
      // drive list — the crumb the Windows user actually uses to leave.
      expect(listing.drives).toBeUndefined()
      expect(listing.parent).toBe(slashed(join(cwd, '..')))
    } finally {
      await fiber.dispose()
    }
  })

  it('still resolves a named relative path against the workspace', async () => {
    // `browseRoot` must only govern the EMPTY path. A named subdirectory is a
    // workspace-relative request and has to keep resolving the old way, or the fix
    // would break every descent the user makes by clicking a folder row.
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-browseroot-'))
    const cwd = join(root, 'workspace')
    await mkdir(join(cwd, 'src'), { recursive: true })
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      const listing = await runtime.list(agentWith(cwd), 'src', '', new AbortController().signal)
      expect(listing.path).toBe(slashed(join(cwd, 'src')))
      expect(listing.parent).toBe(slashed(cwd))
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a session with no workspace before any level is chosen', async () => {
    // The guard that makes the level question moot: without a workspace there is no
    // `cwd` to resolve against, so the service says so instead of guessing a level.
    const ctx = new Context()
    const fiber = await mount(ctx)
    try {
      const runtime = ctx.get('atFile') as AtFileRuntime
      await expect(runtime.list(agentWith(undefined), '', '', new AbortController().signal)).rejects.toThrow(
        'at-file: the session has no workspace directory',
      )
    } finally {
      await fiber.dispose()
    }
  })
})
