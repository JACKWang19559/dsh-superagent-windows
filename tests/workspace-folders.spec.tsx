// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceFolders, type WorkspaceFoldersProps } from '../src/client/workspace-folders.tsx'
import { observeWorkspaceFolders, arrangeWorkspaceFolders, type WorkspaceFolderMounts } from '../src/client/workspace-folders-dom.ts'
import { updateWorkspaceFolders, workspaceFoldersView, type WorkspaceFolderMetadata } from '../src/app/workspace-folders.ts'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const disposers: (() => void)[] = []
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const t: T = (key, args) => Object.entries(args ?? {}).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), zh[key])
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
  vi.stubGlobal('cancelAnimationFrame', (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))
})
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals() })
function native() {
  const sidebar = document.createElement('div')
  sidebar.setAttribute('data-slot', 'sidebar.workspaces')
  sidebar.innerHTML = `<header><span>工作区</span><div class="search"><input aria-label="搜索工作区"></div><div data-slot="sidebar.workspaces.directoryFlow"></div></header><div role="tree"></div>`
  document.body.append(sidebar)
  const tree = sidebar.querySelector<HTMLElement>('[role="tree"]')!
  const group = (id: string) => {
    const section = document.createElement('div')
    section.innerHTML = `<span><div data-row-key="workspace:${id}" draggable="true" role="treeitem">${id}</div></span><button data-row-key="session:${id}">Session ${id}</button>`
    section.style.setProperty('--dsh-workspace-indent', '0px')
    tree.append(section)
    return section
  }
  return { sidebar, tree, group, search: sidebar.querySelector<HTMLInputElement>('input')! }
}
const input = async (element: HTMLInputElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (element: HTMLElement) => { await act(async () => { element.click() }); await settle() }
const label = <E extends HTMLElement>(text: string) => [...document.querySelectorAll<E>('[aria-label]')].find(node => node.getAttribute('aria-label') === text)!
async function app(initial?: WorkspaceFolderMetadata) {
  const host = native(), state = host.group('state'), worker = host.group('worker'), other = host.group('other')
  const items = [{ workspaceId: 'state', path: 'D:\\Trial\\STATE\\', title: 'state' },
    { workspaceId: 'worker', path: 'D:/trial/work/task', title: 'Task' }, { workspaceId: 'other', path: 'D:/other', title: 'Other' }]
  const source = { repository: 'owner/repo', stateDir: 'd:/trial/state', directories: ['D:\\TRIAL\\work\\task'] }
  let metadata = initial, conflict = false
  const writes: unknown[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('/orchestrator/api/workspace-folders')
    expect(init.headers).toMatchObject({ 'x-orchestrator-request': '1' })
    if (init.method === 'POST') {
      const request = JSON.parse(String(init.body)); writes.push(request)
      if (conflict) {
        conflict = false
        metadata = updateWorkspaceFolders(metadata, source, { action: 'create', name: 'Other window', revision: metadata?.revision ?? 0 })
        return Response.json({ error: 'Workspace folders changed. Reload before saving.' }, { status: 409 })
      }
      metadata = updateWorkspaceFolders(metadata, source, request)
    }
    return Response.json(workspaceFoldersView(metadata, source))
  })
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props = { t, useWorkspaces: (select: (value: unknown) => unknown) => select({ items }) } as unknown as WorkspaceFoldersProps
  await act(async () => { root.render(<WorkspaceFolders {...props} />) }); await settle()
  const dispose = () => { act(() => root.unmount()); container.remove() }
  disposers.push(dispose)
  return { ...host, state, worker, other, items, source, root, props, writes, fetch, conflict: () => { conflict = true },
    view: () => workspaceFoldersView(metadata, source), dispose }
}

