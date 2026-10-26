/**
 * `history-frames.ts` — the pure frame index.
 *
 * The two content SHAPES are the point of most of these cases: a user message
 * carries `content: ContentBlock[]` discriminated by `type`, an assistant step
 * carries `blocks: AssistantBlock[]` discriminated by `kind`. Reading the wrong
 * one yields nothing at all (silently), so each shape is asserted explicitly.
 */
import { describe, expect, it } from 'vitest'
import {
  buildFrames,
  collapse,
  isUserAuthored,
  userAuthoredFrames,
  frameKeyOf,
  FRAME_ANSWER_LENGTH,
  FRAME_PREVIEW_LENGTH,
  readContent,
  readTurn,
  truncate,
  type HistoryFrame,
} from '../src/client/history-frames.ts'

/** One user message node, in the Host's `content[]` shape. */
function userNode(
  content: readonly unknown[],
  options: { turn?: number; seq?: number; time?: number; kind?: string } = {},
): unknown {
  return {
    kind: options.kind ?? 'user',
    data: { content, seq: options.seq ?? 1, time: options.time ?? 1_000 },
    location: options.turn === undefined ? { kind: 'session' } : { kind: 'turn', turn: { turn: options.turn } },
  }
}

/** One assistant step node, in the Host's `blocks[]` shape. */
function assistantNode(blocks: readonly unknown[], turn: number): unknown {
  return {
    kind: 'assistant-step',
    data: { blocks },
    location: { kind: 'turn', turn: { turn } },
  }
}

describe('reply frames', () => {
  // Two questions asked by the user, answered in one node each.
  const text = (value: string) => [{ kind: 'text', text: value }]

  it('walks the reply of a turn whose prompt the user wrote, tagged as a reply', () => {
    const table: Record<string, unknown> = {
      u1: userNode([{ type: 'text', text: 'a question' }], { turn: 1 }),
      a1: assistantNode(text('an answer'), 1),
    }
    const frames = buildFrames(Object.keys(table), key => table[key] as never)
    expect(frames.map(frame => frame.kind)).toEqual(['user', 'reply'])
    expect(frames[1]?.text).toBe('an answer')
    // The turn's origin is known: this is a reply, not a system turn.
    expect(frames[1]?.systemInitiated).toBe(false)
    // …and it is never offered as "reuse what you wrote".
    expect(isUserAuthored(frames[1] as HistoryFrame)).toBe(false)
    expect(userAuthoredFrames(frames).map(frame => frame.key)).toEqual(['u1'])
  })

  it('walks a system turn, whose only trace is the answer, tagged as the system', () => {
    // The reported gap: "第 9-13 条都是系统发起的，但都没随 up/down 切换". A turn the
    // user never prompted has no `user` node at all, so the answer is the ONLY
    // thing there is to stop on.
    const table: Record<string, unknown> = {
      u1: userNode([{ type: 'text', text: 'a question' }], { turn: 1 }),
      a1: assistantNode(text('an answer'), 1),
      a2: assistantNode(text('a scheduled report'), 2),
    }
    const frames = buildFrames(Object.keys(table), key => table[key] as never)
    expect(frames.map(frame => frame.key)).toEqual(['u1', 'a1', 'a2'])
    expect(frames[2]?.kind).toBe('reply')
    expect(frames[2]?.systemInitiated).toBe(true)
    expect(frames[2]?.text).toBe('a scheduled report')
  })

  it('gives a turn ONE stop even when its answer streamed in several nodes', () => {
    // A turn can emit more than one assistant node, and the first is often a
    // replay of the paragraph above it. Both would be duplicate rows in the
    // palette and duplicate stops in the walk, so only the LAST answer counts.
    const table: Record<string, unknown> = {
      u1: userNode([{ type: 'text', text: 'a question' }], { turn: 1 }),
      a1: assistantNode(text('a repeated opening'), 1),
      a1b: assistantNode(text('the real answer'), 1),
    }
    const frames = buildFrames(Object.keys(table), key => table[key] as never)
    expect(frames.map(frame => frame.key)).toEqual(['u1', 'a1b'])
    expect(frames[1]?.text).toBe('the real answer')
  })

  it('leaves a reply out of turn mode, where one stop is the whole exchange', () => {
    const table: Record<string, unknown> = {
      u1: userNode([{ type: 'text', text: 'a question' }], { turn: 1 }),
      a1: assistantNode(text('an answer'), 1),
    }
    const frames = buildFrames(Object.keys(table), key => table[key] as never, 'turn')
    expect(frames.map(frame => frame.key)).toEqual(['u1'])
  })

  it('gives a system turn no stop when its only answer carries no prose', () => {
    // The turn has no prompt node, so it would stop on its last answer — but that
    // answer is blank (a cancelled turn, or pure tool plumbing), and a stop with
    // nothing to read is worse than no stop.
    const table: Record<string, unknown> = {
      a1: assistantNode([{ kind: 'text', text: '   ' }], 7),
    }
    expect(buildFrames(Object.keys(table), key => table[key] as never, 'turn')).toEqual([])
  })
})

