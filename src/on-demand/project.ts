/** Session-scoped read-only overview, independently available while the launcher is idle. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { basename, isAbsolute, join } from 'node:path'
import { json, sameOrigin } from '../app/http.ts'
import { repositoryDirectory } from './host.ts'
import { ProjectGit, abortable } from './project-git.ts'
import { ProjectSessionId, readProjectDatabase, type ProjectSnapshot } from './project-db.ts'
import { sameRepositoryTarget, type RepositoryTarget } from './repository.ts'
import type { LaunchControl, LaunchHistoryEntry, LaunchStatus } from './types.ts'
import type { ProjectView } from './project-types.ts'

export type { ProjectView, ProjectSummary, ProjectTicket, ProjectWorkspace, ProjectReason } from './project-types.ts'
export interface ProjectControl extends Pick<LaunchControl, 'status' | 'history'> {
  summary?(target: RepositoryTarget): ProjectSnapshot | undefined
}
const relatedSession = (entry: Pick<LaunchHistoryEntry, 'consoleId' | 'masterId'>, id: string): boolean => entry.consoleId === id || entry.masterId === id

/** Reads only registry projections, immutable session headers, local Git and existing SQLite snapshots. */
export class ProjectReader {
  private readonly lifetime = new AbortController()
  private readonly git: ProjectGit
  constructor(private readonly ctx: Context, private readonly control: ProjectControl, private readonly stateDir: string) {
    this.git = new ProjectGit(ctx.subprocess)
  }
  async dispose(): Promise<void> { this.lifetime.abort(); await this.git.dispose() }

  async read(sessionId: string, cancellation: AbortSignal = new AbortController().signal): Promise<ProjectView> {
    ProjectSessionId.parse(sessionId)
    const signal = AbortSignal.any([cancellation, this.lifetime.signal, AbortSignal.timeout(10000)])
    signal.throwIfAborted()
    const view: ProjectView = { sessionId, workspace: null, repository: null, branch: null, defaultBranch: null, source: null,
      reason: null, status: null, history: { entries: [], limit: 30, error: null }, summary: null, summaryError: null, error: null }
    const stats = new Map<string, ReturnType<Context['sessionPersistence']['stat']>>()
    const stat = (id: string): ReturnType<Context['sessionPersistence']['stat']> => {
      if (!ProjectSessionId.safeParse(id).success) return Promise.resolve(undefined)
      let result = stats.get(id)
      if (!result) {
        result = abortable(this.ctx.sessionPersistence.stat(id as SessionId, { signal }), signal)
        stats.set(id, result)
      }
      return result
    }
    try {
      const workspaces = this.ctx.workspaceRegistry.list().filter(workspace => workspace.sessionIds.includes(sessionId as SessionId))
      if (workspaces.length > 1) { view.reason = 'workspace-missing'; view.error = 'Session workspace ownership is ambiguous.'; return view }
      const workspace = workspaces[0]
      if (workspace) view.workspace = { id: workspace.id, title: workspace.title, path: workspace.path, source: 'registry' }
      else {
        const stored = await stat(sessionId)
        if (!stored || stored.header.id !== sessionId) { view.reason = 'session-not-found'; return view }
        if (stored.header.cwd && isAbsolute(stored.header.cwd)) {
          view.workspace = { id: null, title: basename(stored.header.cwd) || stored.header.cwd, path: stored.header.cwd, source: 'session-header' }
        }
      }
    } catch {
      signal.throwIfAborted()
      view.reason = 'workspace-missing'; view.error = 'Session workspace information could not be read.'; return view
    }
    let current: LaunchStatus | null = null
    let history: LaunchHistoryEntry[] = []
    try { current = this.control.status() } catch { view.error = 'Launch status could not be read.' }
    try {
      const saved = this.control.history()
      history = saved.entries.slice(0, 30)
      view.history = { entries: [], limit: saved.limit, error: saved.error }
    } catch { view.history.error = 'Retained launch history could not be read.' }
    if (view.workspace) {
      const identity = await this.git.read(view.workspace.path, signal)
      Object.assign(view, identity, { error: identity.error ?? view.error })
      if (identity.repository) view.source = 'git'
    } else view.reason = 'workspace-missing'
    // A recorded console/master is evidence only where there is no contradictory or ambiguous Git project.
    if (!view.repository && (view.reason === 'not-git' || view.reason === 'workspace-missing')) {
      const candidates: RepositoryTarget[] = history.filter(entry => relatedSession(entry, sessionId))
      if (current?.repository && current.phase !== 'idle' && (current.consoleId === sessionId || current.masterId === sessionId)) {
        candidates.unshift({ repository: current.repository, branch: current.branch })
      }
      const targets = candidates.filter((entry, index) => candidates.findIndex(other => sameRepositoryTarget(entry, other)) === index)
      if (targets.length === 1) Object.assign(view, targets[0], { source: 'launch-history', reason: null })
      else if (targets.length > 1) view.reason = 'ambiguous-history'
    }
    if (!view.repository || view.reason) return view
    const target = { repository: view.repository, branch: view.branch }
    const matches = (other: RepositoryTarget): boolean => target.repository.toLowerCase() === other.repository.toLowerCase()
      && (target.branch === other.branch || other.branch === null && target.branch !== null && target.branch === view.defaultBranch)
    view.history.entries = history.filter(matches)
    if (current?.repository && current.phase !== 'idle' && matches({ repository: current.repository, branch: current.branch })) {
      view.status = { ...current, lastRepository: current.repository, lastBranch: current.branch }
    }
    const candidates: RepositoryTarget[] = [
      ...view.status?.repository ? [{ repository: view.status.repository, branch: view.status.branch }] : [],
      ...view.history.entries.map(entry => ({ repository: entry.repository, branch: entry.branch })), target,
      ...target.branch !== null && target.branch === view.defaultBranch ? [{ repository: target.repository, branch: null }] : [],
    ]
    const unique = candidates.filter((entry, index) => candidates.findIndex(other => sameRepositoryTarget(entry, other)) === index)
    for (const candidate of unique) {
      signal.throwIfAborted()
      let result: ProjectSnapshot
      try {
        result = this.control.summary?.(candidate)
          ?? readProjectDatabase(join(repositoryDirectory(this.stateDir, candidate.repository, candidate.branch), 'orchestrator.sqlite'), candidate)
      } catch { result = { summary: null, error: 'Saved project data could not be read from the active run.' } }
      view.summary = result.summary; view.summaryError = result.error
      if (result.summary || result.error) break
    }
    const exists = async (id: string | null): Promise<string | null> => {
      if (!id) return null
      try { return (await stat(id))?.header.id === id ? id : null }
      catch { signal.throwIfAborted(); view.summaryError ??= 'Some saved session links could not be verified.'; return null }
    }
    const summary = view.summary, status = view.status
    await Promise.all([
      ...summary ? [exists(summary.masterId).then(id => { summary.masterId = id }),
        ...summary.recentTickets.map(ticket => exists(ticket.workerSessionId).then(id => { ticket.workerSessionId = id }))] : [],
      ...status ? [exists(status.masterId).then(id => { status.masterId = id })] : [],
    ])
    signal.throwIfAborted()
    return view
  }
}