it('adds the icon before native search, groups automatically, and preserves native rows and handlers', async () => {
  const view = await app()
  const handler = vi.fn(); view.worker.querySelector('button')!.addEventListener('click', handler)
  const search = view.sidebar.querySelector('.search')!
  expect(search.previousElementSibling?.getAttribute('data-superagent-folder-mount')).toBe('header')
  expect(label(zh.foldersCreate)).toBeTruthy()
  expect([...document.querySelectorAll('.dt-folder-name')].map(item => item.textContent)).toEqual(['owner/repo', zh.foldersUngrouped])
  expect(view.state.style.getPropertyValue('--dt-folder-order')).toBe('1')
  expect(view.worker.style.getPropertyValue('--dt-folder-order')).toBe('1')
  expect(view.other.style.getPropertyValue('--dt-folder-order')).toBe('5')
  expect(view.writes).toEqual([])
  await click(view.worker.querySelector('button')!)
  expect(handler).toHaveBeenCalledOnce()
  expect(view.worker.parentElement).toBe(view.tree)
})

it('persists collapse, exposes search matches, observes new native rows and cleans up on unmount', async () => {
  const view = await app(), row = view.worker.querySelector('button')!
  await click(document.querySelector<HTMLElement>('.dt-folder-toggle')!)
  expect(view.worker.classList.contains('dt-folder-hidden')).toBe(true)
  expect(JSON.parse(localStorage.getItem('dsh-superagent.workspace-folders.collapsed')!)).toEqual(['repository:owner/repo'])
  await input(view.search, 'Task'); await settle()
  expect(view.worker.classList.contains('dt-folder-hidden')).toBe(false)
  await input(view.search, ''); await settle()
  expect(view.worker.classList.contains('dt-folder-hidden')).toBe(true)
  const late = view.group('late'); await settle()
  expect(late.classList.contains('dt-folder-member')).toBe(true)
  expect(late.classList.contains('dt-folder-hidden')).toBe(false)
  await click(label(zh.foldersCreate))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.contains(document.activeElement) || document.activeElement === dialog).toBe(true)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  view.dispose(); disposers.pop()
  expect(document.querySelector('[data-superagent-folder-mount]')).toBeNull()
  expect(view.tree.classList.contains('dt-folder-tree')).toBe(false)
  expect(view.worker.className).toBe('')
  expect(view.worker.querySelector('button')).toBe(row)
  expect(view.worker.style.getPropertyValue('--dsh-workspace-indent')).toBe('0px')
  expect(view.worker.style.getPropertyValue('--dt-folder-order')).toBe('')
  // Remount reads the persisted UI preference without creating or replaying tasks.
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<WorkspaceFolders {...view.props} />) }); await settle()
  expect(view.worker.classList.contains('dt-folder-hidden')).toBe(true)
  expect(view.writes).toEqual([])
  disposers.push(() => { act(() => root.unmount()); container.remove() })
})

