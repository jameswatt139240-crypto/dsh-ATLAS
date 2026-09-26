/** Built-in file icon classification and SVG rendering. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fileIcon, fileIconKind, menuGlyphColor, type FileIconKind } from '../src/client/icons.tsx'
import type { FileEntry } from '../src/client/remote.ts'

function entry(relative: string, kind: 'file' | 'dir' = 'file'): FileEntry {
  return { path: `/ws/${relative}`, relative, kind }
}

describe('file icons', () => {
  it('classifies common workspace path types without reading them', () => {
    const cases: readonly [FileEntry, FileIconKind][] = [
      [entry('src', 'dir'), 'folder'],
      [entry('src/index.ts'), 'code'],
      [entry('Makefile'), 'code'],
      [entry('README.md'), 'text'],
      [entry('LICENSE'), 'text'],
      [entry('docs/spec.pdf'), 'pdf'],
      [entry('assets/logo.png'), 'image'],
      [entry('data/config.json'), 'data'],
      [entry('.env'), 'data'],
      [entry('.env.local'), 'data'],
      [entry('release.tar.gz'), 'archive'],
      [entry('payload.bin'), 'file'],
    ]
    expect(cases.map(([file]) => fileIconKind(file))).toEqual(cases.map(([, kind]) => kind))
  })

  it('renders recognizable language icons for common extensions', () => {
    const cases: readonly [FileEntry, string][] = [
      [entry('src/index.ts'), 'tabler-icon-brand-typescript'],
      [entry('main.go'), 'tabler-icon-brand-golang'],
      [entry('lib.rs'), 'tabler-icon-brand-rust'],
      [entry('script.py'), 'tabler-icon-brand-python'],
      [entry('Dockerfile'), 'tabler-icon-brand-docker'],
      [entry('README.md'), 'tabler-icon-markdown'],
    ]
    for (const [file, className] of cases) {
      const markup = renderToStaticMarkup(fileIcon(file))
      expect(markup).toContain(className)
    }
  })

  it('renders every built-in icon as a fixed-size inline SVG', () => {
    const cases: readonly [FileEntry, FileIconKind][] = [
      [entry('src', 'dir'), 'folder'],
      [entry('index.ts'), 'code'],
      [entry('notes.txt'), 'text'],
      [entry('spec.pdf'), 'pdf'],
      [entry('logo.svg'), 'image'],
      [entry('data.yaml'), 'data'],
      [entry('release.zip'), 'archive'],
      [entry('payload.bin'), 'file'],
    ]
    for (const [file, kind] of cases) {
      const markup = renderToStaticMarkup(fileIcon(file))
      expect(markup).toContain('<svg')
      expect(markup).toContain('width="28"')
      expect(markup).toContain(`data-file-icon="${kind}"`)
    }
  })
})

describe('menu glyph accents', () => {
  const category = (value: string, providerId?: string) => ({ mentionKind: 'category', value, providerId })

  it('gives the three most-used categories the three primaries', () => {
    // Blue for files (the product's own reference colour), green for folders,
    // red for skills — the three hues that read fastest, on the three intents
    // this plugin is used for most.
    expect(menuGlyphColor(category('file:'))).toContain('--dsw-alias-state-business-primary')
    expect(menuGlyphColor(category('folder:'))).toContain('--dsw-alias-state-success-primary')
    expect(menuGlyphColor(category('skill:'))).toContain('--dsw-alias-state-error-primary')
    // Each is theme-aware: a token first, a fixed mid-tone as the fallback.
    for (const value of ['file:', 'folder:', 'skill:', 'plugin:']) {
      expect(menuGlyphColor(category(value))).toMatch(/^var\(--dsw-alias-state-[a-z]+-primary, #[0-9a-f]{6}\)$/u)
    }
    // The two without a theme hue carry a fixed one, and all five differ.
    expect(menuGlyphColor(category('chat:'))).toBe('#a78bfa')
    expect(menuGlyphColor(category('plugin:'))).toContain('--dsw-alias-state-warn-primary')
    const hues = ['file:', 'folder:', 'skill:', 'chat:', 'plugin:'].map(value => menuGlyphColor(category(value)))
    expect(new Set(hues).size).toBe(5)
  })

  it('accents a provider category with the tool it stands for', () => {
    expect(menuGlyphColor(category('git:'))).toBe('#f05032')
    // Registered with the provider id instead of the prefix: same accent.
    expect(menuGlyphColor(category('', 'git'))).toBe('#f05032')
    // An unknown provider has no colour of its own to claim.
    expect(menuGlyphColor(category('', 'acme'))).toBeUndefined()
    expect(menuGlyphColor(category('mystery:'))).toBeUndefined()
    // The Tab hint row is a category row too, so it wears the target's accent.
    expect(menuGlyphColor({ mentionKind: 'category', value: 'git:', completionHint: true })).toBe('#f05032')
  })

  it('keeps every row that carries data neutral', () => {
    // A menu of twenty file names in twenty hues is decoration, not information.
    const data: readonly Record<string, unknown>[] = [
      { mentionKind: 'file', value: 'src/index.ts' },
      { mentionKind: 'dir', value: 'src' },
      { mentionKind: 'chat', value: 'sess-a' },
      { mentionKind: 'skill', value: 'evidence-based-verification' },
      { mentionKind: 'plugin', value: 'dsh-atlas' },
      { mentionKind: 'provider', providerId: 'git', value: 'src/index.ts' },
      { mentionKind: 'back', value: 'back' },
      { mentionKind: 'section-header', value: '' },
      { mentionKind: 'category' },
    ]
    for (const row of data) expect(menuGlyphColor(row)).toBeUndefined()
  })
})