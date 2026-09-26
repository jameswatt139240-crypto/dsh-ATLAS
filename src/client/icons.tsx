/** Tabler-based vector icons (single icon library) with per-kind semantic colors. */
import type { ComponentType, ReactElement } from 'react'
import type { IconProps } from '@tabler/icons-react'
import {
  IconArchive,
  IconArrowLeft,
  IconBlocks,
  IconBolt,
  IconBraces,
  IconBrandCpp,
  IconBrandCss3,
  IconBrandDocker,
  IconBrandFlutter,
  IconBrandGit,
  IconBrandGolang,
  IconBrandGraphql,
  IconBrandHtml5,
  IconBrandJavascript,
  IconBrandKotlin,
  IconBrandPhp,
  IconBrandPowershell,
  IconBrandPrisma,
  IconBrandPython,
  IconBrandRust,
  IconBrandSvelte,
  IconBrandSwift,
  IconBrandTerraform,
  IconBrandTypescript,
  IconBrandVue,
  IconCoffee,
  IconDatabase,
  IconDiamond,
  IconFile,
  IconFileCode,
  IconFileMusic,
  IconFileText,
  IconFileTypeDoc,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeSql,
  IconFileTypeTxt,
  IconFileTypeXls,
  IconFileTypeXml,
  IconFolder,
  IconMarkdown,
  IconMessageCircle,
  IconPhoto,
  IconTerminal2,
} from '@tabler/icons-react'
import type { FileEntry } from './remote.ts'

export type FileIconKind = 'folder' | 'code' | 'text' | 'pdf' | 'image' | 'data' | 'archive' | 'file'

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'dart', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx', 'kt', 'kts',
  'lua', 'mjs', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'swift', 'ts', 'tsx', 'vue',
])
const TEXT_EXTENSIONS = new Set(['adoc', 'log', 'md', 'mdx', 'rst', 'text', 'txt'])
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const DATA_EXTENSIONS = new Set(['conf', 'config', 'csv', 'ini', 'json', 'jsonl', 'toml', 'tsv', 'xml', 'yaml', 'yml'])
const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'jar', 'rar', 'tar', 'tgz', 'war', 'xz', 'zip'])
const TEXT_NAMES = new Set(['authors', 'changelog', 'copying', 'license', 'readme'])
const CODE_NAMES = new Set(['dockerfile', 'gemfile', 'makefile', 'rakefile'])