it('creates an empty category, assigns a workspace, renames it and deletes only its classification', async () => {
  const view = await app()
  await click(label(zh.foldersCreate))
  await input(label<HTMLInputElement>(zh.foldersName), 'My project')
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  const folder = view.view().folders.find(item => item.name === 'My project')!
  expect(folder).toBeTruthy()
  expect(document.querySelector(`[data-superagent-folder="${folder.id}"] .dt-folder-count`)?.textContent).toBe('0')
  const select = label<HTMLSelectElement>(t('foldersMove', { name: 'Task' }))
  await act(async () => { select.value = folder.id; select.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
  expect(view.view().assignments['d:/trial/work/task']).toBe(folder.id)
  expect(view.worker.style.getPropertyValue('--dt-folder-order')).not.toBe(view.state.style.getPropertyValue('--dt-folder-order'))
  const rename = label<HTMLInputElement>(t('foldersRename', { name: 'My project' }))
  await input(rename, 'Renamed')
  await click([...rename.parentElement!.querySelectorAll('button')].find(button => button.textContent === zh.foldersSave)!)
  expect(view.view().folders.find(item => item.id === folder.id)?.name).toBe('Renamed')
  await click([...rename.parentElement!.querySelectorAll('button')].find(button => button.textContent === zh.foldersDelete)!)
  expect(document.querySelector('.dt-folders-delete')?.textContent).toContain(zh.foldersDeleteHint)
  await click(document.querySelector<HTMLElement>('.dt-folders-delete button')!)
  expect(view.view().folders.some(item => item.id === folder.id)).toBe(false)
  expect(view.view().assignments['d:/trial/work/task']).toBeNull()
  expect(view.worker.parentElement).toBe(view.tree)
  expect(view.writes).toEqual([
    { action: 'create', name: 'My project', revision: 0 },
    { action: 'assign', path: 'D:/trial/work/task', folderId: folder.id, revision: 1 },
    { action: 'rename', id: folder.id, name: 'Renamed', revision: 2 },
    { action: 'delete', id: folder.id, revision: 3 },
  ])
})

it('shows revision conflicts without silently retrying the write', async () => {
  const view = await app(); view.conflict()
  await click(label(zh.foldersCreate))
  await input(label<HTMLInputElement>(zh.foldersName), 'My draft')
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.foldersConflict)
  expect(label<HTMLInputElement>(zh.foldersName).value).toBe('My draft')
  expect(view.view().folders.some(folder => folder.name === 'My draft')).toBe(false)
  expect(view.view().folders.some(folder => folder.name === 'Other window')).toBe(true)
  expect(view.writes).toHaveLength(1)
})

it('accepts only registered workspace drags and saves a logical assignment', async () => {
  const view = await app()
  const data = new Map<string, string>()
  const transfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '', types: [] }
  const dispatch = (target: Element, name: string) => {
    const event = new Event(name, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event)
  }
  const heading = document.querySelector('[data-superagent-folder="ungrouped"]')!
  await act(async () => { dispatch(view.worker.querySelector('[draggable]')!, 'dragstart'); dispatch(heading, 'drop') }); await settle()
  expect(view.view().assignments['d:/trial/work/task']).toBeNull()
  data.set('application/x-dsh-superagent-workspace', 'D:/unregistered')
  await act(async () => { dispatch(heading, 'drop') }); await settle()
  expect(view.writes).toHaveLength(1)
})

const orderedFolders = (): WorkspaceFolderMetadata => ({ revision: 0, suppressedAutomatic: [],
  folders: [{ id: 'folder-a', name: 'Alpha' }, { id: 'folder-b', name: 'Beta' }], assignments: { 'd:/trial/work/task': 'folder-a' } })
const heading = (id: string) => document.querySelector<HTMLElement>(`[data-superagent-folder="${id}"]`)!
function folderDrag() {
  const data = new Map<string, string>()
  const transfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '',
    get types() { return [...data.keys()] } }
  const fire = async (target: Element, name: string, clientY = 101) => {
    const event = new MouseEvent(name, { bubbles: true, cancelable: true, clientY })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    await act(async () => { target.dispatchEvent(event) }); await settle()
  }
  const over = (id: string) => {
    const element = heading(id)
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 40 } as DOMRect)
    return element
  }
  return { fire, over, data }
}

