/**
 * The history frame index: the current session's user messages, in order, as the
 * reusable "frames" the F1 palette lists and the F2 cursor walks.
 *
 * Everything here is derived from the Host's own authoritative Chat snapshot
 * (`useChat`), which a session-scoped slot receives as a standard prop — so this
 * feature adds NO wire endpoint and never reads file content. The DOM is used
 * only to SCROLL to a frame's row, never to decide what the frames are: the row
 * attributes the scroll looks for are absent from some shipped builds, and a
 * missing attribute must degrade to "highlight without scrolling" rather than
 * to a broken feature.
 *
 * A frame is one message the user can WALK to. In the default `'message'` mode
 * that is every readable message of the session: the two kinds a user writes
 * (`user`, and `steering` for an interjection claimed mid-turn) plus the
 * assistant's own prose (`reply`). The question that produced the reply kind was
 * "why does Up/Down stop on my input but never on the answer, the answer is a
 * message too" — and it is: a reader scrolling back through a session wants to
 * land on the answer as much as on the question.
 *
 * What still never becomes a frame: tool calls, injected context, and any node
 * whose text is empty (a reply cancelled before its first token, a step that is
 * pure tool plumbing). Those have no row worth stopping on.
 *
 * `'turn'` mode keeps its original meaning — one frame per turn, its opening
 * prompt — because that is the coarse granularity a user asks for when a whole
 * exchange should be one stop.
 */

/** Which frame granularity the user chose. */
export type HistoryFrameMode = 'message' | 'turn'

/**
 * One message the walk can stop on, projected from one Chat node.
 *
 * `reply` frames are the assistant's own prose: they are walkable but not
 * reusable-by-chord, because the chord's answer to "reuse" is to put the text in
 * the composer and an answer is not something the user wrote (see
 * {@link isUserAuthored}).
 */
export interface HistoryFrame {
  /** The Chat node key; also the value of its row's `data-chat-anchor-key`. */
  readonly key: string
  /** Durable seq, used for paging the window back to this frame. */
  readonly seq: number
  /** The owning turn, or undefined when the node has no resolved turn. */
  readonly turn: number | undefined
  /** Epoch ms of the source event. */
  readonly time: number
  /** A normal user message, a mid-turn interjection, or the assistant's reply. */
  readonly kind: 'user' | 'steering' | 'reply'
  /**
   * The message's original text: every text block of `content`, joined.
   *
   * This is the durable content, NOT the rendered DOM text, which is why a
   * reused `@label` comes back as the reference token the user typed instead of
   * as decoration the composer would no longer recognise.
   */
  readonly text: string
  /** A one-line preview for the palette row. */
  readonly preview: string
  /** The turn's assistant answer, for the palette's second line (empty when none). */
  readonly answer: string
  /** Whether the message carried non-text blocks (images/files) that will NOT be reused. */
  readonly hasAttachment: boolean
  /**
   * True when this frame came from the session-wide outline rather than from a
   * loaded node, i.e. the message's row is NOT in the client window yet and
   * {@link HistoryFrame.text} holds the outline's bounded preview instead of the
   * original text.
   *
   * This exists because the readout's total must agree with the page's own turn
   * ruler (`turnOutline` folds the WHOLE log; the loaded window is paged), and a
   * walk that stopped at the window made the two disagree — the reported bug was
   * "ruler has many ticks while the readout says 0 / 0". A consumer that needs
   * the original text (a reuse) pages the window to {@link HistoryFrame.seq}
   * first and lets the loaded frame replace this placeholder.
   */
  readonly unloaded: boolean
  /**
   * The node's own `source.kind === 'user'` verdict, when the node carries a
   * readable source. `undefined` means "no source to read", which is NOT the same
   * as "not user-authored" — a node shape without a source is left to the other
   * evidence rather than being silently excluded from the chord's frame set.
   */
  readonly authoredByUser?: boolean
  /**
   * True when the TURN was started by the system/plugin rather than by the user,
   * i.e. the roam bar must label it (A-20).
   *
   * This is deliberately SEPARATE from {@link HistoryFrame.authoredByUser}, even
   * though the two agree on loaded frames. `authoredByUser` is a per-NODE verdict
   * and can be `undefined` ("no source to read"); this flag is a per-TURN verdict
   * that is always decided, because the roam bar has to say something either way.
   * The evidence differs by where the frame came from:
   *   * a LOADED frame reads its node's `source.kind`;
   *   * an UNLOADED frame has no node, so its evidence is the outline itself: the
   *     projection records a turn's prompt ONLY for a human `user/message`
   *     (`session-turn-outline/projection.ts:110` returns early otherwise), so an
   *     empty prompt on an unloaded turn means the system started it. That is also
   *     why such a frame's text is empty and the bar used to render blank.
   */
  readonly systemInitiated: boolean
}

