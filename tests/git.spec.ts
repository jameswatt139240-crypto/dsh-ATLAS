/**
 * The built-in `@git` provider's Host half, against a real repository. These
 * calls shell out to git, so the interesting cases are the ones where git
 * answers something unexpected (a rename, a binary, no repository at all).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GIT_RESOLVE_PROVIDER, parseGitNumstat, parseGitStatus, readGitChanges, readGitDiff } from '../src/git.ts'

const signal = (): AbortSignal => new AbortController().signal
const roots: string[] = []

/** One scratch directory, removed after the test. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-atlas-git-'))
  roots.push(root)
  return root
}

/** A scratch repository with one untracked file. */
function repository(): string {
  const root = scratch()
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, 'fresh.txt'), 'hello\n')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('parseGitStatus', () => {
  it('reads the status, the path, and the new name of a rename', () => {
    expect(parseGitStatus(' M src/a.ts\n?? b.txt\nR  old.txt -> new.txt\n')).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'b.txt', status: '??' },
      { path: 'new.txt', status: 'R' },
    ])
  })

  it('drops what the workspace index already ignores', () => {
    expect(parseGitStatus('?? node_modules/x/y.js\n M src/a.ts\n')).toEqual([
      { path: 'src/a.ts', status: 'M' },
    ])
  })

  it('ignores blank and truncated lines', () => {
    expect(parseGitStatus('\n\n M\n')).toEqual([])
  })
})

describe('parseGitNumstat', () => {
  it('reads additions, deletions, and the new side of a rename', () => {
    const counts = parseGitNumstat('12\t3\tsrc/a.ts\n1\t0\told.txt -> new.txt\n')
    expect(counts.get('src/a.ts')).toEqual({ added: 12, removed: 3 })
    expect(counts.get('new.txt')).toEqual({ added: 1, removed: 0 })
  })

  it('leaves binary files uncounted rather than guessing zero', () => {
    expect(parseGitNumstat('-\t-\tlogo.png\n').size).toBe(0)
  })
})

describe('readGitChanges', () => {
  it('reports an untracked file as a change', async () => {
    const changes = await readGitChanges(repository(), signal())
    expect(changes).toEqual([{ path: 'fresh.txt', status: '??' }])
  })

  it('answers nothing outside a repository instead of raising', async () => {
    expect(await readGitChanges(scratch(), signal())).toEqual([])
  })

  it('answers nothing for a directory that does not exist', async () => {
    expect(await readGitChanges(join(tmpdir(), 'dsh-atlas-absent-repo'), signal())).toEqual([])
  })

  it('stops immediately when the caller has already given up', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await readGitChanges(repository(), controller.signal)).toEqual([])
  })
})

describe('readGitDiff', () => {
  it('diffs an untracked file as a new file, not as a file read', async () => {
    const root = repository()
    const diff = await readGitDiff(root, 'fresh.txt', signal())
    expect(diff).toContain('new file mode')
    expect(diff).toContain('+hello')
  })

  it('answers nothing for a path that git has never heard of', async () => {
    expect(await readGitDiff(repository(), 'absent.txt', signal())).toBeUndefined()
  })
})

describe('GIT_RESOLVE_PROVIDER', () => {
  it('declares the governance facts the registry demands', () => {
    expect(GIT_RESOLVE_PROVIDER).toMatchObject({
      id: 'git',
      display: 'Git',
      scopes: ['process:git'],
      testedOn: ['0.1.5-rc.1'],
    })
  })

  it('resolves a committed path into its diff', async () => {
    const root = repository()
    const body = await GIT_RESOLVE_PROVIDER.resolve!(
      { id: 'fresh.txt', title: 'fresh.txt' },
      { sessionId: 's1' as never, cwd: root, signal: signal() },
    )
    expect(body).toContain('+hello')
  })

  it('contributes nothing when the Host does not know the workspace', async () => {
    const body = await GIT_RESOLVE_PROVIDER.resolve!(
      { id: 'fresh.txt', title: 'fresh.txt' },
      { sessionId: 's1' as never, signal: signal() },
    )
    expect(body).toBe('')
  })
})
