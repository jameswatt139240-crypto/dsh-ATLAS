/**
 * Referenced-item dock: one row per mention token currently in the draft,
 * rendered above the composer (the 'conversation.input.dock' strip). Path
 * rows open the file on the host; every row's × removes the token from the
 * draft. The draft holds plain-text tokens (the plain-text-reference
 * decision), so the dock parses them directly; the plugin settings source's
 * live enable value gates the strip.
 */
import { useEffect, useMemo } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { AtFileSettings, ReferenceInfo } from '../contract.ts'
import { isProtectedMentionToken } from '../paste.ts'
import { lineRangeLabel, splitLineRange } from '../tokens.ts'
import type { ReferenceLink } from './reference-links.ts'
import type { MentionKind } from './source.ts'
import { referenceKey } from './model.ts'
import { mentionIcon } from './icons.tsx'
import { IconX } from '@tabler/icons-react'

export interface AtFileSettingsSnapshot { readonly value: AtFileSettings }
export type AtFileSettingsSource = ObservableSnapshot<AtFileSettingsSnapshot>

/** Snapshot of the host-inspected reference facts (existence, kind, size). */
export interface ReferenceInfoSnapshot { readonly value: readonly ReferenceInfo[] }
export type ReferenceInfoSource = ObservableSnapshot<ReferenceInfoSnapshot>

/** Injected business face: open one mention, inspect the draft's references, and the live sources. */
export interface AtFileDockInjected {
  /**
   * Open one mention of the draft (the same action a click on the sent-message
   * chip performs, so both surfaces behave alike).
   */
  onOpen: (link: ReferenceLink) => void
  /** Ask the Host for existence, kind, and size of the draft's path references. */
  requestInspect: (targets: readonly string[]) => void
  hooks: { scope: AtFileSettingsSource; referenceInfo: ReferenceInfoSource }
}

/** Approximate bytes per token for text files (the dock's cost hint). */
export const BYTES_PER_TOKEN = 4

/** References heavier than this many tokens are flagged in the dock. */
export const COST_WARN_TOKENS = 8_000

/**
 * Approximate context cost of one reference, or undefined when there is nothing
 * to price (missing path, directory, or a file whose size is unknown).
 * @param info - the host-inspected facts for this reference, when available.
 * @returns the token estimate and whether it exceeds the warning threshold.
 */
export function referenceCost(info: ReferenceInfo | undefined): { readonly tokens: number; readonly warn: boolean } | undefined {
  if (info === undefined || !info.exists || info.kind !== 'file' || info.size === undefined) return undefined
  const tokens = Math.ceil(info.size / BYTES_PER_TOKEN)
  return { tokens, warn: tokens > COST_WARN_TOKENS }
}

/**
 * Compact token count for the dock badge (`820`, `1.2k`).
 * @param tokens - the estimated token count.
 * @returns the badge text.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = tokens / 1000
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`
}

/** Full dock entry props: InputZone owner share + session standard kit + injected face + locale seat. */
export type AtFileDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<AtFileDockInjected> & PropsLocale<'atlas'>

/** One parsed mention token in the draft, with its span for precise removal. */
export interface DraftMention {
  readonly kind: Exclude<MentionKind, 'category' | 'back'>
  /** Stable removal key (the token start index). */
  readonly key: number
  /** Display label. */
  readonly label: string
  /** Workspace-relative path for file/dir rows (inspection and open action). */
  readonly relative?: string
  /** The click action's target, for rows this build can open. */
  readonly link?: ReferenceLink
  readonly start: number
  readonly end: number
}

/** The same path token grammar the Host's reference marker scans. */
const PATH_PATTERN = /@([^\s@]+)/g

/** @skill:name tokens. */
const SKILL_PATTERN = /@skill:([^\s@]+)/g

/** @plugin:name tokens. */
const PLUGIN_PATTERN = /@plugin:([^\s@]+)/g

/** @atlas:provider/item tokens (the seam's provider mentions). */
const PROVIDER_PATTERN = /@atlas:([a-z0-9-]+)\/([^\s@]+)/g

