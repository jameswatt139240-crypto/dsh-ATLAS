/**
 * The hand-written Remote contribution's boundary discipline: the descriptor
 * is strict, its codecs accept the exact wire values the host emits, and
 * reject malformed ones. This mirrors what the Client Gateway's own
 * `requireStrictDescriptor` demands at mount time.
 */
import { describe, expect, it } from 'vitest'
import { AT_REMOTE } from '../src/client/remote.ts'

describe('AT_REMOTE', () => {
  it('owns the atFile and atMention endpoints', () => {
    expect(AT_REMOTE.package).toBe('dsh-atlas')
    expect(AT_REMOTE.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`))
      .toEqual([
        'atFile/search',
        'atFile/getSettings',
        'atFile/updateSettings',
        'atFile/inspect',
        'atFile/external',
        'atFile/list',
        'atMention/listSkills',
        'atMention/listChats',
        'atMention/listPlugins',
        'atlas/runtime',
      'atlas/gitChanges',
      ])
  })

  it('declares strict codecs on every parameter and result', () => {
    for (const descriptor of AT_REMOTE.descriptors) {
      expect(descriptor.result.mode).toBe('strict')
      for (const parameter of descriptor.parameters) expect(parameter.codec.mode).toBe('strict')
    }
  })

  it('routes the atMention category methods with agent lookup and signal cancellation', () => {
    const pick = (endpoint: string): (typeof AT_REMOTE.descriptors)[number] =>
      AT_REMOTE.descriptors.find(descriptor => `${descriptor.namespace}/${descriptor.method}` === endpoint)!
    const skills = pick('atMention/listSkills')
    expect(skills.parameters[0]).toMatchObject({ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent' })
    expect(skills.cancellation).toEqual({ parameter: 'signal' })
    const chats = pick('atMention/listChats')
    expect(chats.parameters.map(parameter => parameter.name)).toEqual(['agent', 'query', 'limit'])
    expect(chats.cancellation).toEqual({ parameter: 'signal' })
    const plugins = pick('atMention/listPlugins')
    expect(plugins.parameters).toEqual([])
    expect(plugins.cancellation).toEqual({ parameter: 'signal' })
    const inspect = pick('atFile/inspect')
    expect(inspect.parameters.map(parameter => parameter.name)).toEqual(['agent', 'targets'])
    expect(inspect.cancellation).toEqual({ parameter: 'signal' })
  })

  it('declares strict codecs on every parameter and result', () => {
    for (const descriptor of AT_REMOTE.descriptors) {
      expect(descriptor.result.mode).toBe('strict')
      for (const parameter of descriptor.parameters) expect(parameter.codec.mode).toBe('strict')
    }
  })

  it('routes search through the agent lookup with a trailing signal', () => {
    const search = AT_REMOTE.descriptors[0]!
    expect(search.invocation).toEqual({ kind: 'direct' })
    expect(search.cancellation).toEqual({ parameter: 'signal' })
    expect(search.parameters).toHaveLength(1)
    expect(search.parameters[0]).toMatchObject({ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent' })
  })

  it('routes one strict JSON field update to the settings writer', () => {
    const update = AT_REMOTE.descriptors[2]!
    expect(update.invocation).toEqual({ kind: 'direct' })
    expect(update.parameters).toHaveLength(1)
    expect(update.parameters[0]).toMatchObject({ name: 'update', wire: 'update', source: 'json' })
    const schema = update.parameters[0]!.codec.schema as { parse(value: unknown): unknown }
    expect(schema.parse({ field: 'enabled', value: false })).toEqual({ field: 'enabled', value: false })
    expect(schema.parse({ field: 'ignorePastedMentions', value: false }))
      .toEqual({ field: 'ignorePastedMentions', value: false })
    expect(schema.parse({ field: 'workspaceIgnoreFiles', value: [{ workspace: '/ws', ignoreFiles: ['a.tmp'] }] }))
      .toEqual({ field: 'workspaceIgnoreFiles', value: [{ workspace: '/ws', ignoreFiles: ['a.tmp'] }] })
    expect(schema.parse({
      field: 'ignoreFiles',
      value: [
        { kind: 'exact', pattern: 'Case.tmp', caseSensitive: true },
        { kind: 'regex', pattern: '\\.map$', caseSensitive: false },
        { kind: 'regex', pattern: '\\.MAP$', caseSensitive: true },
      ],
    })).toEqual({
      field: 'ignoreFiles',
      value: [
        { kind: 'exact', pattern: 'Case.tmp', caseSensitive: true },
        { kind: 'regex', pattern: '\\.map$', caseSensitive: false },
        { kind: 'regex', pattern: '\\.MAP$', caseSensitive: true },
      ],
    })
    expect(() => schema.parse({ field: 'ignoreFiles', value: [{ kind: 'regex', pattern: '[', caseSensitive: false }] })).toThrow()
    expect(() => schema.parse({ field: 'enabled', value: 'false' })).toThrow()
    // A durable field the client WRITES must be in this union: the Host Gateway
    // validates the arguments against it, so a missing arm turns the write into
    // `gateway/arguments-invalid` and the setting can never be saved at all
    // (observed live before this arm existed).
    expect(schema.parse({ field: 'folderOpen', value: 'sidebar' })).toEqual({ field: 'folderOpen', value: 'sidebar' })
    expect(() => schema.parse({ field: 'folderOpen', value: 'somewhere' })).toThrow()
  })

  it('search codecs accept host entries (files and directories) and reject malformed rows', () => {
    const schema = AT_REMOTE.descriptors[0]!.result.schema as { parse(value: unknown): unknown }
    expect(schema.parse([{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }, { path: '/ws/src', relative: 'src', kind: 'dir' }]))
      .toEqual([{ path: '/ws/a.ts', relative: 'a.ts', kind: 'file' }, { path: '/ws/src', relative: 'src', kind: 'dir' }])
    expect(() => schema.parse([{ path: '/ws/a.ts', relative: 'a.ts' }])).toThrow()
    expect(() => schema.parse([{ path: '', relative: 'a.ts', kind: 'file' }])).toThrow()
    expect(() => schema.parse('nope')).toThrow()
  })

  it('settings codecs reject incomplete resolved sections', () => {
    const schema = AT_REMOTE.descriptors[1]!.result.schema as { parse(value: unknown): unknown }
    expect(schema.parse({ enabled: true, ignoreFiles: [], workspaceIgnoreFiles: [] }))
      .toEqual({
        enabled: true,
        ignoreFiles: [],
        workspaceIgnoreFiles: [],
        ignorePastedMentions: true,
        enableSkills: true,
        enableChats: true,
        enablePlugins: true,
        candidateLimit: 50,
        recentFiles: [],
        usage: [],
        folderOpen: 'both',
      })
    expect(() => schema.parse({ enabled: true, ignoreFiles: [] })).toThrow()
    // The field has to survive the RESULT codec too: the update reply is decoded
    // with this same schema, so a field missing here would be dropped on the way
    // back and the UI would silently revert to the default.
    expect(schema.parse({ enabled: true, ignoreFiles: [], workspaceIgnoreFiles: [], folderOpen: 'native' }))
      .toMatchObject({ folderOpen: 'native' })
  })

  it('the directory-listing codec carries both kinds and every refusal', () => {
    const list = AT_REMOTE.descriptors.find(descriptor => descriptor.method === 'list')!
    expect(list.parameters.map(parameter => parameter.name)).toEqual(['agent', 'path'])
    expect(list.cancellation).toEqual({ parameter: 'signal' })
    const schema = list.result.schema as { parse(value: unknown): unknown }
    expect(schema.parse({ path: 'E:/ws', parent: 'E:/', entries: [{ name: 'src', kind: 'dir' }] }))
      .toEqual({ path: 'E:/ws', parent: 'E:/', entries: [{ name: 'src', kind: 'dir' }] })
    expect(schema.parse({ path: 'E:/', entries: [], drives: ['C:/'], truncated: true }))
      .toEqual({ path: 'E:/', entries: [], drives: ['C:/'], truncated: true })
    expect(schema.parse({ path: 'E:/x', entries: [], error: 'outside' }))
      .toEqual({ path: 'E:/x', entries: [], error: 'outside' })
    // A row without a kind, an unknown refusal, or a non-array listing is not a listing.
    expect(() => schema.parse({ path: 'E:/x', entries: [{ name: 'a' }] })).toThrow()
    expect(() => schema.parse({ path: 'E:/x', entries: [], error: 'whatever' })).toThrow()
    expect(() => schema.parse({ path: 'E:/x', entries: 'none' })).toThrow()
  })
})