/** Classify one indexed path without reading it. */
export function fileIconKind(file: Pick<FileEntry, 'kind' | 'relative'>): FileIconKind {
  if (file.kind === 'dir') return 'folder'
  const basename = file.relative.slice(file.relative.lastIndexOf('/') + 1).toLowerCase()
  const dot = basename.lastIndexOf('.')
  const extension = dot > 0 ? basename.slice(dot + 1) : ''
  if (extension === 'pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
  if (CODE_EXTENSIONS.has(extension) || CODE_NAMES.has(basename)) return 'code'
  if (DATA_EXTENSIONS.has(extension) || basename === '.env' || basename.startsWith('.env.')) return 'data'
  if (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(basename)) return 'text'
  return 'file'
}

/** Semantic stroke colors per file kind. */
const KIND_COLORS: Record<FileIconKind, string> = {
  folder: '#e8a23a',
  code: '#4d9de0',
  text: '#8c98a5',
  pdf: '#e15b64',
  image: '#55a875',
  data: '#9a78d1',
  archive: '#c18752',
  file: '#8c98a5',
}

/**
 * Extension → language/brand icon map, so programmers recognize a file's
 * language at a glance. Unknown extensions fall back to the generic kind icons.
 */
const LANGUAGE_ICONS: Record<string, { Icon: ComponentType<IconProps>; color: string }> = {
  ts: { Icon: IconBrandTypescript, color: '#3178c6' },
  tsx: { Icon: IconBrandTypescript, color: '#3178c6' },
  js: { Icon: IconBrandJavascript, color: '#f7df1e' },
  jsx: { Icon: IconBrandJavascript, color: '#f7df1e' },
  mjs: { Icon: IconBrandJavascript, color: '#f7df1e' },
  cjs: { Icon: IconBrandJavascript, color: '#f7df1e' },
  py: { Icon: IconBrandPython, color: '#3776ab' },
  rs: { Icon: IconBrandRust, color: '#dea584' },
  go: { Icon: IconBrandGolang, color: '#00add8' },
  java: { Icon: IconCoffee, color: '#e76f00' },
  c: { Icon: IconBrandCpp, color: '#659ad2' },
  cc: { Icon: IconBrandCpp, color: '#659ad2' },
  cpp: { Icon: IconBrandCpp, color: '#659ad2' },
  h: { Icon: IconBrandCpp, color: '#659ad2' },
  hpp: { Icon: IconBrandCpp, color: '#659ad2' },
  rb: { Icon: IconDiamond, color: '#cc342d' },
  php: { Icon: IconBrandPhp, color: '#777bb4' },
  html: { Icon: IconBrandHtml5, color: '#e34f26' },
  css: { Icon: IconBrandCss3, color: '#1572b6' },
  scss: { Icon: IconBrandCss3, color: '#cd6799' },
  sh: { Icon: IconTerminal2, color: '#4eaa25' },
  bash: { Icon: IconTerminal2, color: '#4eaa25' },
  zsh: { Icon: IconTerminal2, color: '#4eaa25' },
  md: { Icon: IconMarkdown, color: '#8c98a5' },
  mdx: { Icon: IconMarkdown, color: '#8c98a5' },
  json: { Icon: IconBraces, color: '#c9b23c' },
  jsonl: { Icon: IconBraces, color: '#c9b23c' },
  yaml: { Icon: IconBraces, color: '#8c98a5' },
  yml: { Icon: IconBraces, color: '#8c98a5' },
  toml: { Icon: IconBraces, color: '#8c98a5' },
  vue: { Icon: IconBrandVue, color: '#42b883' },
  svelte: { Icon: IconBrandSvelte, color: '#ff3e00' },
  swift: { Icon: IconBrandSwift, color: '#f05138' },
  kt: { Icon: IconBrandKotlin, color: '#7f52ff' },
  kts: { Icon: IconBrandKotlin, color: '#7f52ff' },
  dart: { Icon: IconBrandFlutter, color: '#0175c2' },
  sql: { Icon: IconFileTypeSql, color: '#e38c00' },
  ps1: { Icon: IconBrandPowershell, color: '#5391fe' },
  tf: { Icon: IconBrandTerraform, color: '#7b42bc' },
  graphql: { Icon: IconBrandGraphql, color: '#e10098' },
  gql: { Icon: IconBrandGraphql, color: '#e10098' },
  prisma: { Icon: IconBrandPrisma, color: '#5a67d8' },
  xml: { Icon: IconFileTypeXml, color: '#e37933' },
  doc: { Icon: IconFileTypeDoc, color: '#2b579a' },
  docx: { Icon: IconFileTypeDoc, color: '#2b579a' },
  ppt: { Icon: IconFileTypePpt, color: '#d24726' },
  pptx: { Icon: IconFileTypePpt, color: '#d24726' },
  xls: { Icon: IconFileTypeXls, color: '#217346' },
  xlsx: { Icon: IconFileTypeXls, color: '#217346' },
  txt: { Icon: IconFileTypeTxt, color: '#8c98a5' },
  mp3: { Icon: IconFileMusic, color: '#7c3aed' },
  wav: { Icon: IconFileMusic, color: '#7c3aed' },
  ogg: { Icon: IconFileMusic, color: '#7c3aed' },
  flac: { Icon: IconFileMusic, color: '#7c3aed' },
  aac: { Icon: IconFileMusic, color: '#7c3aed' },
}

/** Special basenames that carry a language icon without an extension. */
const LANGUAGE_NAMES: Record<string, { Icon: ComponentType<IconProps>; color: string }> = {
  dockerfile: { Icon: IconBrandDocker, color: '#2496ed' },
  '.gitignore': { Icon: IconBrandGit, color: '#f05033' },
  gitconfig: { Icon: IconBrandGit, color: '#f05033' },
  makefile: { Icon: IconBrandCpp, color: '#659ad2' },
  gemfile: { Icon: IconDiamond, color: '#cc342d' },
}

/** The language icon for one indexed path, or undefined. */
function languageIconFor(file: Pick<FileEntry, 'kind' | 'relative'>): { Icon: ComponentType<IconProps>; color: string } | undefined {
  if (file.kind !== 'file') return undefined
  const basename = file.relative.slice(file.relative.lastIndexOf('/') + 1).toLowerCase()
  const byName = LANGUAGE_NAMES[basename]
  if (byName !== undefined) return byName
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return undefined
  return LANGUAGE_ICONS[basename.slice(dot + 1)]
}

/** Tabler icon component per file kind. */
const KIND_ICONS: Record<FileIconKind, ComponentType<IconProps>> = {
  folder: IconFolder,
  code: IconFileCode,
  text: IconFileText,
  pdf: IconFileTypePdf,
  image: IconPhoto,
  data: IconDatabase,
  archive: IconArchive,
  file: IconFile,
}

/**
 * One file-kind icon rendered at menu size. The wrapper span keeps the stable
 * `data-file-icon` marker for classification consumers and tests.
 */
export function fileIcon(file: Pick<FileEntry, 'kind' | 'relative'>): ReactElement {
  const kind = fileIconKind(file)
  const language = languageIconFor(file)
  const Icon = language === undefined ? KIND_ICONS[kind] : language.Icon
  return (
    <span data-file-icon={kind} style={{ display: 'inline-flex' }} aria-hidden>
      <Icon size={28} stroke={1.8} color={language === undefined ? KIND_COLORS[kind] : language.color} />
    </span>
  )
}

/** Mention kinds that carry their own accent icon. */
export type MentionIconKind = 'file' | 'folder' | 'skill' | 'chat' | 'plugin' | 'back'

/** Semantic accent colors for the category/dock mention icons. */
const MENTION_COLORS: Record<MentionIconKind, string> = {
  file: '#3b82f6',
  folder: '#f59e0b',
  skill: '#8b5cf6',
  chat: '#10b981',
  plugin: '#06b6d4',
  back: '#8c98a5',
}

/** Tabler icon component per mention kind (plugin uses the denser puzzle glyph). */
/** Intuitive glyphs: bolt = skill/ability, blocks = modular plugin. */
const MENTION_ICONS: Record<MentionIconKind, ComponentType<IconProps>> = {
  file: IconFile,
  folder: IconFolder,
  skill: IconBolt,
  chat: IconMessageCircle,
  plugin: IconBlocks,
  back: IconArrowLeft,
}

/**
 * Per-kind render size: sparse glyphs (bulb, puzzle) occupy less of the
 * 24×24 Tabler canvas, so they render slightly larger to match the visual
 * weight of dense glyphs (file, folder).
 */
const MENTION_SIZES: Record<MentionIconKind, number> = {
  file: 28,
  folder: 28,
  skill: 36,
  chat: 28,
  plugin: 28,
  back: 28,
}

/** One category/dock icon with its semantic accent color (sparse glyphs compensated). */
export function mentionIcon(kind: MentionIconKind): ReactElement {
  const Icon = MENTION_ICONS[kind]
  return <Icon size={MENTION_SIZES[kind]} stroke={1.8} color={MENTION_COLORS[kind]} aria-hidden />
}

/**
 * A leaf-row icon for result rows (skills/chats/plugins), replacing the empty
 * indentation slot. Sizes match the category menu icons (skill 36px, others 28px)
 * so the same kind reads identically everywhere.
 */
export function leafIcon(kind: 'skill' | 'chat' | 'plugin'): ReactElement {
  const Icon = MENTION_ICONS[kind]
  return <Icon size={MENTION_SIZES[kind]} stroke={1.8} color={MENTION_COLORS[kind]} aria-hidden />
}

/**
 * The framework kind that RESERVES an icon box on one of our menu rows.
 *
 * The framework's row renders an icon only when the candidate carries one, and
 * it can only draw `session`, `file` and `folder`. So a row of ours always
 * carries one of those three: not for the glyph (which `MenuIcons` draws itself
 * over it), but for the BOX — a fixed 16 px slot that indents every name by the
 * same amount, which is what makes the column line up.
 * @param kind - the row's kind in this plugin's vocabulary.
 * @returns the framework kind to declare.
 */
export function menuIconKind(kind: MentionIconKind): 'file' | 'folder' | 'session' {
  if (kind === 'folder') return 'folder'
  // A past chat IS a session.
  if (kind === 'chat') return 'session'
  // `file` is the least-wrong stand-in for skill/plugin/back: it only has to hold
  // the slot open, and our own glyph covers it.
  return 'file'
}

/** Provider ids with a glyph of their own; anything else borrows the plugin one. */
const PROVIDER_ICONS: Record<string, ComponentType<IconProps>> = {
  git: IconBrandGit,
}

/** The row facts one menu glyph is chosen from. */
export interface MenuGlyphRow {
  readonly mentionKind: string
  readonly value?: string
  readonly atFileKind?: 'file' | 'dir'
  readonly providerId?: string
}

/**
 * The accent a CATEGORY row draws in.
 *
 * The categories are the menu's intentions rather than its data: five rows in
 * the bottom band, each standing for a way of referencing, and colour is what
 * separates them at a glance. Each takes the hue its meaning already carries
 * elsewhere, and the three this plugin is used for most are the three that read
 * fastest — blue, green, red:
 *
 * - `file` — blue: the product's own reference/link colour.
 * - `folder` — green: a container you go INTO (the hue file managers pair with a
 *   document so the two never read as the same thing).
 * - `skill` — red: the bolt on it means capability.
 * - `chat` — violet: the theme has no hue for it, so a fixed one that reads on
 *   both the light and the dark menu.
 * - `plugin` — amber: extensions are amber in every editor this UI borrows from.
 *
 * Rows that carry DATA (a file, a directory, a chat, a plugin entry) stay
 * neutral: twenty file names in twenty hues is decoration, not information, and
 * each row's type glyph already says what it is.
 *
 * Values are `var(token, fallback)` pairs — the theme's own alias colour where
 * one exists (those adapt to light and dark), a fixed mid-tone otherwise.
 */
const CATEGORY_ACCENTS: Record<string, string> = {
  file: 'var(--dsw-alias-state-business-primary, #5686fe)',
  folder: 'var(--dsw-alias-state-success-primary, #22c55e)',
  skill: 'var(--dsw-alias-state-error-primary, #f87171)',
  chat: '#a78bfa',
  plugin: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
}

/** Provider accents: the tool's own brand colour, where it has one. */
const PROVIDER_ACCENTS: Record<string, string> = {
  git: '#f05032',
}

/**
 * The colour one menu row's glyph is drawn in.
 * @param row - the candidate row.
 * @returns the accent for a category row (its prefix, else its provider id), or
 *   undefined for a row that carries data, which keeps the neutral glyph colour.
 */
export function menuGlyphColor(row: MenuGlyphRow): string | undefined {
  if (row.mentionKind !== 'category') return undefined
  const key = (row.value ?? '').replace(/:$/u, '')
  if (CATEGORY_ACCENTS[key] !== undefined) return CATEGORY_ACCENTS[key]
  if (PROVIDER_ACCENTS[key] !== undefined) return PROVIDER_ACCENTS[key]
  return row.providerId === undefined ? undefined : PROVIDER_ACCENTS[row.providerId]
}

/**
 * The glyph one menu row draws, at menu size.
 *
 * Same icon family as the reference dock (and the same per-file-type and
 * per-language selection). A row that carries data stays monochrome so it reads
 * as part of its row; a category row is drawn in its accent
 * (`menuGlyphColor`), which is the one place the menu spends colour on meaning.
 * @param row - the candidate row.
 * @param size - glyph size in px (the framework's slot is 16).
 * @returns the glyph element.
 */
/** The five built-in category keys, as the menu's category rows spell them. */
const CATEGORY_KEYS: Record<string, MentionIconKind> = {
  file: 'file',
  folder: 'folder',
  skill: 'skill',
  chat: 'chat',
  plugin: 'plugin',
}

export function menuGlyph(row: MenuGlyphRow, size = 16): ReactElement {
  if (row.mentionKind === 'file' || row.mentionKind === 'dir') {
    // The same selection the dock makes: a language brand glyph when the file
    // type has one (TypeScript, Rust, Go, …), the kind glyph otherwise.
    const file = { kind: row.atFileKind ?? 'file' as const, relative: row.value ?? '' }
    const language = languageIconFor(file)
    const Icon = language === undefined ? KIND_ICONS[fileIconKind(file)] : language.Icon
    return <Icon size={size} stroke={1.8} color="currentColor" aria-hidden />
  }
  if (row.mentionKind === 'category') {
    // A category row names itself by its prefix (`file:`, `git:`, …): the five
    // built-ins have their own glyph, a provider category gets the glyph its id
    // declares (a branch for `git`) and anything else the plugin glyph.
    const key = (row.value ?? '').replace(/:$/u, '')
    const kind = CATEGORY_KEYS[key]
    const Icon = kind !== undefined
      ? MENTION_ICONS[kind]
      : (PROVIDER_ICONS[key] ?? (row.providerId === undefined ? undefined : PROVIDER_ICONS[row.providerId]) ?? MENTION_ICONS.plugin)
    return <Icon size={size} stroke={1.8} color="currentColor" aria-hidden />
  }
  if (row.mentionKind === 'provider' && row.providerId !== undefined) {
    const Icon = PROVIDER_ICONS[row.providerId] ?? MENTION_ICONS.plugin
    return <Icon size={size} stroke={1.8} color="currentColor" aria-hidden />
  }
  const kind = row.mentionKind === 'back' || row.mentionKind === 'skill' || row.mentionKind === 'plugin'
    ? row.mentionKind as MentionIconKind
    : 'plugin'
  const Icon = MENTION_ICONS[kind]
  return <Icon size={size} stroke={1.8} color="currentColor" aria-hidden />
}