/** The subset of a content block this module reads. */
interface ContentBlockLike {
  readonly type?: string
  readonly text?: unknown
}

/** The node shape read off the Chat snapshot; every field is optional because
 * the snapshot is a cross-package value whose discriminant this plugin narrows
 * itself rather than trusting. */
interface ChatNodeLike {
  readonly kind?: unknown
  readonly data?: unknown
  readonly location?: unknown
}

/** How many characters of a message the palette row shows. */
export const FRAME_PREVIEW_LENGTH = 120

/** How many characters of an answer the palette row shows. */
export const FRAME_ANSWER_LENGTH = 90

/**
 * Collapse whitespace so a multi-line message becomes one readable row.
 * @param text - the raw text.
 * @returns the collapsed text.
 */
export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Truncate to a display length, appending an ellipsis when cut.
 * @param text - already-collapsed text.
 * @param limit - maximum characters.
 * @returns the preview.
 */
export function truncate(text: string, limit: number): string {
  const characters = [...text]
  if (characters.length <= limit) return text
  return `${characters.slice(0, limit).join('')}…`
}

/**
 * Read one node's text and whether it carries something a rewrite cannot restore.
 *
 * Only `text` blocks are reused. An `image` or `file` block is deliberately
 * dropped — the composer's draft is a string, so there is nowhere to put it —
 * and its presence is reported instead, so the palette can warn the user that
 * the reuse is text-only rather than silently losing an attachment.
 * @param data - the node's `data` payload.
 * @returns the joined text and the attachment flag.
 */
export function readContent(data: unknown): { text: string; hasAttachment: boolean } {
  const content = (data as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return { text: '', hasAttachment: false }
  const texts: string[] = []
  let hasAttachment = false
  for (const block of content as readonly ContentBlockLike[]) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
      continue
    }
    // Anything else that is a known non-text payload is an attachment; an
    // unknown block type is ignored so a future block cannot break the index.
    if (block.type === 'image' || block.type === 'file') hasAttachment = true
  }
  return { text: texts.join('\n'), hasAttachment }
}

/**
 * Read the turn a node belongs to, when it has a resolved one.
 *
 * A node whose location is `unresolved` (typically injected context) has no
 * turn and is not part of the conversation's own history.
 * @param location - the node's `location`.
 * @returns the turn number, or undefined.
 */
export function readTurn(location: unknown): number | undefined {
  const resolved = location as { kind?: unknown; turn?: { turn?: unknown } } | undefined
  if (resolved?.kind !== 'turn' && resolved?.kind !== 'step') return undefined
  const turn = resolved.turn?.turn
  return typeof turn === 'number' ? turn : undefined
}

/** The answer text collected so far for one turn, appended as nodes are read. */
interface TurnAnswer {
  parts: string[]
}

/**
 * Read the assistant text of one node, when it has any.
 *
 * Assistant nodes do NOT share the message shape: a message carries
 * `content: ContentBlock[]` discriminated by `type`, while an assistant step
 * carries `blocks: AssistantBlock[]` discriminated by `kind` and only ever
 * joined through `data.blocks`. Reading `content` here would silently yield
 * nothing, so the two shapes are read separately.
 * @param node - the node.
 * @returns the assistant text, or undefined when this node is not assistant prose.
 */
