/**
 * Session-reference CLICK-THROUGH: decode the two shapes a session mention
 * leaves behind, and decide the one session (if any) each names.
 *
 * Why this module exists at all: a session mention is folded to a bare label
 * before the message is durable (`parseSessionReferenceText` replaces
 * `@[label](dsh-session:…)` with `@label`), and the editor keeps the wire form
 * as plain TEXT rather than an atomic chip — measured live, so neither the
 * bubble's chip `title` nor the composer's DOM carries a session id. Two shapes
 * therefore survive, and each needs its own rule:
 *
 * - the WIRE form `@[label](dsh-session:<base64url(JSON string)>)`, which names
 *   its session exactly, and
 * - a bare `@label`, which names nothing by itself and is opened ONLY when the
 *   session list contains exactly ONE matching session (id or title). A guess
 *   would hijack a real file: `@AGENTS.md` is a file long before it is a
 *   session, and the plugin must never turn a workspace path into a jump.
 *
 * Pure string + list work, so the browser bridge stays a thin event adapter and
 * the rules are pinned by their own spec.
 */

/** One session reference a click can act on. */
export interface SessionLink {
  readonly sessionId: string
  /** The session a bare label resolves to, for the "no id in the label" shape. */
  readonly resolvedFrom?: string
}

/** URI scheme `@deepseek-ai/dsh-session-reference` reserves for session snapshots. */
const SESSION_URI_SCHEME = 'dsh-session:'

/** The wire mention, captured as label + payload. Matches the framework's own grammar. */
export const WIRE_MENTION_RE = /^@\[([^\]\n]*)\]\((dsh-session:[^)\s]+)\)$/u

/**
 * The wire mention that STARTS at one character offset of a line, if any.
 *
 * The composer's token reader is whitespace-bounded, which is exactly why this
 * exists: a session label routinely contains spaces (`@[继续 LoongCrush 项目的任务](…)`)
 * and the whitespace rule would cut the mention at its first space, leaving a
 * fragment that decodes as a FILE path. `$` is replaced by a lookahead so the
 * regex can be anchored at a position inside a longer line.
 * @param text - one line's text.
 * @param offset - the offset the mention would start at (the `@`).
 * @returns the mention and its end offset, or undefined when none starts there.
 */
export function wireMentionAt(text: string, offset: number): { readonly end: number } | undefined {
  if (text[offset] !== '@') return undefined
  const match = /@\[([^\]\n]*)\]\((dsh-session:[^)\s]+)\)(?=\s|$)/uy
  match.lastIndex = offset
  const found = match.exec(text)
  return found === null ? undefined : { end: offset + found[0].length }
}

/**
 * The `dsh-session:` URI inside one wire mention, or undefined for any other
 * spelling. Shared so the sent-message decoder and the draft activation can ask
 * the same question instead of each keeping its own copy of the grammar.
 * @param text - a chip `title` or a draft token.
 * @returns the URI, ready for {@link decodeSessionUri}.
 */
export function wireSessionUri(text: string): string {
  return WIRE_MENTION_RE.exec(text)?.[2] ?? ''
}

/**
 * Decode one `dsh-session:` URI into the session id it names.
 *
 * The payload is base64url of `JSON.stringify(id)` (the host's canonical
 * encoding), so a payload that decodes to anything but one JSON string is not a
 * session address — and the round trip is verified, exactly as the host's own
 * decoder does, so a non-canonical spelling can never name a different session.
 * @param uri - a complete `dsh-session:` URI.
 * @returns the session id, or undefined when the URI is malformed.
 */
export function decodeSessionUri(uri: string): string | undefined {
  if (!uri.startsWith(SESSION_URI_SCHEME)) return undefined
  const payload = uri.slice(SESSION_URI_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) return undefined
  let decoded: string
  try {
    // base64url -> base64, then the ASCII payload -> percent-escapes -> UTF-8.
    const base64 = payload.replace(/-/gu, '+').replace(/_/gu, '/')
    const binary = atob(base64)
    decoded = decodeURIComponent([...binary].map(char =>
      `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'string' || parsed === '') return undefined
  return encodeSessionUri(parsed) === uri ? parsed : undefined
}

/**
 * Encode a session id the way the host does, so {@link decodeSessionUri} can
 * prove the URI it was handed is canonical.
 * @param sessionId - the id to encode.
 * @returns the canonical `dsh-session:` URI.
 */
function encodeSessionUri(sessionId: string): string {
  const json = JSON.stringify(sessionId)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return SESSION_URI_SCHEME + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Split a reference-chip label / draft token into its wire halves. */
function wireParts(label: string): { label: string; sessionId: string } | undefined {
  const match = WIRE_MENTION_RE.exec(label)
  if (match === null) return undefined
  // `label` and `uri` are both non-optional capture groups of the same pattern.
  const sessionId = decodeSessionUri(match[2] as string)
  if (sessionId === undefined) return undefined
  return { label: match[1] as string, sessionId }
}

/** The label a bare session token would carry, without its `@`. */
function bareLabel(token: string): string | undefined {
  if (!token.startsWith('@')) return undefined
  const label = token.slice(1)
  if (label === '' || /[\s()[\]{}]/u.test(label)) return undefined
  return label
}

/** Look one label up against the live session list. */
export interface SessionLinkDeps {
  /**
   * The session one mention label names, or undefined when it names none or
   * more than one. Implemented over `ctx.sessions.list`, so the plugin never
   * guesses: ambiguity answers undefined and the reference stays inert.
   */
  matchLabel(label: string): string | undefined
}

/**
 * The lookup a DRAFT asks before it may promote a bare `@label` into a session
 * link, or undefined for a bridge that may not promote one at all. Injection
 * passes the plugin's `ctx.sessions.list` reader; everything else (a test, the
 * sent-message bridge) leaves it out and bare labels stay dead letters.
 */
export type SessionLabelResolver = (label: string) => string | undefined

/**
 * Resolve one reference label (a chip `title`, or a draft token without its
 * `@`… see the callers) into a session to open.
 *
 * The wire form is exact and needs no list. A bare label is accepted ONLY in
 * the draft, where the user's own typing is the intent: in a SENT bubble the
 * same bare label also decorates plain prose (`@AGENTS.md` is routinely a
 * file), so promoting it there would overrule a file reference the user made.
 * @param text - the label with its leading `@`, or the full wire mention.
 * @param deps - the live session lookup.
 * @param allowBareLabel - whether a bare `@label` may be promoted (draft only).
 * @returns the session to open, or undefined when nothing may be opened.
 */
export function resolveSessionLink(
  text: string,
  deps: SessionLinkDeps,
  allowBareLabel: boolean,
): SessionLink | undefined {
  const wire = wireParts(text)
  if (wire !== undefined) return { sessionId: wire.sessionId }
  if (!allowBareLabel) return undefined
  const label = bareLabel(text)
  if (label === undefined) return undefined
  const sessionId = deps.matchLabel(label)
  return sessionId === undefined ? undefined : { sessionId, resolvedFrom: label }
}
