/**
 * Workspace indexing behavior: bounded traversal, ignored directories,
 * symlink exclusion, deterministic paths, and cancellation.
 */
import type { Dir, Dirent } from 'node:fs'
import { mkdtemp, mkdir, opendir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { indexWorkspace, listSubdirectories, readDirectory } from '../src/files.ts'
import { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES } from '../src/defaults.ts'

/** Whether the fixture's directory symlink could be created (Windows needs Developer Mode or elevation). */
let linksAvailable = false

/**
 * Create the symlink the fixture uses, reporting whether the OS allowed it.
 *
 * Windows refuses `symlink` when the process holds neither
 * `SeCreateSymbolicLinkPrivilege` (elevated) nor Developer Mode, and answers
 * EPERM. The tree is still a perfectly good fixture then — only the symlink
 * assertion has nothing to look at, so it skips instead of failing the run.
 * @param target - the link's target.
 * @param path - the link to create.
 * @returns whether the link exists afterwards.
 */
async function createLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'dir')
    return true
  } catch {
    return false
  }
}

/** Build a fresh fixture tree and hand back its root (caller removes it). */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-'))
  await mkdir(join(root, 'src', 'client'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, '.git', 'objects'), { recursive: true })
  await mkdir(join(root, 'empty'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# root\n')
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
  await writeFile(join(root, 'src', 'client', 'view.ts'), 'export {}\n')
  await writeFile(join(root, 'node_modules', 'pkg', 'ignored.ts'), 'ignored\n')
  await writeFile(join(root, '.git', 'config'), '[core]\n')
  linksAvailable = await createLink(join(root, 'src'), join(root, 'linked-src'))
  await writeFile(join(root, 'data.bin'), Buffer.from([0x00, 0x01, 0x02]))
  return root
}

describe('indexWorkspace', () => {
  it('collects file and directory paths without inspecting file content', async () => {
    const root = await fixture()
    try {
      const { files, truncated } = await indexWorkspace(root, { maxFiles: 100, ignoreDirs: ['.git', 'node_modules'], ignoreFiles: [] })
      expect(truncated).toBe(false)
      expect(files.map(file => `${file.kind}:${file.relative}`)).toEqual([
        'file:README.md',
        'file:data.bin',
        'dir:empty',
        'dir:src',
        'dir:src/client',
        'file:src/client/view.ts',
        'file:src/index.ts',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips ignore dirs and symlinks', async (context) => {
    const root = await fixture()
    try {
      // No symlink was created (Windows without Developer Mode or elevation),
      // so there is nothing to assert about following one.
      if (!linksAvailable) return context.skip()
      const { files } = await indexWorkspace(root, { maxFiles: 100, ignoreDirs: ['.git', 'node_modules'], ignoreFiles: [] })
      const relatives = files.map(file => file.relative)
      expect(relatives).toContain('src/index.ts')
      expect(relatives).toContain('data.bin')
      expect(relatives.some(path => path.includes('node_modules'))).toBe(false)
      expect(relatives.some(path => path.includes('.git'))).toBe(false)
      expect(relatives.some(path => path.startsWith('linked-src'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('default ignores remove common IDE metadata, caches, dependencies, and build output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-default-ignore-'))
    const ignored = [
      '.idea', '.vs', '.vscode', '.settings', '.gradle', '.cxx', 'build', 'bin', 'target',
      'cmake-build-debug', '.pytest_cache', 'DerivedData', 'node_modules',
    ]
    try {
      for (const directory of ignored) {
        await mkdir(join(root, directory), { recursive: true })
        await writeFile(join(root, directory, 'noise.txt'), 'noise\n')
      }
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'main.kt'), 'fun main() {}\n')

      const { files } = await indexWorkspace(root, { maxFiles: 100, ignoreDirs: DEFAULT_IGNORE_DIRS, ignoreFiles: [] })
      const relatives = files.map(file => file.relative)
      expect(relatives).toContain('src/main.kt')
      for (const directory of ignored) {
        expect(relatives.some(path => path === directory || path.startsWith(`${directory}/`))).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('carries the absolute path on every entry', async () => {
    const root = await fixture()
    try {
      const { files } = await indexWorkspace(root, { maxFiles: 100, ignoreDirs: [], ignoreFiles: [] })
      expect(files.find(file => file.relative === 'README.md')?.path).toBe(join(root, 'README.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops at the entry cap and reports truncation honestly', async () => {
    const root = await fixture()
    try {
      const { files, truncated } = await indexWorkspace(root, { maxFiles: 2, ignoreDirs: ['.git', 'node_modules'], ignoreFiles: [] })
      expect(files).toHaveLength(2)
      expect(truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a missing root with a readable error', async () => {
    await expect(indexWorkspace(
      join(tmpdir(), 'dsh-atlas-missing-root'),
      { maxFiles: 10, ignoreDirs: [], ignoreFiles: [] },
      new AbortController().signal,
    )).rejects.toThrow(/cannot list/)
  })

  it('skips a child directory that cannot be opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-unreadable-open-'))
    const blocked = join(root, 'blocked')
    await mkdir(blocked)
    await writeFile(join(root, 'keep.txt'), 'keep\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { files } = await indexWorkspace(root, {
        maxFiles: 10,
        ignoreDirs: [],
        ignoreFiles: [],
      }, undefined, async (dir) => {
        if (dir === blocked) throw new Error('permission denied')
        return opendir(dir)
      })
      expect(files.map(file => file.relative)).toEqual(['blocked', 'keep.txt'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`skipping unreadable directory "${blocked}"`))
    } finally {
      warn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the partial index when a directory read stops early', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-unreadable-read-'))
    const blocked = join(root, 'blocked')
    await mkdir(blocked)
    await writeFile(join(blocked, 'first.txt'), 'first\n')
    await writeFile(join(root, 'keep.txt'), 'keep\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { files } = await indexWorkspace(root, {
        maxFiles: 10,
        ignoreDirs: [],
        ignoreFiles: [],
      }, undefined, async (dir) => {
        const handle = await opendir(dir)
        if (dir !== blocked) return handle
        let first = true
        return {
          read: async () => {
            if (first) {
              first = false
              return handle.read()
            }
            throw new Error('read denied')
          },
          close: async () => handle.close(),
        } as Dir
      })
      expect(files.map(file => file.relative)).toEqual(['blocked', 'blocked/first.txt', 'keep.txt'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`stopped reading directory "${blocked}"`))
    } finally {
      warn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps cancellation fatal while a directory read is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-abort-read-'))
    const controller = new AbortController()
    const handle = {
      read: () => new Promise<never>(() => {}),
      close: async () => {},
    } as unknown as Dir
    try {
      const indexing = indexWorkspace(root, {
        maxFiles: 10,
        ignoreDirs: [],
        ignoreFiles: [],
      }, controller.signal, async () => handle)
      await Promise.resolve()
      controller.abort(new Error('read cancelled'))
      await expect(indexing).rejects.toThrow('read cancelled')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('races the walk against an already-aborted signal', async () => {
    const root = await fixture()
    try {
      const controller = new AbortController()
      controller.abort(new Error('gone'))
      await expect(indexWorkspace(root, { maxFiles: 10, ignoreDirs: [], ignoreFiles: [] }, controller.signal)).rejects.toThrow('gone')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('wraps a non-Error abort reason into an Error', async () => {
    const root = await fixture()
    try {
      const controller = new AbortController()
      controller.abort('plain reason')
      await expect(indexWorkspace(root, { maxFiles: 10, ignoreDirs: [], ignoreFiles: [] }, controller.signal)).rejects.toThrow('plain reason')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips non-file dirents such as named pipes', async (context) => {
    if (process.platform === 'win32') return context.skip()
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-fifo-'))
    const { execFileSync } = await import('node:child_process')
    execFileSync('mkfifo', [join(root, 'pipe')])
    try {
      const { files } = await indexWorkspace(root, { maxFiles: 10, ignoreDirs: [], ignoreFiles: [] })
      expect(files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips configured file basenames case-insensitively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-file-ignore-'))
    try {
      await writeFile(join(root, 'desktop.ini'), 'metadata\n')
      await writeFile(join(root, 'THUMBS.DB'), 'metadata\n')
      await writeFile(join(root, '.DS_Store'), 'metadata\n')
      await writeFile(join(root, 'keep.ini'), 'keep\n')
      const { files } = await indexWorkspace(root, {
        maxFiles: 100,
        ignoreDirs: [],
        ignoreFiles: DEFAULT_IGNORE_FILES,
      })
      expect(files.map(file => file.relative)).toEqual(['keep.ini'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes empty and duplicate file filters without hiding other files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-file-ignore-'))
    try {
      await writeFile(join(root, 'noise.log'), 'noise\n')
      await writeFile(join(root, 'keep.log'), 'keep\n')
      const { files } = await indexWorkspace(root, {
        maxFiles: 100,
        ignoreDirs: [],
        ignoreFiles: [' noise.log ', 'NOISE.LOG', ''],
      })
      expect(files.map(file => file.relative)).toEqual(['keep.log'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies exact and regular-expression rules with independent case sensitivity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-regex-ignore-'))
    try {
      for (const name of ['exact.tmp', 'bundle.map', 'BUNDLE.MAP', 'keep.ts']) {
        await writeFile(join(root, name), 'fixture\n')
      }
      const { files } = await indexWorkspace(root, {
        maxFiles: 100,
        ignoreDirs: [],
        ignoreFiles: [
          { kind: 'exact', pattern: 'Exact.TMP', caseSensitive: true },
          { kind: 'regex', pattern: '\\.map$', caseSensitive: false },
        ],
      })
      expect(files.map(file => file.relative)).toEqual(['exact.tmp', 'keep.ts'])

      const sensitive = await indexWorkspace(root, {
        maxFiles: 100,
        ignoreDirs: [],
        ignoreFiles: [
          { kind: 'exact', pattern: 'exact.tmp', caseSensitive: true },
          { kind: 'regex', pattern: '\\.MAP$', caseSensitive: true },
        ],
      })
      expect(sensitive.files.map(file => file.relative)).toContain('bundle.map')
      expect(sensitive.files.map(file => file.relative)).not.toContain('BUNDLE.MAP')
      expect(sensitive.files.map(file => file.relative)).not.toContain('exact.tmp')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('listSubdirectories', () => {
  it('lists one level of directories only, name-sorted and bounded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-siblings-'))
    try {
      // Two sibling checkouts, one file, one ignored directory, one nested dir
      // (which must NOT appear: the listing is one level, never a walk), and one
      // symlinked directory.
      await mkdir(join(root, 'dsh-atlas', 'nested'), { recursive: true })
      await mkdir(join(root, 'deepseek-harness'), { recursive: true })
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await writeFile(join(root, 'README.md'), 'x\n')
      const linked = await createLink(join(root, 'deepseek-harness'), join(root, 'link-to-harness'))

      const found = await listSubdirectories(root, {
        limit: 10,
        ignoreDirs: DEFAULT_IGNORE_DIRS,
      })
      const names = found.map(entry => entry.slice(root.length + 1))
      // Name-sorted, no files, no nested directories, no ignored names, and no
      // symlinked directories (the fixture's link, when the OS allowed one, is
      // skipped by the same rule the workspace walk uses).
      expect(names).toEqual(['deepseek-harness', 'dsh-atlas'])
      expect(found.every(entry => entry.startsWith(root))).toBe(true)
      if (linked) expect(names).not.toContain('link-to-harness')

      // The cap is honored.
      expect(await listSubdirectories(root, { limit: 1, ignoreDirs: [] })).toHaveLength(1)
      // An unreadable directory is an error, not an empty list: the endpoint's
      // caller decides what to do about it.
      await expect(listSubdirectories(join(root, 'missing'), { limit: 5, ignoreDirs: [] }))
        .rejects.toThrow(/cannot list/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skipHidden excludes dot-directories BEFORE the cap, so they never spend it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-hidden-'))
    try {
      // The directory above a working tree is mostly dot-directories: with the
      // cap applied first they ate every slot and the visible siblings — the only
      // ones worth offering — never appeared (measured live: 11 slots, 8 taken by
      // caches, two folders left).
      for (let index = 0; index < 6; index += 1) {
        await mkdir(join(root, `.cache-${String(index)}`))
      }
      await mkdir(join(root, 'deepseek-harness'))
      await mkdir(join(root, 'dsh-arcade'))
      const options = { limit: 2, ignoreDirs: [] as readonly string[], skipHidden: true }
      const names = (await listSubdirectories(root, options)).map(entry => entry.slice(root.length + 1))
      expect(names).toEqual(['deepseek-harness', 'dsh-arcade'])
      // Without the flag the same bounded listing is spent on dot-names, which is
      // exactly the behaviour the flag exists to replace (not an accident).
      const unfiltered = await listSubdirectories(root, { limit: 2, ignoreDirs: [] })
      expect(unfiltered.map(entry => entry.slice(root.length + 1))).toEqual(['.cache-0', '.cache-1'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers a linked directory only when the caller follows links', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-linked-'))
    try {
      await mkdir(join(root, 'dsh-arcade'))
      // The checkout beside a workspace is often a junction rather than a real
      // directory (measured live: `deepseek-harness` next to this repo points into
      // D:), and the recursive walk skips links outright — this one-level listing
      // is where following one is both safe (no cycle is possible) and the point.
      if (!await createLink(join(root, 'dsh-arcade'), join(root, 'deepseek-harness'))) return context.skip()
      const base = { limit: 10, ignoreDirs: [] as readonly string[] }
      expect((await listSubdirectories(root, base)).map(entry => entry.slice(root.length + 1)))
        .toEqual(['dsh-arcade'])
      expect((await listSubdirectories(root, { ...base, followLinks: true })).map(entry => entry.slice(root.length + 1)))
        .toEqual(['deepseek-harness', 'dsh-arcade'])
      // A link that resolves to nothing is left out rather than offered as a
      // folder that cannot open.
      await rm(join(root, 'dsh-arcade'), { recursive: true, force: true })
      expect((await listSubdirectories(root, { ...base, followLinks: true })).map(entry => entry.slice(root.length + 1)))
        .toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('follows a linked directory through the opener seam on any platform', async () => {    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-linkstub-'))
    try {
      // A REAL symlink cannot be created on Windows without Developer Mode or
      // elevation (the case above skips there), so this one drives the same two
      // arms through the opener seam: the listing is stubbed, the `stat` it then
      // performs is real.
      await mkdir(join(root, 'linked'))
      await mkdir(join(root, 'real'))
      const direntOf = (name: string, kind: 'dir' | 'link'): Dirent => ({
        name,
        isDirectory: () => kind === 'dir',
        isSymbolicLink: () => kind === 'link',
      }) as unknown as Dirent
      // 'dead' names no directory at all: a broken link must not be offered.
      const open = async (): Promise<Dir> => {
        const entries = [direntOf('linked', 'link'), direntOf('real', 'dir'), direntOf('dead', 'link')]
        let index = 0
        return {
          read: async () => (index < entries.length ? entries[index++] as Dirent : null),
          close: async () => undefined,
        } as unknown as Dir
      }
      const base = { limit: 10, ignoreDirs: [] as readonly string[] }
      expect((await listSubdirectories(root, base, undefined, open)).map(entry => entry.slice(root.length + 1)))
        .toEqual(['real'])
      expect((await listSubdirectories(root, { ...base, followLinks: true }, undefined, open))
        .map(entry => entry.slice(root.length + 1))).toEqual(['linked', 'real'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('readDirectory', () => {
  it('lists one level with both kinds, directories first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-list-'))
    try {
      await mkdir(join(root, 'zeta'))
      await mkdir(join(root, 'alpha'))
      await writeFile(join(root, 'b.txt'), 'x\n')
      await writeFile(join(root, 'a.md'), 'x\n')
      // A nested directory must NOT appear: the listing is one level, never a walk.
      await mkdir(join(root, 'alpha', 'deeper'))
      const { entries, truncated } = await readDirectory(root, 10)
      expect(entries).toEqual([
        { name: 'alpha', kind: 'dir' },
        { name: 'zeta', kind: 'dir' },
        { name: 'a.md', kind: 'file' },
        { name: 'b.txt', kind: 'file' },
      ])
      expect(truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('caps the listing and says so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-listcap-'))
    try {
      for (let index = 0; index < 5; index += 1) await mkdir(join(root, `dir-${String(index)}`))
      const capped = await readDirectory(root, 2)
      expect(capped.entries).toHaveLength(2)
      expect(capped.truncated).toBe(true)
      // A missing directory is an error, not an empty folder.
      await expect(readDirectory(join(root, 'missing'), 5)).rejects.toThrow(/cannot list/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a link as what it points at', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-listlink-'))
    try {
      await mkdir(join(root, 'real'))
      if (!await createLink(join(root, 'real'), join(root, 'linked'))) return context.skip()
      const { entries } = await readDirectory(root, 20)
      expect(entries.find(entry => entry.name === 'linked')).toEqual({ name: 'linked', kind: 'dir' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