/** @[label](dsh-session:...) markdown mentions. */
const CHAT_PATTERN = /@\[([^\]]+)\]\((dsh-session:[^\s)]+)\)/g

/** Path tokens that are actually category prefixes, provider handles or chat URIs. */
function isForeignPathToken(raw: string): boolean {
  return raw.startsWith('skill:')
    || raw.startsWith('plugin:')
    || raw.startsWith('atlas:')
    || raw.startsWith('chat:')
    || raw.startsWith('file:')
    || raw.startsWith('folder:')
    || raw.startsWith('[')
    || raw.includes('(')
}

/** Parse the draft's mention tokens in order, deduplicating by kind + span. */
export function draftMentions(draft: string): readonly DraftMention[] {
  const out: DraftMention[] = []
  const push = (mention: DraftMention): void => {
    // Deduplicate by kind + label, keeping the first span.
    if (out.some(existing => existing.kind === mention.kind && existing.label === mention.label)) return
    out.push(mention)
  }
  for (const match of draft.matchAll(CHAT_PATTERN)) {
    const label = match[1] as string
    push({ kind: 'chat', key: match.index, label, start: match.index, end: match.index + match[0].length })
  }
  for (const match of draft.matchAll(SKILL_PATTERN)) {
    const name = match[1] as string
    if (isProtectedMentionToken(name)) continue
    push({ kind: 'skill', key: match.index, label: name, start: match.index, end: match.index + match[0].length })
  }
  for (const match of draft.matchAll(PLUGIN_PATTERN)) {
    const name = match[1] as string
    if (isProtectedMentionToken(name)) continue
    push({ kind: 'plugin', key: match.index, label: name, start: match.index, end: match.index + match[0].length })
  }
  for (const match of draft.matchAll(PROVIDER_PATTERN)) {
    const provider = match[1] as string
    const item = match[2] as string
    push({
      kind: 'provider',
      key: match.index,
      // The handle stays visible: a provider item is not a workspace path, and
      // only the provider's own `open` knows what it points at.
      label: `${provider}/${item}`,
      link: { kind: 'atlas', provider, item },
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  for (const match of draft.matchAll(PATH_PATTERN)) {
    const raw = match[1] as string
    if (isProtectedMentionToken(raw) || isForeignPathToken(raw)) continue
    const target = splitLineRange(raw)
    // The trailing-slash form is the directory chip: a line range on it is
    // meaningless, so it is dropped here exactly as the Host would refuse it.
    const directoryForm = target.path.endsWith('/')
    const relative = directoryForm ? target.path.slice(0, -1) : target.path
    if (relative === '') continue
    const lines = directoryForm ? undefined : target.lines
    const label = lines === undefined ? relative : `${relative}:${lineRangeLabel(lines)}`
    push({
      kind: directoryForm ? 'dir' : 'file',
      key: match.index,
      label,
      relative,
      link: directoryForm ? { kind: 'folder', path: relative } : { kind: 'file', path: relative },
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Draft text with one token span removed. */
export function withoutToken(draft: string, start: number, end: number): string {
  return draft.slice(0, start) + draft.slice(end)
}

/** One small inline icon per mention kind (Tabler, semantic accent color). */
function kindIcon(kind: 'file' | 'dir' | 'skill' | 'chat' | 'plugin'): React.ReactElement {
  const map = { file: 'file', dir: 'folder', skill: 'skill', chat: 'chat', plugin: 'plugin' } as const
  return mentionIcon(map[kind])
}

/**
 * The icon one dock row shows. A provider row reuses the plugin glyph, exactly
 * as the menu's provider category rows do: it is a plugin-supplied source.
 * @param kind - the parsed mention kind.
 * @returns the icon kind the built-in icon set understands.
 */
function dockIconKind(kind: DraftMention['kind']): 'file' | 'dir' | 'skill' | 'chat' | 'plugin' {
  return kind === 'provider' ? 'plugin' : kind as 'file' | 'dir' | 'skill' | 'chat' | 'plugin'
}

/**
 * Render the referenced-item rows; null while the draft has no mention tokens
 * or the settings switch is off.
 * @param props - runtime (input currency + actions), inject, and locale shares.
 * @returns the dock strip, or null.
 */
export function FilesDock({ input, inputActions, onOpen, requestInspect, useScope, useReferenceInfo, t }: AtFileDockProps) {
  const enabled = useScope(snapshot => snapshot.value?.enabled ?? true)
  const infos = useReferenceInfo(snapshot => snapshot.value)
  const mentions = draftMentions(input.draft)
  const targets = useMemo(
    () => [...new Set(mentions
      .filter(mention => mention.kind === 'file' || mention.kind === 'dir')
      .map(mention => mention.relative as string))].sort(),
    [input.draft],
  )
  // Verdicts are keyed by the canonical spelling (`referenceKey`) because the
  // Host answers an out-of-workspace path with forward slashes while the draft
  // may spell it with backslashes: a lookup by the raw text would miss its own
  // verdict and the row would lose both its cost badge and its 已失效 state.
  const infoByRelative = useMemo(
    () => new Map(infos.map(info => [referenceKey(info.relative), info])),
    [infos],
  )
  // Re-inspect whenever the referenced path set changes. The Host answers with
  // entry metadata only, so pricing a reference never reads file content.
  const targetsKey = targets.join('\n')
  useEffect(() => { requestInspect(targets) }, [targetsKey, enabled])
  if (!enabled) return null
  if (mentions.length === 0) return null
  return (
    <div className="dsh_atFile_rail" role="group" aria-label={t('dock.aria')} data-atlas-dock>
      {mentions.map(mention => {
        const info = infoByRelative.get(referenceKey(mention.relative ?? ''))
        const cost = referenceCost(info)
        const missing = info !== undefined && !info.exists
        // A hand-typed directory (`@Eason`) decodes as a FILE token — the syntax
        // decides by the trailing separator — but the Host's own inspection of that
        // exact path answers `kind: 'dir'`. The row then shows the folder glyph and
        // opens it as the folder it is, the same way the draft token does; without
        // this the two surfaces disagreed about one and the same reference.
        const directory = mention.kind === 'dir' || info?.kind === 'dir'
        const link = mention.link !== undefined && directory && mention.link.kind === 'file'
          ? { kind: 'folder' as const, path: mention.link.path }
          : mention.link
        // A reference whose target is gone keeps its row and its 已失效 badge but
        // offers no open action: handing a vanished path to a viewer is what makes
        // a Sidebar throw its own 400 on a missing target.
        const target = missing ? undefined : link
        const icon = kindIcon(dockIconKind(directory ? 'dir' : mention.kind))
        return (
          <span key={`${mention.key}:${mention.kind}`} className="dsh_atFile_row" data-atlas-row>
            {target !== undefined
              ? (
                <button
                  type="button"
                  className="dsh_atFile_path"
                  title={mention.label}
                  onClick={() => { onOpen(target) }}
                >
                  {icon}
                  {mention.label}
                </button>
              )
              : (
                <span className="dsh_atFile_path" title={mention.label}>
                  {icon}
                  {mention.label}
                </span>
              )}
            {missing && (
              <span className="dsh_atFile_missing" data-atlas-missing title={t('dock.missingTitle')}>
                {t('dock.missing')}
              </span>
            )}
            {cost !== undefined && (
              <span
                className={cost.warn ? 'dsh_atFile_cost dsh_atFile_cost_warn' : 'dsh_atFile_cost'}
                data-atlas-cost
                title={cost.warn
                  ? t('dock.costWarn', { tokens: formatTokenCount(cost.tokens) })
                  : t('dock.cost', { tokens: formatTokenCount(cost.tokens) })}
              >
                {t('dock.cost', { tokens: formatTokenCount(cost.tokens) })}
              </span>
            )}
            <button
              type="button"
              className="dsh_atFile_remove"
              aria-label={t('dock.remove', { name: mention.label })}
              onClick={() => { inputActions.setDraft(withoutToken(input.draft, mention.start, mention.end)) }}
            >
              <IconX size={24} stroke={1.8} color="#ef4444" aria-hidden />
            </button>
          </span>
        )
      })}
    </div>
  )
}