/** Registers one GET-only route with bounded concurrency and request/disposal cancellation. */
export function registerProjectHttp(ctx: Context, control: ProjectControl, stateDir: string): () => Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1' && ctx.webServer.host !== 'localhost') throw new Error('Project overview requires a loopback web server')
  const reader = new ProjectReader(ctx, control, stateDir)
  let active = 0
  let unregister: () => void
  try {
    unregister = ctx.webServer.register({ kind: 'exact', path: '/orchestrator/project', handler: async (req, res) => {
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      if (req.method !== 'GET') { json(res, 405, { error: 'Project overview is read-only' }); return }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.webServer.port}`)
      const ids = url.searchParams.getAll('sessionId')
      const id = ProjectSessionId.safeParse(ids[0])
      if ((req.url?.length ?? 0) > 2048 || ids.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'sessionId') || !id.success) {
        json(res, 400, { error: 'Exactly one valid sessionId is required' }); return
      }
      if (active >= 16) { json(res, 429, { sessionId: id.data, error: 'Too many project overview requests; retry shortly.' }); return }
      active++
      const cancellation = new AbortController()
      const aborted = (): void => { cancellation.abort() }
      const closed = (): void => { if (!res.writableEnded) aborted() }
      req.once('aborted', aborted); res.once('close', closed)
      try { json(res, 200, await reader.read(id.data, cancellation.signal)) }
      catch {
        if (!res.destroyed) json(res, cancellation.signal.aborted ? 499 : 503, { sessionId: id.data, error: 'Project overview is temporarily unavailable.' })
      } finally { active--; req.off('aborted', aborted); res.off('close', closed) }
    } })
  } catch (error) { void reader.dispose(); throw error }
  return async () => { unregister(); await reader.dispose() }
}
