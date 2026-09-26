// @vitest-environment jsdom
/**
 * The folder chooser dialog: the product's browse backend wearing this plugin's
 * face. These cases pin the interaction the product's own dialog has (path line,
 * walk in, hidden filter, new folder, open/cancel), because the component cannot
 * be borrowed — only its backend can.
 */
import { describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { FolderPicker, type FolderPickerProps, type PickerListing } from '../src/client/FolderPicker.tsx'
import { fmt, zh } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = false

const t = (key: string, params?: Record<string, string>): string => fmt(zh[key] ?? key, params)

const entry = (name: string, path: string, hidden = false) => ({ name, path, hidden })

/** One level per path, so a walk is observable through the `list` spy. */
const LEVELS: Record<string, PickerListing> = {
  'E:/': { path: 'E:/', home: 'E:/home', crumbs: [], truncated: false, entries: [entry('home', 'E:/home')] },
  'E:/home': { path: 'E:/home', home: 'E:/home', crumbs: [entry('E:', 'E:/')], truncated: false, entries: [entry('work', 'E:/home/work'), entry('.cache', 'E:/home/.cache', true)] },
  'E:/home/work': { path: 'E:/home/work', home: 'E:/home', crumbs: [entry('E:', 'E:/'), entry('home', 'E:/home')], truncated: false, entries: [entry('src', 'E:/home/work/src')] },
}

/** Mount the dialog OPEN over one injected backend. */
function mount(overrides: Partial<{ create: (path: string, name: string) => Promise<string> }> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const list = vi.fn(async (path?: string) => LEVELS[path ?? 'E:/home'] as PickerListing)
  const confirm = vi.fn()
  const close = vi.fn()
  const create = vi.fn(overrides.create ?? (async (_path: string, name: string) => `E:/home/${name}`))
  const stub = {
    useFolderPicker: (select: (snapshot: { value: unknown }) => unknown) => select({ value: { span: { start: 0, end: 1, draftRev: 2 } } }),
    list,
    create,
    confirm,
    close,
    t,
    session: {},
  }
  flushSync(() => { root.render(<FolderPicker {...(stub as unknown as FolderPickerProps)} />) })
  return { container, root, list, confirm, close, create }
}

/** Let the listing promise settle and the commit land (passive effects are scheduled). */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise(resolve => { setTimeout(resolve, 0) })
    flushSync(() => {})
  }
}

const rows = (container: HTMLElement) => [...container.querySelectorAll('.dsh_atlas_pickerRow')]
const rowNames = (container: HTMLElement) => rows(container).map(row => (row.textContent || '').trim())

describe('the folder chooser', () => {
  it('starts at home, hides dot-folders, and walks in on a click', async () => {
    const { container, root, list } = mount()
    await settle()
    // Home by default (the backend lists it when given no path), hidden filtered out.
    expect(list).toHaveBeenCalledWith(undefined, expect.anything())
    expect(container.querySelector('.dsh_atlas_pickerPath')?.textContent).toBe('E:/home')
    expect(rowNames(container)).toEqual(['work›'])
    ;(rows(container)[0] as HTMLElement).click()
    await settle()
    expect(list).toHaveBeenLastCalledWith('E:/home/work', expect.anything())
    expect(container.querySelector('.dsh_atlas_pickerPath')?.textContent).toBe('E:/home/work')
    expect(rowNames(container)).toEqual(['src›'])
    root.unmount()
  })

  it('shows hidden folders when asked, and jumps through a crumb', async () => {
    const { container, root, list } = mount()
    await settle()
    const toggle = container.querySelector('.dsh_atlas_pickerToggle input') as HTMLInputElement
    flushSync(() => { toggle.click() })
    expect(rowNames(container)).toEqual(['work›', '.cache›'])
    // A crumb is a jump target, exactly like the product's dialog. (The first
    // crumb button is the 主目录 shortcut; the `E:` crumb is the ancestry one.)
    const crumb = [...container.querySelectorAll('.dsh_atlas_pickerCrumb')][1] as HTMLElement
    flushSync(() => { crumb.click() })
    await settle()
    expect(list).toHaveBeenCalledWith('E:/', expect.anything())
    root.unmount()
  })

  it('adopts the folder the path line shows, and cancels without adopting', async () => {
    const { container, root, confirm, close } = mount()
    await settle()
    ;(rows(container)[0] as HTMLElement).click()
    await settle()
    const buttons = [...container.querySelectorAll('.dsh_atlas_pickerButton')] as HTMLElement[]
    const open = buttons.find(button => (button.textContent || '').includes(zh['picker.open'])) as HTMLElement
    const cancel = buttons.find(button => (button.textContent || '').includes(zh['picker.cancel'])) as HTMLElement
    flushSync(() => { open.click() })
    expect(confirm).toHaveBeenCalledWith('E:/home/work')
    flushSync(() => { cancel.click() })
    expect(close).toHaveBeenCalled()
    root.unmount()
  })

  it('creates a folder and walks into it, editing the path line by hand', async () => {
    const { container, root, create, list } = mount()
    await settle()
    const newFolder = [...container.querySelectorAll('.dsh_atlas_pickerButton')]
      .find(button => (button.textContent || '').includes(zh['picker.newFolder'])) as HTMLElement
    flushSync(() => { newFolder.click() })
    const input = container.querySelector('.dsh_atlas_pickerNewRow input') as HTMLInputElement
    // React tracks its own value: the native setter is what a real keystroke goes through.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    flushSync(() => {
      setValue?.call(input, 'fresh')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = container.querySelector('.dsh_atlas_pickerNewRow') as HTMLFormElement
    flushSync(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await settle()
    expect(create).toHaveBeenCalledWith('E:/home', 'fresh')
    expect(list).toHaveBeenLastCalledWith('E:/home/fresh', expect.anything())
    root.unmount()
  })

  it('says why a backend cannot list instead of showing an empty dialog', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const stub = {
      useFolderPicker: (select: (snapshot: { value: unknown }) => unknown) => select({ value: {} }),
      list: async () => { throw new Error('no browse capability') },
      create: async () => '', confirm: () => {}, close: () => {}, t, session: {},
    }
    flushSync(() => { root.render(<FolderPicker {...(stub as unknown as FolderPickerProps)} />) })
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('no browse capability')
    root.unmount()
  })
})
