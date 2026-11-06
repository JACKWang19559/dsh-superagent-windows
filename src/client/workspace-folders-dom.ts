/** Desktop adapter for the workspace header, which currently has no additive header slot.
 * Keep native React rows in their original parents; portals and scoped layout attributes are reversible.
 * Unknown/flat/nested layouts retain the native view rather than guessing at its structure.
 */
export interface WorkspaceGroupMount { workspaceId: string; element: HTMLElement }
export interface WorkspaceFolderMounts {
  header?: HTMLElement
  tree?: HTMLElement
  folders?: HTMLElement
  searching?: boolean
  groups: WorkspaceGroupMount[]
}
const ROOT = '[data-slot="sidebar.workspaces"]'
const ROW = '[data-row-key^="workspace:"]'
const MARK = 'data-superagent-folder-mount'
const same = (a: WorkspaceFolderMounts, b: WorkspaceFolderMounts) => a.header === b.header && a.tree === b.tree &&
  a.folders === b.folders && a.searching === b.searching && a.groups.length === b.groups.length && a.groups.every((group, i) =>
    group.workspaceId === b.groups[i]?.workspaceId && group.element === b.groups[i]?.element)

export function observeWorkspaceFolders(changed: (mounts: WorkspaceFolderMounts) => void): () => void {
  const owned = new Set<HTMLElement>()
  let current: WorkspaceFolderMounts = { groups: [] }, frame: number | undefined, disposed = false
  const mount = (parent: HTMLElement, kind: string, before?: Element | null) => {
    const old = [...parent.children].find(child => child.getAttribute(MARK) === kind)
    if (old instanceof HTMLElement && owned.has(old)) return old
    const element = document.createElement('div')
    element.setAttribute(MARK, kind)
    element.className = kind === 'header' ? 'dt-folder-create-mount' : 'dt-folder-headings'
    parent.insertBefore(element, before ?? null)
    owned.add(element)
    return element
  }
  const scan = () => {
    frame = undefined
    if (disposed) return
    const root = document.querySelector<HTMLElement>(ROOT)
    const header = root?.querySelector('[data-slot="sidebar.workspaces.directoryFlow"]')?.parentElement
    const next: WorkspaceFolderMounts = { groups: [], searching: !!header?.querySelector('input')?.value.trim() }
    if (header && root?.contains(header)) {
      let search: Element | null = header.querySelector('input')
      while (search?.parentElement && search.parentElement !== header) search = search.parentElement
      next.header = mount(header, 'header', search)
    }
    const tree = root?.querySelector<HTMLElement>('[role="tree"]')
    if (tree) {
      let compatible = true
      for (const element of [...tree.children]) {
        if (!(element instanceof HTMLElement) || element.hasAttribute(MARK)) continue
        const rows = element.querySelectorAll<HTMLElement>(ROW)
        if (rows.length > 1 || element.matches(ROW)) { compatible = false; break }
        const key = rows[0]?.dataset.rowKey
        if (key) next.groups.push({ workspaceId: key.slice('workspace:'.length), element })
      }
      if (compatible && next.groups.length) {
        next.tree = tree
        next.folders = mount(tree, 'folders')
      } else next.groups = []
    }
    for (const element of owned) {
      if (element !== next.header && element !== next.folders) { element.remove(); owned.delete(element) }
    }
    if (!same(current, next)) { current = next; changed(next) }
  }
  const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(scan) }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key', 'value'] })
  document.addEventListener('input', schedule, true)
  document.addEventListener('change', schedule, true)
  scan()
  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener('input', schedule, true)
    document.removeEventListener('change', schedule, true)
    if (frame !== undefined) cancelAnimationFrame(frame)
    owned.forEach(element => element.remove())
  }
}

/** Only our attributes/styles are written; removing the extension restores the original workspace layout. */
export function arrangeWorkspaceFolders(mounts: WorkspaceFolderMounts, membership: ReadonlyMap<string, { order: number; hidden: boolean }>): () => void {
  mounts.tree?.classList.add('dt-folder-tree')
  const touched: HTMLElement[] = []
  for (const group of mounts.groups) {
    const layout = membership.get(group.workspaceId)
    if (!layout) continue
    const element = group.element
    element.classList.add('dt-folder-member')
    element.classList.toggle('dt-folder-hidden', layout.hidden)
    element.style.setProperty('--dt-folder-order', String(layout.order))
    touched.push(element)
  }
  return () => {
    mounts.tree?.classList.remove('dt-folder-tree')
    touched.forEach(element => {
      element.classList.remove('dt-folder-member', 'dt-folder-hidden')
      element.style.removeProperty('--dt-folder-order')
    })
  }
}
