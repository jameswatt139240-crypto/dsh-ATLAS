// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { draftScopeOf } from '../src/client/draft-scope.ts'

const probe = (dirs: readonly string[] = []) => ({
  isFolder: vi.fn(async (path: string) => dirs.includes(path)),
})

describe('draft scope', () => {
  it('takes the nearest earlier folder, and keeps the nearest one when several appear', async () => {
    const host = probe()
    await expect(draftScopeOf(['@e:/outsidedir/', '@file:'], host)).resolves.toBe('e:/outsidedir')
    await expect(draftScopeOf(['@src/', '@e:/outsidedir/', '@file:'], host)).resolves.toBe('e:/outsidedir')
    await expect(draftScopeOf(['@file:'], host)).resolves.toBeUndefined()
    expect(host.isFolder).not.toHaveBeenCalled()
  })

  it('asks the Host about a plain path token, because only the Host knows it is a folder', async () => {
    const host = probe(['e:/outsidedir'])
    await expect(draftScopeOf(['@e:/outsidedir', '@file:'], host)).resolves.toBe('e:/outsidedir')
    expect(host.isFolder).toHaveBeenCalledWith('e:/outsidedir')
    // A file the Host calls a file never becomes a scope, and neither does a
    // handle that names no resource at all.
    await expect(draftScopeOf(['@src/view.ts', '@file:'], probe())).resolves.toBeUndefined()
    await expect(draftScopeOf(['@skill:blender', '@plugin:x', '@file:'], probe())).resolves.toBeUndefined()
  })

  it('never scopes a token by itself, so a typed category is not its own folder', async () => {
    const host = probe(['file:Ea', 'folder:Ea'])
    // `file:Ea` carries a colon in its first segment and names no resource, so the
    // Host is never even asked about it.
    await expect(draftScopeOf(['@file:Ea'], host)).resolves.toBeUndefined()
    await expect(draftScopeOf(['@folder:Ea'], host)).resolves.toBeUndefined()
    expect(host.isFolder).not.toHaveBeenCalled()
  })
})
