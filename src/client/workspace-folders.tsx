/** Logical project folders over native workspace rows; category edits never move project files. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFolderAction, WorkspaceFoldersView } from '../app/api.ts'
import { normalizeWorkspacePath } from '../workspace-path.ts'
import { ApiError, caller, usePoll } from './api.ts'
import { Button, Icon, Modal } from './controls.tsx'
import { errorText, type T } from './text.ts'
import { arrangeWorkspaceFolders, observeWorkspaceFolders, type WorkspaceFolderMounts } from './workspace-folders-dom.ts'
import BASE_STYLES from './client.css?raw'
import STYLES from './workspace-folders.css?raw'

interface Workspace { workspaceId: string; path: string; title: string }
type WithoutRevision<T> = T extends unknown ? Omit<T, 'revision'> : never
type FolderEdit = WithoutRevision<WorkspaceFolderAction>
const COLLAPSED_KEY = 'dsh-superagent.workspace-folders.collapsed'
const DRAG_TYPE = 'application/x-dsh-superagent-workspace'
function loadCollapsed(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch { return new Set() }
}
function FolderIcon({ plus = false }: { plus?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
    <path d="M2.5 6V4.5h5l2 2h8V16h-15V6Z" strokeLinejoin="round" />
    {plus && <path d="M10 9v5m-2.5-2.5h5" strokeLinecap="round" />}
  </svg>
}
export type WorkspaceFoldersProps = PropsRuntime<'shell.overlay'> & { t: T }
export function WorkspaceFolders({ useWorkspaces, t }: WorkspaceFoldersProps) {
  const workspaces: readonly Workspace[] = useWorkspaces((snapshot: { items: readonly Workspace[] }) => snapshot.items)
  const copy = useRef(t); copy.current = t
  const call = useMemo(() => caller(() => ({ offline: copy.current('offline'), notRunning: copy.current('hostNotRunning'),
    serverError: status => copy.current('serverError', { status }), requestFailed: status => copy.current('requestFailed', { status }),
    setup: () => copy.current('foldersUnavailable'), user: failure => copy.current(`userError.${failure.code}`, failure.values) })), [])
  const { data, error, reload } = usePoll(() => call('GET workspace-folders'), [call])
  const [saved, setSaved] = useState<WorkspaceFoldersView>()
  const view = data && (!saved || data.revision >= saved.revision) ? data : saved
  const [mounts, setMounts] = useState<WorkspaceFolderMounts>({ groups: [] })
  const [open, setOpen] = useState(false), [name, setName] = useState('')
  const [names, setNames] = useState<Record<string, string>>({}), [deleting, setDeleting] = useState<string>()
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>()
  const writing = useRef(false), dragging = useRef<string>()
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  useEffect(() => observeWorkspaceFolders(setMounts), [])
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => {
      dragging.current = undefined
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-row-key^="workspace:"]') : null
      const workspace = workspaces.find(item => item.workspaceId === row?.dataset.rowKey?.slice('workspace:'.length))
      if (workspace) { dragging.current = workspace.path; event.dataTransfer?.setData(DRAG_TYPE, workspace.path) }
    }
    const end = () => { dragging.current = undefined }
    document.addEventListener('dragstart', start, true); document.addEventListener('dragend', end, true)
    return () => { document.removeEventListener('dragstart', start, true); document.removeEventListener('dragend', end, true) }
  }, [workspaces])
  const sections = useMemo(() => {
    if (!view) return []
    const folders = [...view.folders.map(folder => ({ ...folder, members: [] as string[] })),
      { id: '', name: t('foldersUngrouped'), members: [] as string[] }]
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    for (const group of mounts.groups) {
      const workspace = workspaces.find(item => item.workspaceId === group.workspaceId)
      const assigned = workspace ? view.assignments[normalizeWorkspacePath(workspace.path)] : null
      const folder = byId.get(assigned ?? '') ?? byId.get('')!
      folder.members.push(group.workspaceId)
    }
    return folders.filter(folder => folder.id || folder.members.length)
  }, [view, mounts.groups, workspaces, t])
  useLayoutEffect(() => {
    if (!view || !mounts.tree) return
    const membership = new Map<string, { order: number; hidden: boolean }>()
    sections.forEach((folder, index) => folder.members.forEach(id => membership.set(id, { order: index * 2 + 1,
      hidden: !mounts.searching && collapsed.has(folder.id) })))
    return arrangeWorkspaceFolders(mounts, membership)
  }, [view, mounts, sections, collapsed])
  const mutate = async (action: FolderEdit): Promise<boolean> => {
    if (!view || writing.current) return false
    writing.current = true; setBusy(true); setFailure(undefined)
    try {
      const next = await call('POST workspace-folders', { body: { ...action, revision: view.revision } })
      setSaved(next); await reload(); return true
    } catch (problem) {
      setFailure(problem instanceof ApiError && problem.status === 409 ? t('foldersConflict')
        : problem instanceof ApiError && problem.missing ? t('foldersMissing')
        : problem instanceof ApiError && problem.status === 400 && (action.action === 'create' || action.action === 'rename')
          ? t('foldersInvalid') : errorText(problem))
      setOpen(true); await reload(); return false
    } finally { writing.current = false; setBusy(false) }
  }
  const toggle = (id: string) => {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id); else next.add(id)
    setCollapsed(next)
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])) } catch { setFailure(t('foldersSaveViewFailed')) }
  }
  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() && await mutate({ action: 'create', name: name.trim() })) setName('')
  }
  const drop = (event: DragEvent, folderId: string) => {
    const path = event.dataTransfer.getData(DRAG_TYPE) || dragging.current
    if (!path || !workspaces.some(item => item.path === path)) return
    event.preventDefault(); event.stopPropagation(); dragging.current = undefined
    void mutate({ action: 'assign', path, folderId: folderId || null })
  }
  return <>
    <style>{BASE_STYLES}{STYLES}</style>
    {mounts.header && createPortal(<button className="dt-folder-icon" type="button" aria-label={t('foldersCreate')}
      title={t('foldersCreate')} onClick={() => setOpen(true)}><FolderIcon plus /></button>, mounts.header)}
    {mounts.folders && view && createPortal(sections.map((folder, index) => <div className="dt-folder-heading"
      data-superagent-folder={folder.id || 'ungrouped'} key={folder.id} style={{ order: index * 2 }}
      onDragOver={event => { if (dragging.current || event.dataTransfer.types.includes(DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
      onDrop={event => drop(event, folder.id)}>
      <button className="dt-folder-toggle" type="button" aria-expanded={mounts.searching || !collapsed.has(folder.id)} title={folder.name}
        disabled={mounts.searching} onClick={() => toggle(folder.id)}>
        <span className={!mounts.searching && collapsed.has(folder.id) ? 'dt-folder-chevron dt-folder-closed' : 'dt-folder-chevron'}><Icon name="chevron-down" size={12} /></span>
        <FolderIcon /><span className="dt-folder-name">{folder.name}</span><span className="dt-folder-count">{folder.members.length}</span>
      </button>
      <button className="dt-folder-icon" type="button" aria-label={t('foldersManage')} title={t('foldersManage')} onClick={() => setOpen(true)}><Icon name="settings" size={13} /></button>
    </div>), mounts.folders)}
    <Modal open={open} onClose={() => { if (!busy) setOpen(false) }} title={t('foldersTitle')} closeLabel={t('close')}
      description={t('foldersHint')} className="dt-folders-modal">
      {(failure || error) && <p className="dt-error" role="alert">{failure ?? errorText(error)}</p>}
      {!view && !error && <p className="dt-hint">{t('loading')}</p>}
      <form className="dt-folders-create" onSubmit={event => { void create(event) }}>
        <input aria-label={t('foldersName')} placeholder={t('foldersName')} maxLength={80} value={name} disabled={busy || !view}
          onChange={event => setName(event.target.value)} />
        <Button type="submit" variant="primary" disabled={busy || !view || !name.trim()}>{t('foldersCreate')}</Button>
      </form>
      <div className="dt-folders-management">
        {view?.folders.map(folder => <div className="dt-folders-edit" key={folder.id}>
          <FolderIcon />
          <input aria-label={t('foldersRename', { name: folder.name })} maxLength={80} value={names[folder.id] ?? folder.name} disabled={busy}
            onChange={event => setNames(previous => ({ ...previous, [folder.id]: event.target.value }))} />
          <Button size="sm" disabled={busy || !names[folder.id]?.trim() || names[folder.id] === folder.name}
            onClick={() => { void mutate({ action: 'rename', id: folder.id, name: names[folder.id]!.trim() }) }}>{t('foldersSave')}</Button>
          <Button size="sm" disabled={busy} onClick={() => setDeleting(deleting === folder.id ? undefined : folder.id)}>{t('foldersDelete')}</Button>
          {deleting === folder.id && <div className="dt-folders-delete">
            <span>{t('foldersDeleteHint')}</span><Button size="sm" disabled={busy} onClick={() => {
              void mutate({ action: 'delete', id: folder.id }).then(ok => { if (ok) setDeleting(undefined) })
            }}>{t('confirm')}</Button>
          </div>}
        </div>)}
      </div>
      <h3 className="dt-block-title">{t('foldersAssignments')}</h3>
      <p className="dt-hint">{t('foldersAutoHint')}</p>
      <div className="dt-folders-workspaces">{workspaces.map(workspace => <label className="dt-folders-workspace" key={workspace.workspaceId}>
        <span><strong>{workspace.title || workspace.path}</strong><small title={workspace.path}>{workspace.path}</small></span>
        <select aria-label={t('foldersMove', { name: workspace.title || workspace.path })} className="dt-select" disabled={busy || !view}
          value={view?.assignments[normalizeWorkspacePath(workspace.path)] ?? ''}
          onChange={event => { void mutate({ action: 'assign', path: workspace.path, folderId: event.target.value || null }) }}>
          <option value="">{t('foldersUngrouped')}</option>
          {view?.folders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
        </select>
      </label>)}</div>
      {!mounts.tree && <p className="dt-hint">{t('foldersViewHint')}</p>}
    </Modal>
  </>
}