describe('collapse', () => {
  it('flattens every whitespace run and trims the ends', () => {
    expect(collapse('  a\n\n b\t c  ')).toBe('a b c')
  })

  it('leaves an already-flat string alone', () => {
    expect(collapse('plain')).toBe('plain')
  })

  it('returns an empty string for whitespace only', () => {
    expect(collapse(' \n\t ')).toBe('')
  })
})

describe('truncate', () => {
  it('keeps text at exactly the limit', () => {
    expect(truncate('abcde', 5)).toBe('abcde')
  })

  it('marks text longer than the limit', () => {
    expect(truncate('abcdef', 5)).toBe('abcde…')
  })

  it('counts by code point, not by UTF-16 unit', () => {
    // An emoji is one character to the user even though it is two units, so it
    // must not be able to consume two characters of the budget (or be split).
    expect(truncate('😀😀😀', 2)).toBe('😀😀…')
  })
})

describe('readContent', () => {
  it('joins every text block with newlines', () => {
    const result = readContent({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    expect(result).toEqual({ text: 'one\ntwo', hasAttachment: false })
  })

  it('reports an image block as an attachment without reusing it', () => {
    const result = readContent({ content: [{ type: 'text', text: 'look' }, { type: 'image' }] })
    expect(result).toEqual({ text: 'look', hasAttachment: true })
  })

  it('reports a file block as an attachment', () => {
    expect(readContent({ content: [{ type: 'file' }] })).toEqual({ text: '', hasAttachment: true })
  })

  it('ignores an unknown block type rather than failing', () => {
    // A future block kind must not break the index or be mistaken for an
    // attachment the reuse would silently lose.
    expect(readContent({ content: [{ type: 'future-thing' }] })).toEqual({ text: '', hasAttachment: false })
  })

  it('ignores a non-string text payload', () => {
    expect(readContent({ content: [{ type: 'text', text: 42 }] })).toEqual({ text: '', hasAttachment: false })
  })

  it('ignores a non-object entry', () => {
    expect(readContent({ content: [null, 'nope'] })).toEqual({ text: '', hasAttachment: false })
  })

  it('answers empty when there is no content array', () => {
    expect(readContent({})).toEqual({ text: '', hasAttachment: false })
    expect(readContent(undefined)).toEqual({ text: '', hasAttachment: false })
    expect(readContent({ content: 'not-an-array' })).toEqual({ text: '', hasAttachment: false })
  })
})

describe('readTurn', () => {
  it('reads the turn from a turn location', () => {
    expect(readTurn({ kind: 'turn', turn: { turn: 3 } })).toBe(3)
  })

  it('reads the turn from a step location', () => {
    expect(readTurn({ kind: 'step', turn: { turn: 4 } })).toBe(4)
  })

  it('answers undefined for a session location', () => {
    expect(readTurn({ kind: 'session' })).toBeUndefined()
  })

  it('answers undefined for an unresolved location', () => {
    expect(readTurn({ kind: 'unresolved' })).toBeUndefined()
  })

  it('answers undefined when the turn number is not a number', () => {
    expect(readTurn({ kind: 'turn', turn: { turn: 'three' } })).toBeUndefined()
  })

  it('answers undefined for absent input', () => {
    expect(readTurn(undefined)).toBeUndefined()
  })
})

describe('buildFrames', () => {
  const order = ['u1', 'a1', 'u2', 's1', 'a2', 'ctx']
  const table: Record<string, unknown> = {
    u1: userNode([{ type: 'text', text: 'first question' }], { turn: 1, seq: 1 }),
    a1: assistantNode([{ kind: 'text', text: 'answer one' }], 1),
    u2: userNode([{ type: 'text', text: 'second question' }], { turn: 2, seq: 2 }),
    s1: userNode([{ type: 'text', text: 'a mid-turn interjection' }], { turn: 2, seq: 3, kind: 'steering' }),
    a2: assistantNode([{ kind: 'text', text: 'answer two' }], 2),
    ctx: { kind: 'context', data: {}, location: { kind: 'unresolved' } },
  }
  const getNode = (key: string): never => table[key] as never

  it('walks user, steering AND assistant messages, oldest first, ignoring context', () => {
    const frames = buildFrames(order, getNode)
    // The reply kind is the reported gap: Up/Down used to stop on the question
    // and skip straight over the answer, so an answer is now its own stop.
    expect(frames.map(frame => frame.key)).toEqual(['u1', 'a1', 'u2', 's1', 'a2'])
    expect(frames.map(frame => frame.kind)).toEqual(['user', 'reply', 'user', 'steering', 'reply'])
  })

  it('marks a mid-turn interjection as its own steering frame', () => {
    const frames = buildFrames(order, getNode)
    expect(frames.find(frame => frame.key === 's1')?.kind).toBe('steering')
  })

  it('gives a reply frame the answer text as its own text, with no second line', () => {
    const frames = buildFrames(order, getNode)
    const reply = frames.find(frame => frame.key === 'a1')
    expect(reply?.text).toBe('answer one')
    expect(reply?.preview).toBe('answer one')
    expect(reply?.answer).toBe('')
    expect(reply?.turn).toBe(1)
  })

  it('refuses to call a reply user-authored, so the reuse chord cannot land on it', () => {
    const frames = buildFrames(order, getNode)
    expect(isUserAuthored(frames.find(frame => frame.key === 'a1') as HistoryFrame)).toBe(false)
    expect(userAuthoredFrames(frames).map(frame => frame.key)).toEqual(['u1', 'u2', 's1'])
  })

  it("folds replies away in 'turn' mode, where the opening prompt stands for the exchange", () => {
    const frames = buildFrames(order, getNode, 'turn')
    expect(frames.map(frame => frame.key)).toEqual(['u1', 'u2'])
  })

  it('skips an assistant step with no readable prose', () => {
    const table = {
      u: userNode([{ type: 'text', text: 'q' }], { turn: 1 }),
      tool: assistantNode([{ kind: 'tool-call', name: 'read' }], 1),
      empty: assistantNode([{ kind: 'text', text: '   ' }], 1),
    }
    const frames = buildFrames(['u', 'tool', 'empty'], key => table[key as 'u'] as never)
    expect(frames.map(frame => frame.key)).toEqual(['u'])
  })

  it('attaches the turn answer to every frame of that turn', () => {
    const frames = buildFrames(order, getNode)
    expect(frames.find(frame => frame.key === 'u1')?.answer).toBe('answer one')
    expect(frames.find(frame => frame.key === 'u2')?.answer).toBe('answer two')
    // The interjection shares its turn's answer.
    expect(frames.find(frame => frame.key === 's1')?.answer).toBe('answer two')
  })

  it('joins a multi-step answer in step order', () => {
    const multi = {
      u: userNode([{ type: 'text', text: 'q' }], { turn: 1 }),
      a1: assistantNode([{ kind: 'text', text: 'part one' }], 1),
      a2: assistantNode([{ kind: 'text', text: 'part two' }], 1),
    }
    const frames = buildFrames(['u', 'a1', 'a2'], key => multi[key as 'u'] as never)
    // The parts are joined with newlines and then COLLAPSED for display, so the
    // palette row reads as one line rather than keeping the step break.
    expect(frames[0]?.answer).toBe('part one part two')
  })

  it('reads the original text, not any rendered decoration', () => {
    const frames = buildFrames(['u'], () => userNode([{ type: 'text', text: '@AGENTS.md please read' }], { turn: 1 }) as never)
    expect(frames[0]?.text).toBe('@AGENTS.md please read')
  })

  it('carries seq and time through', () => {
    const frames = buildFrames(['u'], () => userNode([{ type: 'text', text: 'x' }], { turn: 1, seq: 9, time: 4242 }) as never)
    expect(frames[0]?.seq).toBe(9)
    expect(frames[0]?.time).toBe(4242)
  })

  it('flags an attachment-carrying message', () => {
    const frames = buildFrames(['u'], () => userNode([{ type: 'text', text: 'see' }, { type: 'image' }], { turn: 1 }) as never)
    expect(frames[0]?.hasAttachment).toBe(true)
  })

  it('previews and truncates the message text', () => {
    const long = 'word '.repeat(60)
    const frames = buildFrames(['u'], () => userNode([{ type: 'text', text: long }], { turn: 1 }) as never)
    const preview = frames[0]?.preview ?? ''
    expect(preview.endsWith('…')).toBe(true)
    expect([...preview].length).toBe(FRAME_PREVIEW_LENGTH + 1)
  })

  it('truncates the answer separately from the message', () => {
    const long = 'answer '.repeat(60)
    const nodes = {
      u: userNode([{ type: 'text', text: 'q' }], { turn: 1 }),
      a: assistantNode([{ kind: 'text', text: long }], 1),
    }
    const frames = buildFrames(['u', 'a'], key => nodes[key as 'u'] as never)
    expect([...(frames[0]?.answer ?? '')].length).toBe(FRAME_ANSWER_LENGTH + 1)
  })

  it('folds a turn to its first message in turn mode', () => {
    const frames = buildFrames(order, getNode, 'turn')
    expect(frames.map(frame => frame.key)).toEqual(['u1', 'u2'])
  })

  it('keeps an unresolved-turn message even in turn mode', () => {
    // Without a turn number there is nothing to de-duplicate against, so the
    // frame stands alone instead of being wrongly folded into another turn.
    const nodes = {
      a: userNode([{ type: 'text', text: 'one' }]),
      b: userNode([{ type: 'text', text: 'two' }]),
    }
    const frames = buildFrames(['a', 'b'], key => nodes[key as 'a'] as never, 'turn')
    expect(frames.map(frame => frame.key)).toEqual(['a', 'b'])
  })

  it('skips a key the snapshot cannot resolve', () => {
    expect(buildFrames(['missing'], () => undefined)).toEqual([])
  })

  it('ignores a non-text assistant block', () => {
    const nodes = {
      u: userNode([{ type: 'text', text: 'q' }], { turn: 1 }),
      a: { kind: 'assistant-step', data: { blocks: [{ kind: 'tool' }, null, 'no'] }, location: { kind: 'turn', turn: { turn: 1 } } },
    }
    const frames = buildFrames(['u', 'a'], key => nodes[key as 'u'] as never)
    expect(frames[0]?.answer).toBe('')
  })

  it('treats a whitespace-only answer as no answer', () => {
    const nodes = {
      u: userNode([{ type: 'text', text: 'q' }], { turn: 1 }),
      a: assistantNode([{ kind: 'text', text: '   \n ' }], 1),
    }
    const frames = buildFrames(['u', 'a'], key => nodes[key as 'u'] as never)
    expect(frames[0]?.answer).toBe('')
  })

  it('ignores an assistant step without a blocks array', () => {
    const nodes = {
      u: userNode([{ type: 'text', text: 'q' }], { turn: 1 }),
      a: { kind: 'assistant-step', data: {}, location: { kind: 'turn', turn: { turn: 1 } } },
    }
    const frames = buildFrames(['u', 'a'], key => nodes[key as 'u'] as never)
    expect(frames[0]?.answer).toBe('')
  })

  it('answers empty for an empty conversation', () => {
    expect(buildFrames([], () => undefined)).toEqual([])
  })

  it('defaults missing seq and time to zero', () => {
    const frames = buildFrames(['u'], () => ({ kind: 'user', data: {}, location: { kind: 'session' } }) as never)
    expect(frames[0]?.seq).toBe(0)
    expect(frames[0]?.time).toBe(0)
  })

  it('leaves the turn undefined for a message with no resolved turn', () => {
    const frames = buildFrames(['u'], () => userNode([{ type: 'text', text: 'x' }]) as never)
    expect(frames[0]?.turn).toBeUndefined()
    expect(frames[0]?.answer).toBe('')
  })
})

describe('buildFrames with the session-wide outline', () => {
  const outline = [
    { turn: 1, seq: 11, prompt: 'oldest', response: 'a1' },
    { turn: 2, seq: 22, prompt: 'middle', response: 'a2' },
    { turn: 3, seq: 33, prompt: 'newest', response: 'a3' },
  ]

  it('adds an unloaded frame per outline turn when the window holds nothing', () => {
    // The reported shape: the window has no user node, the outline names turns.
    const frames = buildFrames([], () => undefined, 'message', outline)
    expect(frames.map(frame => frame.turn)).toEqual([1, 2, 3])
    expect(frames.map(frame => frame.unloaded)).toEqual([true, true, true])
    expect(frames.map(frame => frame.seq)).toEqual([11, 22, 33])
    // The outline ships a preview, not the message body, and the frame says so.
    expect(frames.map(frame => frame.text)).toEqual(['oldest', 'middle', 'newest'])
    expect(frames[0]?.preview).toBe('oldest')
    expect(frames[0]?.answer).toBe('a1')
    expect(frames[0]?.key).toBe('turn:1')
    expect(frames[0]?.kind).toBe('user')
    expect(frames[0]?.hasAttachment).toBe(false)
  })

  it('does not duplicate a turn the window already holds, and keeps the loaded text', () => {
    const nodes = { u: userNode([{ type: 'text', text: 'middle loaded in full' }], { turn: 2 }) }
    const frames = buildFrames(['u'], key => nodes[key as 'u'] as never, 'message', outline)
    expect(frames.map(frame => frame.turn)).toEqual([1, 2, 3])
    // Turn 2's frame is the LOADED one: full text, no placeholder flag.
    const held = frames[1]
    expect(held?.unloaded).toBe(false)
    expect(held?.text).toBe('middle loaded in full')
  })

  it('places an unloaded turn by turn order, not blindly at the front', () => {
    // A window that starts mid-session holds turn 5 while the outline names 1..5,
    // so the extras belong BEFORE it, not after.
    const nodes = { u: userNode([{ type: 'text', text: 'fifth' }], { turn: 5 }) }
    const frames = buildFrames(
      ['u'],
      key => nodes[key as 'u'] as never,
      'message',
      [{ turn: 5, seq: 55, prompt: 'fifth outline', response: '' }, { turn: 1, seq: 11, prompt: 'first', response: '' }],
    )
    expect(frames.map(frame => frame.turn)).toEqual([1, 5])
    expect(frames[0]?.unloaded).toBe(true)
    expect(frames[1]?.unloaded).toBe(false)
  })

  it('keeps an unturn\'d loaded frame in the walk rather than dropping it', () => {
    const nodes = { u: userNode([{ type: 'text', text: 'no turn' }]) }
    const frames = buildFrames(['u'], key => nodes[key as 'u'] as never, 'message', outline)
    expect(frames).toHaveLength(4)
    expect(frames[0]?.turn).toBeUndefined()
    expect(frames[1]?.turn).toBe(1)
  })

  it('adds nothing for an absent, empty, or malformed outline', () => {
    const nodes = { u: userNode([{ type: 'text', text: 'q' }], { turn: 1 }) }
    const get = (key: string): never => nodes[key as 'u'] as never
    const loaded = buildFrames(['u'], get)
    // `buildFrames` itself always returns a fresh array (the memo identity is
    // `useMemo`'s job, upstream), so these assert on CONTENT: an outline that
    // contributes nothing must leave the loaded frames exactly as they were.
    expect(buildFrames(['u'], get, 'message', undefined)).toEqual(loaded)
    expect(buildFrames(['u'], get, 'message', [])).toEqual(loaded)
    expect(buildFrames(['u'], get, 'message', 'nope')).toEqual(loaded)
    expect(buildFrames(['u'], get, 'message', { length: 3 })).toEqual(loaded)
    // Every entry damaged => no extras => the loaded walk is unchanged.
    expect(buildFrames(['u'], get, 'message', [null, 7, {}, { turn: 1 }])).toEqual(loaded)
    expect(loaded).toHaveLength(1)
  })

  it('drops only the damaged entries of a partly valid outline', () => {
    const frames = buildFrames([], () => undefined, 'message', [
      { turn: 1, seq: 11, prompt: 'ok', response: '' },
      { turn: -1, seq: 5, prompt: 'negative', response: '' },
      { turn: 1.5, seq: 5, prompt: 'fractional', response: '' },
      { turn: 2, seq: -3, prompt: 'negative seq', response: '' },
      { turn: 3, seq: 33, prompt: 'also ok', response: '' },
    ])
    expect(frames.map(frame => frame.turn)).toEqual([1, 3])
  })

  it('degrades a damaged preview to an empty one and still walks the turn', () => {
    const frames = buildFrames([], () => undefined, 'message', [
      { turn: 1, seq: 11, prompt: 42, response: null },
    ])
    expect(frames).toHaveLength(1)
    expect(frames[0]?.text).toBe('')
    expect(frames[0]?.preview).toBe('')
    expect(frames[0]?.answer).toBe('')
  })

  it('truncates an over-long outline preview like a loaded message', () => {
    const long = 'x'.repeat(500)
    const frames = buildFrames([], () => undefined, 'message', [{ turn: 1, seq: 11, prompt: long, response: long }])
    expect([...(frames[0]?.preview ?? '')].length).toBe(121)
    expect([...(frames[0]?.answer ?? '')].length).toBe(91)
  })

  it('collapses whitespace in an outline preview', () => {
    const frames = buildFrames([], () => undefined, 'message', [
      { turn: 1, seq: 11, prompt: '  a \n\n b  ', response: ' x\n y ' },
    ])
    expect(frames[0]?.preview).toBe('a b')
    expect(frames[0]?.answer).toBe('x y')
  })
})

describe('frameKeyOf', () => {
  it('qualifies the key with the turn when there is one', () => {
    expect(frameKeyOf({ turn: 2, key: 'k' } as HistoryFrame)).toBe('2:k')
  })

  it('falls back to the bare node key without a turn', () => {
    expect(frameKeyOf({ turn: undefined, key: 'k' } as HistoryFrame)).toBe('k')
  })
})
