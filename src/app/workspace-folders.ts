/** Logical workspace categories only: pure projections and edits, with no filesystem or runtime operations. */
import { z } from 'zod'
import { normalizeWorkspacePath } from '../workspace-path.ts'

export interface WorkspaceFolder { id: string; name: string; automatic?: boolean }
export interface WorkspaceFoldersView {
  revision: number
  folders: WorkspaceFolder[]
  /** Canonical workspace paths; an explicit null preserves a person's choice to leave a workspace ungrouped. */
  assignments: Record<string, string | null>
}
export type WorkspaceFolderAction = { revision: number } & (
  | { action: 'create'; name: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  | { action: 'assign'; path: string; folderId: string | null }
  | { action: 'reorder'; id: string; beforeId: string | null }
)
/** Only explicit choices are stored; automatically discovered workspaces are projected on every read. */
export interface WorkspaceFolderMetadata extends WorkspaceFoldersView { suppressedAutomatic: string[] }
export interface WorkspaceFolderSource { repository?: string; stateDir: string; directories: readonly string[] }

/** An edit raced with another panel's save. HTTP maps this to 409, like settings and prompt conflicts. */
export class WorkspaceFoldersConflict extends Error {}
/** An edit refers to a category that no longer exists. */
export class WorkspaceFolderError extends Error { readonly status = 404 }

const empty = (): WorkspaceFolderMetadata => ({ revision: 0, folders: [], assignments: {}, suppressedAutomatic: [] })
const name = z.string().max(80).regex(/^[^\u0000-\u001f\u007f]*$/, 'Folder names cannot contain control characters').trim().min(1)
const id = z.string().min(1).max(512)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name, revision }),
  z.object({ action: z.literal('rename'), id, name, revision }),
  z.object({ action: z.literal('delete'), id, revision }),
  z.object({ action: z.literal('reorder'), id, beforeId: id.nullable(), revision }),
  z.object({ action: z.literal('assign'), path: z.string().min(1).max(4096)
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'Workspace paths cannot contain control characters')
    .refine(value => !!value.trim(), 'Workspace path is required'), folderId: id.nullable(), revision }),
])

/** Derive the configured repository's group, including execution directories of ended tickets, without saving anything. */
export function workspaceFoldersView(metadata: WorkspaceFolderMetadata | undefined, source: WorkspaceFolderSource): WorkspaceFoldersView {
  const state = metadata ?? empty()
  const folders = state.folders.map(folder => ({ ...folder }))
  const repository = source.repository?.trim()
  const automaticId = repository ? `repository:${repository.toLowerCase()}` : undefined
  let automaticAssignments: Record<string, string> = {}
  if (automaticId && !state.suppressedAutomatic.includes(automaticId)) {
    if (!folders.some(folder => folder.id === automaticId)) folders.push({ id: automaticId, name: repository!, automatic: true })
    automaticAssignments = Object.fromEntries([source.stateDir, ...source.directories].filter(Boolean)
      .map(path => [normalizeWorkspacePath(path), automaticId]))
  }
  return { revision: state.revision, folders, assignments: { ...automaticAssignments, ...state.assignments } }
}

/** Validate a complete edit before returning new metadata; the caller commits it atomically with the revision check. */
export function updateWorkspaceFolders(metadata: WorkspaceFolderMetadata | undefined, source: WorkspaceFolderSource, value: unknown): WorkspaceFolderMetadata {
  const request = Action.parse(value)
  const current = metadata ?? empty()
  if (request.revision !== current.revision) throw new WorkspaceFoldersConflict('Workspace folders changed. Reload before saving.')
  const view = workspaceFoldersView(current, source)
  const lookup = (id: string) => {
    const folder = view.folders.find(folder => folder.id === id)
    if (!folder) throw new WorkspaceFolderError('Workspace folder not found')
    return folder
  }
  const next: WorkspaceFolderMetadata = { revision: current.revision + 1, folders: current.folders.map(folder => ({ ...folder })),
    assignments: { ...current.assignments }, suppressedAutomatic: [...current.suppressedAutomatic] }
  switch (request.action) {
    case 'create':
      next.folders.push({ id: `folder-${next.revision}`, name: request.name })
      break
    case 'rename': {
      const folder = lookup(request.id)
      const stored = next.folders.find(item => item.id === folder.id)
      if (stored) stored.name = request.name
      else next.folders.push({ ...folder, name: request.name })
      break
    }
    case 'delete': {
      const folder = lookup(request.id)
      next.folders = next.folders.filter(item => item.id !== folder.id)
      if (folder.automatic) next.suppressedAutomatic.push(folder.id)
      // Preserve ungrouping even if one of these paths also belongs to the automatically discovered repository group.
      next.assignments = { ...next.assignments, ...Object.fromEntries(Object.entries(view.assignments)
        .filter(([, id]) => id === folder.id).map(([path]) => [path, null])) }
      break
    }
    case 'reorder': {
      const folder = lookup(request.id)
      if (request.beforeId !== null) lookup(request.beforeId)
      // Save the displayed order, including the derived repository folder, without changing membership.
      const ordered = view.folders.filter(item => item.id !== folder.id)
      const at = request.beforeId === folder.id ? view.folders.findIndex(item => item.id === folder.id)
        : request.beforeId === null ? ordered.length : ordered.findIndex(item => item.id === request.beforeId)
      ordered.splice(at, 0, folder)
      next.folders = ordered
      break
    }
    case 'assign':
      if (request.folderId !== null) lookup(request.folderId)
      next.assignments = { ...next.assignments, [normalizeWorkspacePath(request.path)]: request.folderId }
      break
  }
  return next
}