it('reorders whole folders above and below a target, preserving membership, collapse and native rows', async () => {
  const view = await app(orderedFolders()), automatic = 'repository:owner/repo'
  const original = view.view().assignments, row = view.worker.querySelector('button')!
  const drag = folderDrag(), title = (id: string) => heading(id).querySelector<HTMLElement>('.dt-folder-toggle')!
  await click(title('folder-a'))
  expect(view.worker.classList.contains('dt-folder-hidden')).toBe(true)
  await drag.fire(title(automatic), 'dragstart')
  await drag.fire(drag.over('folder-a'), 'dragover')
  expect(document.querySelector<HTMLElement>('.dt-folder-insertion')?.style.order).toBe('-1')
  expect(view.writes).toHaveLength(0)
  await drag.fire(heading('folder-a'), 'drop')
  expect(view.view().folders.map(folder => folder.id)).toEqual([automatic, 'folder-a', 'folder-b'])
  expect(view.writes).toEqual([{ action: 'reorder', id: automatic, beforeId: 'folder-a', revision: 0 }])
  expect(view.state.style.getPropertyValue('--dt-folder-order')).toBe('1')
  expect(view.worker.classList.contains('dt-folder-hidden')).toBe(true)
  expect(view.worker.querySelector('button')).toBe(row)
  expect(view.view().assignments).toEqual(original)
  expect(document.querySelector('.dt-folder-insertion')).toBeNull()
  // The after marker sorts below all target members and before the next heading.
  await drag.fire(title(automatic), 'dragstart')
  await drag.fire(drag.over('folder-b'), 'dragover', 139)
  expect(document.querySelector<HTMLElement>('.dt-folder-insertion')?.style.order).toBe('11')
  await drag.fire(heading('folder-b'), 'drop', 139)
  expect(view.view().folders.map(folder => folder.id)).toEqual(['folder-a', 'folder-b', automatic])
  expect(view.writes.at(-1)).toEqual({ action: 'reorder', id: automatic, beforeId: null, revision: 1 })
  // Ungrouped is a fixed footer, but accepts a folder just before it.
  expect(title('ungrouped').draggable).toBe(false)
  await drag.fire(title('folder-a'), 'dragstart')
  await drag.fire(drag.over('ungrouped'), 'dragover', 139)
  expect(heading('ungrouped').dataset.drop).toBe('before')
  await drag.fire(heading('ungrouped'), 'drop', 139)
  expect(view.view().folders.map(folder => folder.id)).toEqual(['folder-b', automatic, 'folder-a'])
  expect(view.view().assignments).toEqual(original)
  await act(async () => { view.root.render(<WorkspaceFolders key="restored" {...view.props} />) }); await settle()
  expect([...document.querySelectorAll('.dt-folder-name')].map(element => element.textContent)).toEqual(['Beta', 'owner/repo', 'Alpha', zh.foldersUngrouped])
  expect(view.worker.classList.contains('dt-folder-hidden')).toBe(true)
})

it('does not save cancelled, identical or unknown folder drags and refreshes a conflicting order', async () => {
  const view = await app(orderedFolders()), drag = folderDrag(), automatic = 'repository:owner/repo'
  const title = heading(automatic).querySelector<HTMLElement>('.dt-folder-toggle')!
  await drag.fire(title, 'dragstart')
  await drag.fire(drag.over('folder-a'), 'dragover')
  expect(document.querySelector('.dt-folder-insertion')).not.toBeNull()
  await drag.fire(title, 'dragend')
  expect(document.querySelector('.dt-folder-insertion')).toBeNull()
  expect(heading(automatic).dataset.dragging).toBeUndefined()
  await drag.fire(title, 'dragstart')
  await drag.fire(heading(automatic), 'drop')
  await drag.fire(title, 'dragstart')
  await drag.fire(drag.over('ungrouped'), 'drop')
  drag.data.set('application/x-dsh-superagent-folder', 'not-a-folder')
  await drag.fire(heading('folder-a'), 'drop')
  expect(view.writes).toHaveLength(0)
  view.conflict()
  await drag.fire(title, 'dragstart')
  await drag.fire(heading('folder-a'), 'drop')
  expect(view.writes).toEqual([{ action: 'reorder', id: automatic, beforeId: 'folder-a', revision: 0 }])
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.foldersConflict)
  expect(view.view().folders[0]!.id).toBe('folder-a')
  expect(view.view().folders.some(folder => folder.name === 'Other window')).toBe(true)
  expect(document.querySelector('.dt-folder-insertion')).toBeNull()
})

it('leaves flat and nested native views intact, and remounts when the host restores the supported view', async () => {
  const host = native(); let mounts: WorkspaceFolderMounts = { groups: [] }
  const stop = observeWorkspaceFolders(value => { mounts = value }); disposers.push(stop)
  const outer = host.group('parent'), inner = host.group('child'); outer.append(inner)
  await settle()
  expect(mounts.tree).toBeUndefined(); expect(mounts.groups).toEqual([])
  expect(mounts.header).toBeTruthy()
  host.tree.append(inner); await settle()
  expect(mounts.groups).toHaveLength(2)
  const clean = arrangeWorkspaceFolders(mounts, new Map([['parent', { order: 1, hidden: true }]])); clean()
  host.tree.replaceChildren(outer.querySelector('[data-row-key]')!); await settle()
  expect(mounts.tree).toBeUndefined()
  expect(host.tree.querySelector('[data-superagent-folder-mount]')).toBeNull()
  host.sidebar.remove(); await settle()
  expect(mounts.header).toBeUndefined()
})
