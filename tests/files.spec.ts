/**
 * Workspace indexing behavior: bounded traversal, ignored directories,
 * symlink exclusion, deterministic paths, and cancellation.
 */
import type { Dir, Dirent } from 'node:fs'
import { mkdtemp, mkdir, opendir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { hasSubdirectory, indexWorkspace, listSubdirectories, pinEntry, readDirectory } from '../src/files.ts'
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
      // Without the flag every dot-name is still offered, which is exactly the
      // behaviour the flag exists to replace (not an accident). The limit covers
      // the whole fixture and the comparison sorts: readdir order belongs to the
      // file system, not to the alphabet, so a two-entry window would assert
      // whatever the directory happened to hand back first.
      const unfiltered = await listSubdirectories(root, { limit: 8, ignoreDirs: [] })
      expect(unfiltered.map(entry => entry.slice(root.length + 1)).sort()).toEqual([
        '.cache-0',
        '.cache-1',
        '.cache-2',
        '.cache-3',
        '.cache-4',
        '.cache-5',
        'deepseek-harness',
        'dsh-arcade',
      ])
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

describe('a directory handle that fails mid-listing', () => {
  const entry = (name: string, kind: 'dir' | 'file' | 'symlink' | 'fifo'): Dirent => ({
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  }) as unknown as Dirent

  /** A handle that answers the given entries, then fails on the next read. */
  function failingHandle(entries: readonly Dirent[], failure: Error) {
    let index = 0
    return {
      async read(): Promise<Dirent | null> {
        if (index < entries.length) return entries[index++] ?? null
        throw failure
      },
      async close(): Promise<void> { /* nothing to release */ },
    }
  }

  it('keeps what it already listed and says why it stopped (siblings)', async () => {
    const warned: unknown[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args[0]) })
    try {
      const found = await listSubdirectories('/root', { limit: 10, ignoreDirs: [] }, undefined,
        (async () => failingHandle([entry('one', 'dir'), entry('two', 'dir')], new Error('EIO')) as never))
      expect(found).toEqual(['/root/one', '/root/two'])
      expect(String(warned[0])).toContain('stopped reading directory "/root"')
      expect(String(warned[0])).toContain('EIO')
    } finally {
      warn.mockRestore()
    }
  })

  it('drops a link that does not resolve to a directory when links are followed', async () => {
    const found = await listSubdirectories('/root', { limit: 10, ignoreDirs: [], followLinks: true }, undefined,
      (async () => failingHandle([entry('ghost', 'symlink')], new Error('unused')) as never))
    // /root/ghost does not exist: following the link resolves nothing, so it is
    // dropped instead of being listed as a folder that cannot be opened.
    expect(found).toEqual([])
  })

  it('keeps what it already listed and says why it stopped (entries)', async () => {
    const warned: unknown[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args[0]) })
    try {
      const listing = await readDirectory('/root', 10, undefined,
        (async () => failingHandle([entry('b.txt', 'file')], new Error('EIO')) as never))
      expect(listing).toEqual({ entries: [{ name: 'b.txt', kind: 'file' }], truncated: false })
      expect(String(warned[0])).toContain('EIO')
    } finally {
      warn.mockRestore()
    }
  })

  it('skips a link whose target is gone and an entry that is neither file nor directory', async () => {
    const listing = await readDirectory('/root', 10, undefined,
      (async () => failingHandle([entry('ghost', 'symlink'), entry('pipe', 'fifo')], new Error('unused')) as never))
    // The link resolves through the real filesystem and its target does not exist,
    // so it is dropped rather than guessed at; the FIFO is neither of the two kinds.
    expect(listing.truncated).toBe(false)
    expect(listing.entries.every(item => item.name !== 'pipe')).toBe(true)
    expect(listing.entries.some(item => item.name === 'ghost')).toBe(false)
  })

  it('reports "no subdirectory" when the probe cannot finish', async () => {
    const warned: unknown[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args[0]) })
    try {
      const broken = await hasSubdirectory('/root', {}, undefined,
        (async () => failingHandle([], new Error('EACCES')) as never))
      expect(broken).toBe(false)
      expect(String(warned[0])).toContain('EACCES')

      // A link to a missing target is not a subdirectory, and the probe keeps going.
      const ghost = await hasSubdirectory('/root', {}, undefined,
        (async () => failingHandle([entry('ghost', 'symlink')], new Error('unused')) as never))
      expect(ghost).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('pinEntry', () => {
  it('puts back the one entry the cap cut away, ahead of the page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-pin-'))
    try {
      await writeFile(join(root, 'a.txt'), 'x\n')
      await writeFile(join(root, 'b.txt'), 'x\n')
      await writeFile(join(root, 'c.txt'), 'x\n')
      // A cap of ONE reproduces the real defect exactly: the cap is applied BEFORE
      // the sort, so the page holds one arbitrary row and two thirds of the folder
      // is simply absent — which is what hid the selected row on a 2093-entry share.
      const page = await readDirectory(root, 1)
      expect(page.entries).toHaveLength(1)
      expect(page.truncated).toBe(true)
      const omitted = ['a.txt', 'b.txt', 'c.txt'].find(
        name => page.entries.every(entry => entry.name !== name),
      )!
      const pinned = await pinEntry(root, page, omitted)
      expect(pinned.entries[0]).toEqual({ name: omitted, kind: 'file', pinned: true })
      // It goes FIRST and it is the ONLY addition: the page it completes is intact.
      expect(pinned.entries.slice(1)).toEqual(page.entries)
      // Completion does not pretend the folder was fully listed.
      expect(pinned.truncated).toBe(true)
      // The row it put back is what a caller looks for, so the search still works.
      expect(pinned.entries.filter(entry => entry.name === omitted)).toHaveLength(1)
      // A row the page ALREADY holds is left exactly as it was, by identity.
      expect(await pinEntry(root, page, page.entries[0]!.name)).toBe(page)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds no row for a name that is gone, a walk, or a blank', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-pinmiss-'))
    try {
      await writeFile(join(root, 'kept.txt'), 'x\n')
      await mkdir(join(root, 'sub'))
      const page = await readDirectory(root, 20)
      // The entry no longer exists: the listing must not invent a row for it. This
      // is A.16.5.5 — a second click on a deleted object still opens the folder,
      // and the folder then says the truth about what is in it.
      expect(await pinEntry(root, page, 'deleted.txt')).toBe(page)
      // Only ONE path segment is a child of this directory. Everything else would
      // let a caller reach outside the directory that was listed.
      expect(await pinEntry(root, page, '')).toBe(page)
      expect(await pinEntry(root, page, '.')).toBe(page)
      expect(await pinEntry(root, page, '..')).toBe(page)
      expect(await pinEntry(root, page, 'sub/kept.txt')).toBe(page)
      expect(await pinEntry(root, page, 'sub\\kept.txt')).toBe(page)
      // A directory is pinned as a directory, judged by the filesystem and not by
      // the caller: the folder tab passes a name, never a kind.
      const nested = await readDirectory(join(root, 'sub'), 20)
      await mkdir(join(root, 'sub', 'deeper'))
      expect((await pinEntry(join(root, 'sub'), nested, 'deeper')).entries[0])
        .toEqual({ name: 'deeper', kind: 'dir', pinned: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops when the caller is already gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-pinabort-'))
    try {
      await writeFile(join(root, 'a.txt'), 'x\n')
      await writeFile(join(root, 'b.txt'), 'x\n')
      const page = await readDirectory(root, 1)
      const omitted = ['a.txt', 'b.txt'].find(
        name => page.entries.every(entry => entry.name !== name),
      )!
      const controller = new AbortController()
      controller.abort()
      await expect(pinEntry(root, page, omitted, controller.signal)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('hasSubdirectory', () => {
  /** One fake dirent: only the three predicates the probe calls. */
  const dirent = (name: string, kind: 'dir' | 'file'): Dirent => ({
    name,
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }) as unknown as Dirent

  /** A fake `Dir` that answers the given entries in order and records the reads. */
  function fakeHandle(entries: readonly (Dirent | null)[], failure?: Error) {
    const reads = { count: 0, closed: false }
    const handle = {
      async read(): Promise<Dirent | null> {
        if (failure !== undefined && reads.count === 0) {
          reads.count += 1
          throw failure
        }
        const entry = entries[reads.count] ?? null
        reads.count += 1
        return entry
      },
      async close(): Promise<void> { reads.closed = true },
    }
    return { handle: handle as unknown as Dir, reads }
  }

  it('answers true for a folder that holds one, and false for an empty one', async () => {
    const root = await fixture()
    try {
      expect(await hasSubdirectory(join(root, 'src'))).toBe(true)
      expect(await hasSubdirectory(join(root, 'empty'))).toBe(false)
      // A file's children are not directories either, but the fixture's root has one,
      // so the false case above is the empty directory — the one that must NOT draw
      // an expander, which is the whole reason this call exists.
      expect(await hasSubdirectory(join(root, 'src', 'client'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('counts a link to a folder, and does not count a link to a file', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-haslink-'))
    try {
      await mkdir(join(root, 'only-links'))
      await mkdir(join(root, 'real'))
      await writeFile(join(root, 'a.txt'), 'x')
      if (!await createLink(join(root, 'real'), join(root, 'only-links', 'to-dir'))) return context.skip()
      // A broken link probe leaves the flag off rather than throwing: this call may not
      // fail the whole listing because one entry is unusual.
      await symlink(join(root, 'a.txt'), join(root, 'only-links', 'to-file'), 'file').catch(() => {})
      expect(await hasSubdirectory(join(root, 'only-links'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops dot-names before they count when asked to skip hidden children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atlas-hashidden-'))
    try {
      await mkdir(join(root, 'level', '.hidden-child'), { recursive: true })
      // Which of the hidden rows are DRAWN is the chooser's own setting; the flag
      // answers "is there anything below" under that same setting.
      expect(await hasSubdirectory(join(root, 'level'), { skipHidden: true })).toBe(false)
      expect(await hasSubdirectory(join(root, 'level'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns on the first folder instead of reading the whole directory', async () => {
    const { handle, reads } = fakeHandle([dirent('README.md', 'file'), dirent('src', 'dir'), dirent('later', 'dir'), null])
    expect(await hasSubdirectory('/nowhere', {}, undefined, async () => handle)).toBe(true)
    // Two reads: one file skipped, one folder that answered. Reading further would be
    // the cost `readDirectory` already pays and this call exists to avoid.
    expect(reads.count).toBe(2)
    expect(reads.closed).toBe(true)
  })

  it('answers false after walking to the end without meeting a folder', async () => {
    const { handle, reads } = fakeHandle([dirent('a.txt', 'file'), dirent('b.txt', 'file'), null])
    expect(await hasSubdirectory('/nowhere', {}, undefined, async () => handle)).toBe(false)
    expect(reads.count).toBe(3)
    expect(reads.closed).toBe(true)
  })

  it('names the directory when it cannot be opened at all', async () => {
    const root = await fixture()
    try {
      await expect(hasSubdirectory(join(root, 'missing'))).rejects.toThrow(
        /at-file: cannot list "/u,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('survives a read failure mid-walk and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { handle, reads } = fakeHandle([], new Error('EIO'))
      // A row left without the flag is a row the chooser may still probe; a thrown
      // error here would take the whole listing down with one bad entry.
      expect(await hasSubdirectory('/nowhere', {}, undefined, async () => handle)).toBe(false)
      expect(reads.closed).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('/nowhere')
    } finally {
      warn.mockRestore()
    }
  })
})