function answerTextOf(node: ChatNodeLike): string | undefined {
  if (node.kind !== 'assistant-step') return undefined
  const blocks = (node.data as { blocks?: unknown } | undefined)?.blocks
  if (!Array.isArray(blocks)) return undefined
  const texts: string[] = []
  for (const block of blocks as readonly { kind?: unknown; text?: unknown }[]) {
    if (block === null || typeof block !== 'object') continue
    if (block.kind === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  const text = texts.join('\n').trim()
  return text === '' ? undefined : text
}

/**
 * One entry of the session-wide `turnOutline` projection, structurally narrowed.
 *
 * The value crosses the wire as projection data, so it is treated as untrusted:
 * `turn` and `seq` are load-bearing (a frame cannot be counted or paged without
 * them) and a damaged entry is dropped, while the previews are decorative and
 * degrade to `''`.
 */
export interface OutlineTurn {
  /** The turn number. */
  readonly turn: number
  /** The `turn/start` seq — the load-through target that pages this turn in. */
  readonly seq: number
  /** The turn's first human prompt, as the outline's bounded preview. */
  readonly prompt: string
  /** The turn's final assistant response, as the outline's bounded preview. */
  readonly response: string
}

/**
 * Structurally narrow the `turnOutline` projection value into outline turns.
 *
 * This is the SAME projection the page's turn ruler renders
 * (`ui-chat/src/client/chat/turn-rail-items.ts`), which is what makes the walk's
 * total agree with the ruler's ticks. It folds the WHOLE log, including turns
 * outside the client's paged event window — the whole reason the readout could
 * say `0 / 0` while the ruler drew many marks is that this plugin only walked
 * the loaded window.
 * @param value - the projection value, treated as wire data.
 * @returns the turns, ascending; a stable empty array when absent or malformed.
 */
export function readOutlineTurns(value: unknown): readonly OutlineTurn[] {
  if (!Array.isArray(value)) return EMPTY_OUTLINE
  const turns: OutlineTurn[] = []
  for (const raw of value as readonly unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as { turn?: unknown; seq?: unknown; prompt?: unknown; response?: unknown }
    if (typeof entry.turn !== 'number' || !Number.isSafeInteger(entry.turn) || entry.turn < 0) continue
    if (typeof entry.seq !== 'number' || !Number.isSafeInteger(entry.seq) || entry.seq < 0) continue
    turns.push({
      turn: entry.turn,
      seq: entry.seq,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      response: typeof entry.response === 'string' ? entry.response : '',
    })
  }
  return turns.length === 0 ? EMPTY_OUTLINE : turns
}

/** A stable empty result, so an absent projection cannot churn a dependency. */
const EMPTY_OUTLINE: readonly OutlineTurn[] = []

/**
 * Build the reusable frames of one session, oldest first.
 *
 * `user`, `steering` and `assistant-step` nodes become frames. In `'turn'` mode
 * only the first frame of each turn survives and the turn's later interjections
 * and replies are folded away — that is the coarser granularity a user asks for
 * when one stop per exchange is what they want; in the default `'message'` mode
 * every interjection and every reply keeps its own frame, because each one is an
 * independent thing the walk should be able to land on.
 *
 * `outline` extends the list past the loaded window with a frame per turn the
 * window does not hold. Those frames are marked `unloaded` and carry the
 * outline's bounded preview as their text, because the projection deliberately
 * does not ship message bodies. Including them is what keeps the walk's total
 * equal to the page's own turn ruler: without it a session whose window holds no
 * user nodes reads `0 / 0` while the ruler shows a dozen marks, and the walk has
 * nothing to step through.
 * @param order - the Chat snapshot's render order (node keys).
 * @param getNode - reads one node by key.
 * @param mode - the configured frame granularity.
 * @param outline - the `turnOutline` projection value.
 * @returns the frames, oldest first.
 */
export function buildFrames(
  order: readonly string[],
  getNode: (key: string) => ChatNodeLike | undefined,
  mode: HistoryFrameMode = 'message',
  outline: unknown = undefined,
): readonly HistoryFrame[] {
  const answers = new Map<number, TurnAnswer>()
  const frames: HistoryFrame[] = []
  // Which turns the user opened (a prompt node exists), and which assistant node
  // holds a turn's LAST readable answer. Both are collected in the same pass:
  // the first says whether a turn's stop is a reply or a system turn, the second
  // is what keeps a replayed first chunk from becoming a stop of its own.
  const promptTurns = new Set<number>()
  const lastAnswerKey = new Map<number, string>()

  // The answer of a turn is assembled from every assistant node of that turn.
  // A turn can answer across several steps, so the parts are joined in order.
  const nodes: { key: string; node: ChatNodeLike }[] = []
  for (const key of order) {
    const node = getNode(key)
    if (node === undefined) continue
    nodes.push({ key, node })
    const turn = readTurn(node.location)
    if (turn === undefined) continue
    if (node.kind === 'user' || node.kind === 'steering') promptTurns.add(turn)
    const text = answerTextOf(node)
    if (text === undefined) continue
    const bucket = answers.get(turn) ?? { parts: [] }
    bucket.parts.push(text)
    answers.set(turn, bucket)
    // The LAST node carrying prose is the turn's answer. A turn can stream more
    // than one assistant node, and the first one is often a replay of the
    // paragraph before it (measured in the browser lane: the same opening
    // sentence twice, half a turn apart). Only the last one is a stop; the
    // earlier ones would be duplicate rows in the palette and duplicate stops in
    // the walk.
    if (text.trim() !== '') lastAnswerKey.set(turn, key)
  }

  const seenTurns = new Set<number>()
  for (const { key, node } of nodes) {
    const kind = node.kind
    if (kind !== 'user' && kind !== 'steering' && kind !== 'assistant-step') continue
    const turn = readTurn(node.location)
    if (kind === 'assistant-step') {
      // `'turn'` mode is the page's own ladder (see `turn-rail-items.ts`): one
      // stop per TURN. A turn WITH a prompt is already represented by that prompt
      // node, so its answers never form a second stop — that duplication is
      // exactly what made 11 turns read as 22 stops while the ruler drew 11
      // marks. A turn with NO prompt (the system opened it) has no other trace,
      // so its last readable answer becomes the turn's one stop. Either way a
      // reply carrying no prose (a cancelled turn, a step that is pure tool
      // plumbing) has no row worth stopping on.
      if (mode === 'turn' && (turn === undefined || promptTurns.has(turn))) continue
      // One stop per ANSWER, not per streamed node: only the node that carries
      // the turn's last prose is the answer (see `lastAnswerKey`).
      if (turn === undefined || lastAnswerKey.get(turn) !== key) continue
      const replyText = answerTextOf(node)
      if (replyText === undefined || replyText.trim() === '') continue
      const replyData = node.data as { seq?: unknown; time?: unknown } | undefined
      frames.push({
        key,
        seq: typeof replyData?.seq === 'number' ? replyData.seq : 0,
        turn,
        time: typeof replyData?.time === 'number' ? replyData.time : 0,
        kind: 'reply',
        text: replyText,
        preview: truncate(collapse(replyText), FRAME_PREVIEW_LENGTH),
        answer: '',
        hasAttachment: false,
        unloaded: false,
        // The assistant wrote it, so the chord must not offer it as "reuse what
        // you wrote"; the walk still stops here.
        authoredByUser: false,
        // A turn nobody asked a question in is a SYSTEM turn: its only trace on
        // this walk is the answer, so that is where the origin is worth naming.
        // A reply to a prompt is tagged as a reply instead.
        systemInitiated: !promptTurns.has(turn),
      })
      // Claimed, so the outline does not synthesize a second frame for the same
      // turn: this node IS that turn's frame.
      seenTurns.add(turn)
      continue
    }
    if (turn !== undefined) {
      if (mode === 'turn') {
        // A turn's frames collapse to its FIRST user message. A turn without a
        // resolved turn number cannot be de-duplicated, so it stands alone.
        if (seenTurns.has(turn)) continue
      }
      // Recorded in BOTH modes: in `'message'` mode it gates the turn's reply
      // frame above, and it costs nothing where nothing reads it.
      seenTurns.add(turn)
    }
    const data = node.data as { seq?: unknown; time?: unknown; source?: unknown } | undefined
    const { text, hasAttachment } = readContent(node.data)
    const answer = turn === undefined ? '' : (answers.get(turn)?.parts.join('\n') ?? '')
    const sourceKind = (data?.source as { kind?: unknown } | undefined)?.kind
    frames.push({
      key,
      seq: typeof data?.seq === 'number' ? data.seq : 0,
      turn,
      time: typeof data?.time === 'number' ? data.time : 0,
      kind,
      text,
      preview: truncate(collapse(text), FRAME_PREVIEW_LENGTH),
      answer: truncate(collapse(answer), FRAME_ANSWER_LENGTH),
      hasAttachment,
      unloaded: false,
      // Kept undefined when the node has no readable source, so the decision is
      // left to the other evidence instead of being defaulted to a "no".
      authoredByUser: typeof sourceKind === 'string' ? sourceKind === 'user' : undefined,
      // A loaded node with a readable source decides this directly. Without a
      // source there is no evidence that the SYSTEM started the turn, so it is
      // not labelled — mislabelling a user's own message as "system" is the one
      // error that would be worse than the blank this fixes.
      systemInitiated: typeof sourceKind === 'string' && sourceKind !== 'user',
    })
  }

  return mergeOutlineFrames(frames, readOutlineTurns(outline))
}

/**
 * Append the outline's unloaded turns as trailing frames.
 *
 * The outline is ordered by turn and so is the window, so every turn the window
 * does not hold is OLDER than the window's newest frame — but not necessarily
 * older than all of it: a window can start mid-turn, and a session opened at a
 * jump target holds a middle slice. So unloaded turns are placed by TURN ORDER
 * rather than simply prepended, which keeps the array ascending and lets the
 * existing slot arithmetic keep working unchanged.
 *
 * A turn the window already holds contributes nothing here: that turn's frame
 * came from real nodes and carries the original text.
 * @param loaded - frames built from the loaded window, ascending.
 * @param outline - the turns of the whole log, ascending.
 * @returns every frame, ascending; the input array itself when nothing is added.
 */
function mergeOutlineFrames(
  loaded: readonly HistoryFrame[],
  outline: readonly OutlineTurn[],
): readonly HistoryFrame[] {
  if (outline.length === 0) return loaded
  const heldTurns = new Set<number>()
  for (const frame of loaded) {
    if (frame.turn !== undefined) heldTurns.add(frame.turn)
  }
  // A turn belonging to no frame of the window is exactly a turn the window does
  // not hold. Turn numbers ascend in the outline, so the extras go in ascending.
  const extras: HistoryFrame[] = []
  for (const entry of outline) {
    if (heldTurns.has(entry.turn)) continue
    extras.push({
      // No node backs this frame, so there is no anchor key to scroll to. The
      // seq is what pages the row in, and it is also the frame's identity.
      key: `turn:${entry.turn}`,
      seq: entry.seq,
      turn: entry.turn,
      time: 0,
      kind: 'user',
      text: entry.prompt,
      preview: truncate(collapse(entry.prompt), FRAME_PREVIEW_LENGTH),
      answer: truncate(collapse(entry.response), FRAME_ANSWER_LENGTH),
      hasAttachment: false,
      unloaded: true,
      // No node to read a source from, so the OUTLINE is the evidence: it records a
      // prompt only for a human message, so an empty prompt means the system
      // started this turn (see the field's own note).
      authoredByUser: entry.prompt === '' ? undefined : true,
      systemInitiated: entry.prompt === '',
    })
  }
  if (extras.length === 0) return loaded
  const merged = [...loaded, ...extras]
  // Ascending by turn; an unturn'd loaded frame has no position to claim, so it
  // keeps its window place and sorts before the numbered ones.
  merged.sort((left, right) => (left.turn ?? -1) - (right.turn ?? -1))
  return merged
}

/**
 * Whether the log itself records that a human typed this frame's prompt.
 *
 * A-19 splits the two features by what they are FOR. The chord exists so a user
 * can reuse something they WROTE, so a turn nobody typed — one the system started
 * on its own — must not be reachable by it. Roaming exists so a user can READ
 * around a message, so it keeps every frame.
 *
 * The signal is the outer `turnOutline` projection's own rule, not a guess: that
 * unit folds a turn's prompt only when `source.kind === 'user'`
 * (`session-turn-outline/src/projection.ts`), so a system-initiated turn keeps
 * `prompt: ''`. A loaded frame is judged the same way from its node's `source`.
 * @param frame - the frame.
 * @returns whether a human wrote it.
 */
export function isUserAuthored(frame: HistoryFrame): boolean {
  // A reply is the assistant's text by construction, whatever its source says.
  if (frame.kind === 'reply') return false
  // An outline extra has no node behind it, so the projection's verdict is the
  // only evidence there is: it left the prompt empty, which is what it does for a
  // turn whose opening message carried `source.kind !== 'user'`.
  if (frame.unloaded) return frame.text.trim() !== ''
  return frame.authoredByUser !== false
}

/**
 * The frames the quick chord may reuse: the user-authored ones, oldest first.
 *
 * Filtering happens BEFORE the walk wraps, so the chord's own first/last frame is
 * the first/last thing it can actually reach — a system-initiated turn in the
 * middle must not leave a position the chord can land on but not use.
 * @param frames - every frame of the session, oldest first.
 * @returns the user-authored subset, oldest first.
 */
export function userAuthoredFrames(frames: readonly HistoryFrame[]): readonly HistoryFrame[] {
  const kept = frames.filter(isUserAuthored)
  // Returning the input array when nothing was dropped keeps its identity, so a
  // caller's memo does not churn on every render.
  return kept.length === frames.length ? frames : kept
}

/**
 * Build a usage counter key that identifies one frame's message.
 * @param frame - the frame.
 * @returns the key.
 */
export function frameKeyOf(frame: HistoryFrame): string {
  return frame.turn === undefined ? frame.key : `${frame.turn}:${frame.key}`
}
