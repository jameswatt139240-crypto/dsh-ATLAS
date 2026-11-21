/**
 * The durable document behind the `at-file` section: the store a profile uses
 * when its settings service has no plugin namespace, so switches, filters,
 * history knobs and the out-of-workspace ledger survive a restart.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  createDurableSettings,
  harnessHome,
  readDurableSettings,
  settingsFile,
} from '../src/store.ts'
import { AT_FILE_NAMESPACE, AtFileSettingsSchema, registerAtFileSettings } from '../src/settings.ts'
import type { AtFileSettings } from '../src/contract.ts'

/** A context whose profile home is the directory a test owns. */
function contextAt(home: string): Context {
  return { profileContext: { home } } as unknown as Context
}

/** Defaults, as the schema resolves an empty section. */
function defaults(): AtFileSettings {
  return AtFileSettingsSchema({} as AtFileSettings)
}

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-store-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  delete process.env.DSH_HOME
})

describe('harnessHome', () => {
  it('prefers the profile context over the environment', () => {
    process.env.DSH_HOME = join(root, 'from-env')
    expect(harnessHome(contextAt(join(root, 'from-profile')))).toBe(join(root, 'from-profile'))
  })

  it('falls back to DSH_HOME when the profile context carries no home', () => {
    process.env.DSH_HOME = join(root, 'from-env')
    expect(harnessHome({} as unknown as Context)).toBe(join(root, 'from-env'))
  })

  it('falls back to ~/.dsh when neither answers', () => {
    expect(harnessHome({ profileContext: { home: '' } } as unknown as Context)).toMatch(/[/\\]\.dsh$/u)
  })
})

describe('settingsFile', () => {
  it('keeps the document inside an atlas directory', () => {
    expect(settingsFile('/home/u/.dsh')).toBe('/home/u/.dsh/atlas/at-file.json')
  })
})

describe('readDurableSettings', () => {
  it('answers the schema defaults before anything was ever written', () => {
    expect(readDurableSettings(settingsFile(root))).toEqual(defaults())
  })

  it('reads the wrapped document this store writes', () => {
    const file = settingsFile(root)
    mkdirSync(join(root, 'atlas'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, settings: { candidateLimit: 12 } }))

    const settings = readDurableSettings(file)
    expect(settings.candidateLimit).toBe(12)
    // Absent fields still resolve to their declared defaults.
    expect(settings.historyJumpFrames).toBe('turn')
  })

  it('reads a bare section copied out of a hand-edited file', () => {
    const file = settingsFile(root)
    mkdirSync(join(root, 'atlas'), { recursive: true })
    writeFileSync(file, JSON.stringify({ enabled: false, externalRefs: [] }))

    expect(readDurableSettings(file).enabled).toBe(false)
  })

  it('ignores a document whose version this build does not know', () => {
    const file = settingsFile(root)
    mkdirSync(join(root, 'atlas'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 2, settings: { enabled: false } }))

    expect(readDurableSettings(file).enabled).toBe(true)
  })

  it('ignores a document that is not an object at all', () => {
    const file = settingsFile(root)
    mkdirSync(join(root, 'atlas'), { recursive: true })
    writeFileSync(file, 'null')

    expect(readDurableSettings(file).enabled).toBe(true)
  })

  it('reports a corrupt document and starts from defaults instead of taking the plugin down', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = settingsFile(root)
    mkdirSync(join(root, 'atlas'), { recursive: true })
    writeFileSync(file, '{ not json')

    expect(readDurableSettings(file)).toEqual(defaults())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring unreadable settings'))
  })

  it('drops a field the schema would reject rather than answering it', () => {
    const file = settingsFile(root)
    mkdirSync(join(root, 'atlas'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, settings: { candidateLimit: 'many' } }))

    expect(readDurableSettings(file).candidateLimit).toBe(50)
  })
})

describe('createDurableSettings', () => {
  it('creates the directory and writes the wrapped document on save', async () => {
    const store = createDurableSettings(contextAt(root))
    await store.save({ ...defaults(), candidateLimit: 7 })

    expect(store.file).toBe(settingsFile(root))
    const written = JSON.parse(readFileSync(store.file, 'utf8')) as {
      version: number
      settings: { candidateLimit: number }
    }
    expect(written.version).toBe(1)
    expect(written.settings.candidateLimit).toBe(7)
    // No temporary file survives the rename.
    expect(readDurableSettings(store.file).candidateLimit).toBe(7)
  })

  it('serializes two saves so the later one wins', async () => {
    const store = createDurableSettings(contextAt(root))
    const first = store.save({ ...defaults(), candidateLimit: 3 })
    const second = store.save({ ...defaults(), candidateLimit: 9 })
    await Promise.all([first, second])

    expect(readDurableSettings(store.file).candidateLimit).toBe(9)
  })

  it('reports an unwritable home and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A file where the directory should be makes mkdir fail with ENOTDIR.
    const blocked = join(root, 'atlas')
    writeFileSync(blocked, 'not a directory')
    const store = createDurableSettings(contextAt(root))

    await expect(store.save(defaults())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not save settings'))
  })
})

describe('the scope a profile without a namespace API gets', () => {
  it('reads its document and persists each update', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scope = registerAtFileSettings({ profileContext: { home: root }, settings: {} } as unknown as Context)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(AT_FILE_NAMESPACE))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(settingsFile(root)))
    expect(scope.get().enabled).toBe(true)

    await scope.update({ enabled: false, candidateLimit: 25 })

    const file = settingsFile(root)
    expect(readDurableSettings(file).enabled).toBe(false)
    expect(readDurableSettings(file).candidateLimit).toBe(25)
    // The live value follows the write without a reload.
    expect(scope.get().enabled).toBe(false)
  })

  it('refuses, rather than stores, a patch the schema would reject', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scope = registerAtFileSettings({ profileContext: { home: root }, settings: {} } as unknown as Context)

    await expect(scope.update({ candidateLimit: 5000 } as AtFileSettings)).rejects.toThrow(/candidateLimit/u)

    // The rejected write left both the live value and the document untouched.
    expect(scope.get().candidateLimit).toBe(50)
    expect(readDurableSettings(settingsFile(root)).candidateLimit).toBe(50)
  })

  it('re-reads the document on first use, so a previous run is not forgotten', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = settingsFile(root)
    mkdirSync(join(root, 'atlas'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, settings: { enabled: false } }))

    const scope = registerAtFileSettings({ profileContext: { home: root }, settings: {} } as unknown as Context)

    expect(scope.get().enabled).toBe(false)
  })
})
