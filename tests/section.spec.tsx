// @vitest-environment jsdom
/** Settings-section behavior for global and workspace-specific file filters. */
import { describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import {
  AtFileSection,
  parseIgnoreFile,
  type AtFileSectionProps,
  type AtFileSectionViewState,
} from '../src/client/SettingsSection.tsx'
import { fmt, zh } from '../src/client/locales.ts'
import { DEFAULT_IGNORE_FILES } from '../src/defaults.ts'
import type { AtFileSettings, FileIgnoreRuleInput, WorkspaceIgnoreFiles } from '../src/contract.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

const t = (key: string, params?: Record<string, string>): string => fmt(zh[key] ?? key, params)

interface WorkspaceStub {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

function workspace(workspaceId: string, path: string, title: string): WorkspaceStub {
  return { workspaceId, path, title, sessionIds: [], createdAt: '', updatedAt: '' }
}

function props(over: {
  unloaded?: boolean
  enabled?: boolean
  ignorePastedMentions?: boolean
  ignoreFiles?: readonly FileIgnoreRuleInput[]
  workspaceIgnoreFiles?: readonly WorkspaceIgnoreFiles[]
  workspaces?: readonly WorkspaceStub[]
  currentCwd?: string
  recentWorkspaceId?: string
  sessions?: Record<string, { updatedAt: number }>
  setEnabled?: (enabled: boolean) => Promise<void>
  setEnableSkills?: (enableSkills: boolean) => Promise<void>
  setEnableChats?: (enableChats: boolean) => Promise<void>
  setEnablePlugins?: (enablePlugins: boolean) => Promise<void>
  setIgnorePastedMentions?: (ignore: boolean) => Promise<void>
  setFolderOpen?: (target: FolderOpenTarget) => Promise<void>
  setHistoryJump?: (enabled: boolean) => Promise<void>
  setHistoryJumpFrames?: (mode: HistoryFrameMode) => Promise<void>
  setHistoryJumpReuseMode?: (mode: HistoryReuseMode) => Promise<void>
  setHistoryJumpSmartFollow?: (enabled: boolean) => Promise<void>
  settings?: Partial<AtFileSettings>
  setIgnoreFiles?: (ignoreFiles: readonly FileIgnoreRuleInput[]) => Promise<void>
  setWorkspaceIgnoreFiles?: (workspace: string, ignoreFiles: readonly FileIgnoreRuleInput[]) => Promise<void>
  viewState?: AtFileSectionViewState
} = {}): AtFileSectionProps {
  const value: AtFileSettings | undefined = over.unloaded === true
    ? undefined
    : {
        enabled: over.enabled ?? true,
        ignoreFiles: [...over.ignoreFiles ?? DEFAULT_IGNORE_FILES],
        workspaceIgnoreFiles: (over.workspaceIgnoreFiles ?? []).map(entry => ({
          workspace: entry.workspace,
          ignoreFiles: [...entry.ignoreFiles],
        })),
        ignorePastedMentions: over.ignorePastedMentions ?? true,
        ...over.settings,
      }
  const items = [...over.workspaces ?? []]
  // Sessions the section may read: the current one (when a cwd is given) plus any
  // the test needs to give its Workspaces a "last used" time.
  const byId: Record<string, { cwd?: string; updatedAt: number }> = { ...over.sessions }
  if (over.currentCwd !== undefined) byId.current = { ...byId.current, cwd: over.currentCwd }
  const sessionState = {
    current: over.currentCwd === undefined ? undefined : 'current',
    byId,
  }
  const stub = {
    useScope: <T,>(selector: (snapshot: { value?: AtFileSettings }) => T): T => selector({ value }),
    useSessions: <T,>(selector: (snapshot: typeof sessionState) => T): T => selector(sessionState),
    useWorkspaces: <T,>(selector: (snapshot: {
      items: readonly WorkspaceStub[]
      recentWorkspaceId?: string
    }) => T): T => selector({ items, recentWorkspaceId: over.recentWorkspaceId }),
    viewState: over.viewState ?? { filterScope: 'global', selectedWorkspace: '' },
    setEnabled: over.setEnabled ?? (async () => {}),
    setEnableSkills: over.setEnableSkills ?? (async () => {}),
    setEnableChats: over.setEnableChats ?? (async () => {}),
    setEnablePlugins: over.setEnablePlugins ?? (async () => {}),
    setIgnorePastedMentions: over.setIgnorePastedMentions ?? (async () => {}),
    setFolderOpen: over.setFolderOpen ?? (async () => {}),
    setHistoryJump: over.setHistoryJump ?? (async () => {}),
    setHistoryJumpFrames: over.setHistoryJumpFrames ?? (async () => {}),
    setHistoryJumpReuseMode: over.setHistoryJumpReuseMode ?? (async () => {}),
    setHistoryJumpSmartFollow: over.setHistoryJumpSmartFollow ?? (async () => {}),
    setIgnoreFiles: over.setIgnoreFiles ?? (async () => {}),
    setWorkspaceIgnoreFiles: over.setWorkspaceIgnoreFiles ?? (async () => {}),
    close: () => {},
    t,
  }
  return stub as unknown as AtFileSectionProps
}

function mount(element: ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return { root, container }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (found === undefined) throw new Error(`missing button: ${label}`)
  return found
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  flushSync(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(target: HTMLElement): void {
  flushSync(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function pressEnter(input: HTMLInputElement): void {
  flushSync(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
}

describe('AtFileSection', () => {
  it('renders a controlled enable checkbox and writes its next value', () => {
    const setEnabled = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ enabled: true, setEnabled })} />)
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    click(checkbox)
    expect(setEnabled).toHaveBeenCalledWith(false)
    root.unmount()
  })

  it('defaults the pasted-mention filter on and writes its next value', () => {
    const setIgnorePastedMentions = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ setIgnorePastedMentions })} />)
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(checkboxes[4]!.checked).toBe(true)
    click(checkboxes[4]!)
    expect(setIgnorePastedMentions).toHaveBeenCalledWith(false)
    root.unmount()
  })

  it('renders the category toggles and writes their next values', () => {
    const setEnableSkills = vi.fn(async () => {})
    const setEnableChats = vi.fn(async () => {})
    const setEnablePlugins = vi.fn(async () => {})
    const { root, container } = mount(
      <AtFileSection {...props({ setEnableSkills, setEnableChats, setEnablePlugins })} />,
    )
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    // Six toggles, the history-jump switch that card added, and the smart-follow
    // opt-in A-19 item 3 added after the reuse-mode select.
    expect(checkboxes).toHaveLength(8)
    expect(checkboxes[1]!.checked).toBe(true)
    expect(checkboxes[2]!.checked).toBe(true)
    expect(checkboxes[3]!.checked).toBe(true)
    click(checkboxes[1]!)
    click(checkboxes[2]!)
    click(checkboxes[3]!)
    expect(setEnableSkills).toHaveBeenCalledWith(false)
    expect(setEnableChats).toHaveBeenCalledWith(false)
    expect(setEnablePlugins).toHaveBeenCalledWith(false)
    root.unmount()
  })

  it('uses schema defaults before the first settings read', () => {
    const { root, container } = mount(<AtFileSection {...props({ unloaded: true })} />)
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
    const names = [...container.querySelectorAll('.dsh_atFile_filterName')].map(node => node.textContent)
    expect(names).toEqual(DEFAULT_IGNORE_FILES)
    expect(container.querySelector('textarea')).toBeNull()
    root.unmount()
  })

  it('adds and removes individual global rules without serializing a text area', async () => {
    const setIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({
      ignoreFiles: ['desktop.ini'],
      setIgnoreFiles,
    })} />)
    const input = container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement
    setInput(input, ' noise.log ')
    click(button(container, zh['settings.add']))
    expect(setIgnoreFiles).toHaveBeenCalledWith(['desktop.ini', 'noise.log'])
    await Promise.resolve()
    flushSync(() => {})

    const remove = container.querySelector('[aria-label="移除 desktop.ini"]') as HTMLButtonElement
    click(remove)
    expect(setIgnoreFiles).toHaveBeenLastCalledWith([])
    root.unmount()
  })

  it('shows workspace additions separately from inherited global rules', () => {
    const setWorkspaceIgnoreFiles = vi.fn(async () => {})
    const workspaces = [
      workspace('one', '/work/one', 'One'),
      workspace('two', '/work/two', 'Two'),
    ]
    const { root, container } = mount(<AtFileSection {...props({
      ignoreFiles: ['desktop.ini'],
      workspaceIgnoreFiles: [{ workspace: '/work/one', ignoreFiles: ['local.tmp'] }],
      workspaces,
      currentCwd: '/work/one',
      setWorkspaceIgnoreFiles,
    })} />)
    click(button(container, zh['settings.workspace']))
    expect((container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement).value).toBe('/work/one')
    expect(container.querySelector('.dsh_atFile_filterName')?.textContent).toBe('local.tmp')
    expect(container.querySelector('.dsh_atFile_inheritedList')?.textContent).toContain('desktop.ini')

    setInput(container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement, 'project.cache')
    click(button(container, zh['settings.add']))
    expect(setWorkspaceIgnoreFiles).toHaveBeenCalledWith('/work/one', ['local.tmp', 'project.cache'])
    click(button(container, zh['settings.global']))
    expect(container.querySelector('.dsh_atFile_workspaceSelect')).toBeNull()
    root.unmount()
  })

  it('switches the editable local list with the workspace selector', () => {
    const setWorkspaceIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({
      workspaceIgnoreFiles: [
        { workspace: '/work/one', ignoreFiles: ['one.tmp'] },
        { workspace: '/work/two', ignoreFiles: ['two.tmp'] },
      ],
      workspaces: [workspace('one', '/work/one', 'One'), workspace('two', '/work/two', 'Two')],
      currentCwd: '/work/one',
      setWorkspaceIgnoreFiles,
    })} />)
    click(button(container, zh['settings.workspace']))
    const select = container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    flushSync(() => {
      setter?.call(select, '/work/two')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('.dsh_atFile_filterName')?.textContent).toBe('two.tmp')
    click(button(container, zh['settings.clearWorkspace']))
    expect(setWorkspaceIgnoreFiles).toHaveBeenCalledWith('/work/two', [])
    root.unmount()
  })

  it('retains the workspace scope and selection across section remounts', () => {
    const viewState: AtFileSectionViewState = { filterScope: 'global', selectedWorkspace: '' }
    const workspaces = [workspace('one', '/work/one', 'One'), workspace('two', '/work/two', 'Two')]
    const first = mount(<AtFileSection {...props({ workspaces, currentCwd: '/work/one', viewState })} />)
    click(button(first.container, zh['settings.workspace']))
    const select = first.container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    flushSync(() => {
      setter?.call(select, '/work/two')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    first.root.unmount()

    const second = mount(<AtFileSection {...props({ workspaces, currentCwd: '/work/one', viewState })} />)
    expect(button(second.container, zh['settings.workspace']).getAttribute('aria-selected')).toBe('true')
    expect((second.container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement).value).toBe('/work/two')
    second.root.unmount()
  })

  it('offers a cwd that is not a Workspace, and reads recency off the newest session', () => {
    const older = { ...workspace('one', '/work/one', 'One'), sessionIds: ['s1'] }
    const newer = { ...workspace('two', '/work/two', 'Two'), sessionIds: ['s2'] }
    // A Workspace with no session at all falls back to its creation time.
    const empty = { ...workspace('three', '/work/three', 'Three'), createdAt: '2026-01-01T00:00:00Z' }
    const { root, container } = mount(<AtFileSection {...props({
      workspaces: [older, newer, empty],
      sessions: { s1: { updatedAt: 10 }, s2: { updatedAt: 99 } },
      currentCwd: '/outside/x',
    })} />)
    click(button(container, zh['settings.workspace']))
    const select = container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement
    const values = [...select.options].map(option => option.value)
    // The current cwd leads when no Workspace claims it, then both Workspaces in
    // snapshot order — recency decides the default, not the order.
    expect(values).toEqual(['/outside/x', '/work/one', '/work/two', '/work/three'])
    expect(select.value).toBe('/outside/x')
    root.unmount()
  })

  it('reselects an available workspace when the previous choice disappears', () => {
    const one = workspace('one', '/work/one', 'One')
    const two = workspace('two', '/work/two', 'Two')
    const initial = props({ workspaces: [one, two], currentCwd: '/work/one' })
    const { root, container } = mount(<AtFileSection {...initial} />)
    click(button(container, zh['settings.workspace']))
    const select = container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    flushSync(() => {
      setter?.call(select, '/work/two')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    flushSync(() => { root.render(<AtFileSection {...props({ workspaces: [one], currentCwd: '/work/one' })} />) })
    expect((container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement).value).toBe('/work/one')
    root.unmount()
  })

  it('rejects paths, current-list duplicates, and inherited global duplicates', () => {
    const setIgnoreFiles = vi.fn(async () => {})
    const setWorkspaceIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({
      ignoreFiles: ['desktop.ini'],
      workspaces: [workspace('one', '/work/one', 'One')],
      currentCwd: '/work/one',
      setIgnoreFiles,
      setWorkspaceIgnoreFiles,
    })} />)
    const input = container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement
    setInput(input, 'tmp/cache.db')
    expect(container.textContent).toContain(zh['settings.invalidName'])
    expect(button(container, zh['settings.add']).disabled).toBe(true)
    pressEnter(input)
    flushSync(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true })) })
    setInput(input, 'DESKTOP.INI')
    expect(container.textContent).toContain(zh['settings.duplicateName'])

    click(button(container, zh['settings.workspace']))
    setInput(container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement, 'DESKTOP.INI')
    expect(container.textContent).toContain(zh['settings.inheritedName'])
    expect(setIgnoreFiles).not.toHaveBeenCalled()
    expect(setWorkspaceIgnoreFiles).not.toHaveBeenCalled()
    root.unmount()
  })

  it('adds a valid rule with Enter', () => {
    const setIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ ignoreFiles: [], setIgnoreFiles })} />)
    const input = container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement
    setInput(input, 'keyboard.tmp')
    pressEnter(input)
    expect(setIgnoreFiles).toHaveBeenCalledWith(['keyboard.tmp'])
    root.unmount()
  })

  it('adds a case-sensitive exact rule as a structured setting', () => {
    const setIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ ignoreFiles: [], setIgnoreFiles })} />)
    const caseToggle = container.querySelector('.dsh_atFile_caseToggle input') as HTMLInputElement
    click(caseToggle)
    setInput(container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement, 'Case.TMP')
    click(button(container, zh['settings.add']))
    expect(setIgnoreFiles).toHaveBeenCalledWith([
      { kind: 'exact', pattern: 'Case.TMP', caseSensitive: true },
    ])
    root.unmount()
  })

  it('validates and adds regular-expression rules', () => {
    const setIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ ignoreFiles: [], setIgnoreFiles })} />)
    click(button(container, zh['settings.kind.regex']))
    const input = container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement
    expect(input.placeholder).toBe(zh['settings.regexPlaceholder'])
    setInput(input, '[')
    expect(container.textContent).toContain(zh['settings.invalidRegex'])
    expect(button(container, zh['settings.add']).disabled).toBe(true)

    setInput(input, '\\.map$')
    click(container.querySelector('.dsh_atFile_caseToggle input') as HTMLInputElement)
    click(button(container, zh['settings.add']))
    expect(setIgnoreFiles).toHaveBeenCalledWith([
      { kind: 'regex', pattern: '\\.map$', caseSensitive: true },
    ])
    click(button(container, zh['settings.kind.exact']))
    expect((container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement).placeholder)
      .toBe(zh['settings.namePlaceholder'])
    root.unmount()
  })

  it('renders and removes structured rules with matching badges', () => {
    const setIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({
      ignoreFiles: [{ kind: 'regex', pattern: '\\.log$', caseSensitive: true }],
      setIgnoreFiles,
    })} />)
    expect(container.querySelector('.dsh_atFile_filterRow')?.textContent).toContain(zh['settings.kind.regex'])
    expect(container.querySelector('.dsh_atFile_filterRow')?.textContent).toContain(zh['settings.caseSensitive'])
    click(container.querySelector('.dsh_atFile_filterRemove') as HTMLButtonElement)
    expect(setIgnoreFiles).toHaveBeenCalledWith([])
    root.unmount()
  })

  it('restores the built-in global rules', () => {
    const setIgnoreFiles = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ ignoreFiles: [], setIgnoreFiles })} />)
    click(button(container, zh['settings.restoreDefaults']))
    expect(setIgnoreFiles).toHaveBeenCalledWith(DEFAULT_IGNORE_FILES)
    root.unmount()
  })

  it('disables workspace editing when the last workspace disappears', () => {
    const { root, container } = mount(<AtFileSection {...props({ currentCwd: '/work/one' })} />)
    click(button(container, zh['settings.workspace']))
    flushSync(() => { root.render(<AtFileSection {...props()} />) })
    expect((container.querySelector('.dsh_atFile_workspaceSelect') as HTMLSelectElement).disabled).toBe(true)
    expect((container.querySelector('.dsh_atFile_filterInput') as HTMLInputElement).disabled).toBe(true)
    root.unmount()
  })

  it('normalizes one proposed file name', () => {
    expect(parseIgnoreFile(' Thumbs.db ')).toBe('Thumbs.db')
    expect(parseIgnoreFile('   ')).toBeUndefined()
  })

  it('labels a filesystem root used as the current workspace', () => {
    const { root, container } = mount(<AtFileSection {...props({ currentCwd: '/' })} />)
    click(button(container, zh['settings.workspace']))
    // Scoped to the workspace picker: the two history selects below it are not
    // workspace rows either, and one of them also offers a '/' option.
    expect(container.querySelector('.dsh_atFile_workspaceSelect option')?.textContent).toBe('/ - /')
    root.unmount()
  })

  it('no longer offers the folder-open setting at all (A-16.7)', () => {
    const setFolderOpen = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ setFolderOpen })} />)
    // The card is gone because the choice is gone: a folder reference opens in the
    // sidebar alone, so the copy must not linger either — and the injected verb,
    // which stays for the persisted field, must not be driven by anything.
    expect(container.textContent).not.toContain('点击文件夹时')
    expect(container.textContent).not.toContain('侧边栏 + 本地打开')
    expect(container.querySelectorAll('select.dsh_atFile_folderOpenSelect')).toHaveLength(2)
    expect(setFolderOpen).not.toHaveBeenCalled()
    root.unmount()
  })

  it('writes the history-jump toggle through the injected verb', () => {
    const setHistoryJump = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ setHistoryJump })} />)
    // Located by its own label rather than by position, so another card inserted
    // above it cannot silently retarget this assertion.
    const cards = [...container.querySelectorAll('label.dsh_atFile_card')]
    const card = cards.find(node => node.textContent?.includes(zh['settings.historyJump']))
    const checkbox = card?.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    click(checkbox)
    expect(setHistoryJump).toHaveBeenCalledWith(false)
    root.unmount()
  })

  it('writes the history granularity and reuse choices through their verbs', () => {
    const setHistoryJumpFrames = vi.fn(async () => {})
    const setHistoryJumpReuseMode = vi.fn(async () => {})
    const { root, container } = mount(
      <AtFileSection {...props({ setHistoryJumpFrames, setHistoryJumpReuseMode })} />,
    )
    const selects = [...container.querySelectorAll('.dsh_atFile_folderOpenSelect')] as HTMLSelectElement[]
    // Granularity, reuse — in render order. (The folder-open select that used to
    // sit ahead of them is gone as of A-16.7, so these indices moved up by one.)
    expect(selects).toHaveLength(2)
    // A-33: the ladder is the page's turn ruler, so `turn` is what an unset
    // profile must show. The message-grained walk is still reachable, and the
    // write below is what proves the other direction is wired.
    expect(selects[0]!.value).toBe('turn')
    expect(selects[1]!.value).toBe('replace')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(selects[0]!, 'message')
    selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(setHistoryJumpFrames).toHaveBeenCalledWith('message')
    setter?.call(selects[1]!, 'append')
    selects[1]!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(setHistoryJumpReuseMode).toHaveBeenCalledWith('append')
    root.unmount()
  })

  it('writes the smart-follow choice through its verb, and defaults it off', () => {
    // A-19 item 3. The default matters as much as the write: following the scroll
    // redefines what "the previous message" means, so it must be opt-in. Driving
    // the real checkbox is what proves the row is wired to the verb at all.
    const setHistoryJumpSmartFollow = vi.fn(async () => {})
    const { root, container } = mount(<AtFileSection {...props({ setHistoryJumpSmartFollow })} />)
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.dsh_atFile_checkbox')]
    const follow = boxes[boxes.length - 1]!
    expect(follow.checked).toBe(false)
    follow.click()
    expect(setHistoryJumpSmartFollow).toHaveBeenCalledWith(true)
    root.unmount()
  })

  it('disables the history sub-choices while the feature is off', () => {
    const { root, container } = mount(<AtFileSection {...props({ settings: { historyJump: false } })} />)
    const selects = [...container.querySelectorAll('.dsh_atFile_folderOpenSelect')] as HTMLSelectElement[]
    // Both remaining selects describe the switched-off feature, so both go dead.
    expect(selects).toHaveLength(2)
    expect(selects[0]!.disabled).toBe(true)
    expect(selects[1]!.disabled).toBe(true)
    root.unmount()
  })
})