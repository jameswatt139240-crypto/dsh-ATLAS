/**
 * Read-only reference inspection: existence, kind, and entry-metadata size.
 * These rows back the dock's cost hint and missing-reference flag, so the size
 * must come from the directory entry — never from reading the file.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectReferences } from '../src/reference.ts'
import { externalAccess } from '../src/external.ts'

/** One fresh workspace root for a spec. */
async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-atlas-reference-'))
}

describe('inspectReferences', () => {
  it('reports a file size taken from entry metadata', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.ts'), 'x'.repeat(4096))
    try {
      const infos = await inspectReferences(root, ['a.ts'], new AbortController().signal)
      expect(infos).toEqual([{ relative: 'a.ts', exists: true, kind: 'file', size: 4096 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a directory without a size', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    try {
      const infos = await inspectReferences(root, ['src'], new AbortController().signal)
      expect(infos).toEqual([{ relative: 'src', exists: true, kind: 'dir' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps request order and marks unknown targets as missing', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.ts'), 'x')
    await mkdir(join(root, 'src'), { recursive: true })
    try {
      const infos = await inspectReferences(root, ['src', 'missing.ts', 'a.ts'], new AbortController().signal)
      expect(infos.map(info => info.relative)).toEqual(['src', 'missing.ts', 'a.ts'])
      expect(infos[1]).toEqual({ relative: 'missing.ts', exists: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts an absolute target inside the workspace and refuses escaping ones', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.ts'), 'x')
    try {
      const infos = await inspectReferences(
        root,
        [join(root, 'a.ts'), '../outside.ts'],
        new AbortController().signal,
      )
      // The absolute spelling of a workspace file IS a workspace file (m05904): the
      // desktop hands the plugin exactly such paths (`/mnt/...` on the guest,
      // `E:\...` here), and refusing them painted the dock's reference stale for a
      // file the user could see. `relative` keeps the path exactly as it was typed,
      // because that string is what keys the composer chip (`DraftLinks.tsx` matches
      // the row back to its token through it).
      expect(infos[0]).toEqual({ relative: join(root, 'a.ts'), exists: true, kind: 'file', size: 1 })
      // A path that climbs out of the workspace is still refused, with no access
      // granted here at all.
      expect(infos[1]).toEqual({ relative: '../outside.ts', exists: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('inspects an out-of-workspace path only when the session may reference it', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-atlas-outside-'))
    const file = join(outside, 'far.ts')
    await writeFile(file, 'abcd')
    try {
      // Ledger-only access: the path must lie inside a ledger directory.
      const narrow = externalAccess('workspace-write', [outside])
      const allowed = await inspectReferences(root, [file], new AbortController().signal, narrow)
      // The row is reported by its canonical ABSOLUTE path and marked outside,
      // so the dock can never mistake it for a workspace reference.
      expect(allowed).toEqual([{
        relative: file.replaceAll('\\', '/'),
        exists: true,
        kind: 'file',
        size: 4,
        outside: true,
      }])
      // The same path with no access at all, and a path outside the ledger root.
      expect(await inspectReferences(root, [file], new AbortController().signal)).toEqual([
        { relative: file, exists: false },
      ])
      const sibling = await mkdtemp(join(tmpdir(), 'dsh-atlas-other-'))
      await writeFile(join(sibling, 'a.ts'), 'x')
      try {
        const refused = await inspectReferences(root, [join(sibling, 'a.ts')], new AbortController().signal, narrow)
        expect(refused).toEqual([{ relative: join(sibling, 'a.ts'), exists: false }])
      } finally {
        await rm(sibling, { recursive: true, force: true })
      }
      // Full access discovers it without any ledger.
      const full = await inspectReferences(root, [file], new AbortController().signal, externalAccess('danger-full-access', []))
      expect(full[0]).toMatchObject({ exists: true, outside: true })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('honors cancellation before touching the filesystem', async () => {
    const root = await workspace()
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(inspectReferences(root, ['a.ts'], controller.signal)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns an empty list for no targets', async () => {
    const root = await workspace()
    try {
      expect(await inspectReferences(root, [], new AbortController().signal)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
