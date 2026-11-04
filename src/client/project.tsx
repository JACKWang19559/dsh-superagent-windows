/** Session-owned Superagent view: a read-only summary of this workspace's repository and exact branch. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ProjectReason, ProjectView } from '../on-demand/project-types.ts'
import { repositoryInput } from '../on-demand/repository.ts'
import type { LaunchHistoryEntry, LaunchHistoryPhase, LaunchPhase } from '../on-demand/types.ts'
import STYLES from './client.css?raw'
import { Button, Dot, Icon, type DotState } from './controls.tsx'
import { errorText, fullTime, type T } from './text.ts'

const phases: readonly string[] = ['idle', 'starting', 'running', 'needs-setup', 'stopping', 'error', 'stopped', 'interrupted']
const marks: Record<LaunchPhase | LaunchHistoryPhase, DotState> = { idle: 'idle', starting: 'ongoing', running: 'done',
  'needs-setup': 'warning', stopping: 'ongoing', error: 'error', stopped: 'idle', interrupted: 'warning' }
const reasons: readonly ProjectReason[] = ['session-not-found', 'workspace-missing', 'git-unavailable', 'not-git',
  'no-github-remote', 'ambiguous-remotes', 'detached-head', 'ambiguous-history', null]
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nullable = (value: unknown) => value === null || typeof value === 'string'
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
function validStage(value: unknown): boolean {
  if (!record(value)) return false
  if (value.stage === 'person') return ['delivery', 'answer', 'review', 'blocked', 'failed'].includes(String(value.action))
  if (value.stage === 'working') return value.action === undefined || value.action === 'queued'
  return (value.stage === 'idle' || value.stage === 'ended') && value.action === undefined
}
function isHistoryEntry(value: unknown): value is LaunchHistoryEntry {
  return record(value) && typeof value.id === 'string' && typeof value.repository === 'string' && nullable(value.branch)
    && nullable(value.consoleId) && nullable(value.masterId) && date(value.startedAt)
    && (value.endedAt === null || date(value.endedAt)) && nullable(value.error) && phases.includes(String(value.phase)) && value.phase !== 'idle'
}
/** Reject a mismatched session or malformed payload before rendering any other project's data. */
function isProject(value: unknown, sessionId: string): value is ProjectView {
  if (!record(value) || value.sessionId !== sessionId || !nullable(value.repository) || !nullable(value.branch)
    || !nullable(value.defaultBranch) || !nullable(value.error) || !nullable(value.summaryError)
    || !reasons.includes(value.reason as ProjectReason) || ![null, 'git', 'launch-history'].includes(value.source as never)) return false
  const workspace = value.workspace, status = value.status, history = value.history, summary = value.summary
  if (workspace !== null && (!record(workspace) || !nullable(workspace.id) || typeof workspace.title !== 'string' || typeof workspace.path !== 'string')) return false
  const belongs = (target: Record<string, unknown>) => typeof value.repository === 'string' && typeof target.repository === 'string'
    && target.repository.toLowerCase() === value.repository.toLowerCase()
    && (target.branch === value.branch || target.branch === null && value.branch !== null && value.defaultBranch === value.branch)
  if (status !== null && (!record(status) || !phases.slice(0, 6).includes(String(status.phase)) || !nullable(status.error)
    || !nullable(status.masterId) || (status.consoleId !== undefined && !nullable(status.consoleId)) || !belongs(status))) return false
  if (!record(history) || !Array.isArray(history.entries) || history.entries.length > 30
    || !history.entries.every(entry => isHistoryEntry(entry) && belongs(entry as unknown as Record<string, unknown>))
    || !count(history.limit) || !nullable(history.error)) return false
  if (summary !== null && (!record(summary) || !record(summary.counts)
    || !['total', 'open', 'person', 'working', 'idle', 'ended'].every(key => count((summary.counts as Record<string, unknown>)[key]))
    || !Array.isArray(summary.recentTickets) || summary.recentTickets.length > 12 || !summary.recentTickets.every(ticket => record(ticket)
      && typeof ticket.id === 'string' && typeof ticket.title === 'string' && date(ticket.updatedAt) && nullable(ticket.workerSessionId)
      && validStage(ticket.stage))
    || !nullable(summary.masterId) || (summary.maxWorkers !== null && !count(summary.maxWorkers))
    || (summary.paused !== null && typeof summary.paused !== 'boolean') || (summary.updatedAt !== null && !date(summary.updatedAt)))) return false
  return true
}
async function readProject(sessionId: string, t: T, signal: AbortSignal): Promise<ProjectView> {
  let response: Response
  try {
    response = await fetch(`/orchestrator/project?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'GET', headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
  } catch (error) { if (signal.aborted) throw error; throw new Error(t('project.offline')) }
  let value: unknown
  try { value = await response.json() } catch { value = undefined }
  if (response.status === 404) throw new Error(t('project.unavailable'))
  if (!response.ok) throw new Error(record(value) && typeof value.error === 'string' ? value.error : t('requestFailed', { status: response.status }))
  if (!isProject(value, sessionId)) throw new Error(t('project.invalid'))
  return value
}

/** Only the selected View polls; switching Session or View aborts its request and drops the old scope. */
function useProject(sessionId: string, t: T) {
  const copy = useRef(t); copy.current = t
  const [view, setView] = useState<{ data?: ProjectView; checking: boolean; error?: string }>({ checking: true })
  const control = useRef<() => Promise<void>>()
  useEffect(() => {
    let alive = true, request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
    setView({ checking: true })
    const refresh = async () => {
      if (!alive || request) return
      clearTimeout(timer)
      const controller = new AbortController(); request = controller
      setView(previous => ({ ...previous, checking: true }))
      try {
        const data = await readProject(sessionId, copy.current, controller.signal)
        if (alive) setView({ data, checking: false })
      } catch (error) {
        if (alive && !controller.signal.aborted) setView(previous => ({ ...previous, checking: false, error: errorText(error) }))
      } finally {
        if (request === controller) request = undefined
        if (alive) timer = setTimeout(() => { void refresh() }, document.hidden ? 60_000 : 10_000)
      }
    }
    control.current = refresh
    const shown = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', shown)
    void refresh()
    return () => { alive = false; clearTimeout(timer); request?.abort(); control.current = undefined; document.removeEventListener('visibilitychange', shown) }
  }, [sessionId])
  const refresh = useCallback(async () => { await control.current?.() }, [])
  return { ...view, data: view.data?.sessionId === sessionId ? view.data : undefined, refresh }
}

export interface ProjectPanelProps {
  sessionId: string
  t: T
  openSession: (id: string) => Promise<void>
  startSession: (workspaceId: string) => void
}
export function ProjectPanel({ sessionId, t, openSession, startSession }: ProjectPanelProps) {
  const { data, checking, error, refresh } = useProject(sessionId, t)
  const id = useId()
  const mounted = useRef(true), navigating = useRef(false)
  const [opening, setOpening] = useState(false), [navigationError, setNavigationError] = useState<string>()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const navigate = async (action: () => void | Promise<void>) => {
    if (navigating.current) return
    navigating.current = true; setOpening(true); setNavigationError(undefined)
    try { await action() }
    catch (failure) { if (mounted.current) setNavigationError(errorText(failure)) }
    finally { navigating.current = false; if (mounted.current) setOpening(false) }
  }
  const summary = data?.summary
  const phase = data?.status?.phase ?? data?.history.entries[0]?.phase ?? 'idle'
  const mainSession = summary?.masterId ?? data?.status?.masterId
  const consoleSession = data?.status?.consoleId
  const startup = data?.repository ? t('project.startCommand', { url: data.branch
    ? repositoryInput({ repository: data.repository, branch: data.branch }) : `https://github.com/${data.repository}` }) : undefined
  const stamp = (at: string) => <time dateTime={at}>{fullTime(at, t('lang')) || at}</time>
  return <div className="dt-page dt-project" aria-busy={checking}>
    <style>{STYLES}</style>
    <div className="dt-column">
      <header className="dt-history-head">
        <div className="dt-section"><h1 className="dt-block-title">{t('project.title')}</h1><p className="dt-hint">{t('project.subtitle')}</p></div>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={checking} onClick={() => { void refresh() }}>{t('launcher.refresh')}</Button>
      </header>
      {(error || navigationError) && <p className="dt-error" role="alert">{navigationError ?? error}</p>}
      {!data && !error && <p className="dt-hint" role="status">{t('project.loading')}</p>}
      {data && <>
        <section className="dt-card dt-project-identity" aria-labelledby={`${id}-workspace`}>
          <div className="dt-history-head"><h2 id={`${id}-workspace`} className="dt-block-title">{data.workspace?.title ?? t('project.noWorkspace')}</h2>
            {data.repository && !data.reason && <span className="dt-launch-state" role="status"><Dot state={marks[phase]} />{t(`launcher.phase.${phase}`)}</span>}
          </div>
          {data.workspace && <p className="dt-project-path">{data.workspace.path}</p>}
          <dl className="dt-project-facts">
            <dt>{t('project.repository')}</dt><dd>{data.repository ?? t('project.unresolved')}</dd>
            <dt>{t('project.branch')}</dt><dd>{data.branch ?? t(data.reason === 'detached-head' ? 'project.detached' : data.repository && !data.reason ? 'launcher.defaultBranch' : 'project.unresolved')}</dd>
          </dl>
          {data.reason && <p className="dt-hint" role="status">{t(`project.reason.${data.reason}`)}</p>}
          {data.error && <p className="dt-error" role="alert">{data.error}</p>}
          {data.status?.error && <p className="dt-error" role="alert">{data.status.error}</p>}
          <div className="dt-actions">
            {data.workspace?.id && <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} disabled={opening}
              onClick={() => { void navigate(() => startSession(data.workspace!.id!)) }}>{t('project.newSession')}</Button>}
            {consoleSession && <Button variant="outline" size="sm" disabled={opening} icon={<Icon name="message" size={14} />}
              onClick={() => { void navigate(() => openSession(consoleSession)) }}>{t('launcher.openConsole')}</Button>}
            {mainSession && <Button variant="outline" size="sm" disabled={opening} icon={<Icon name="session" size={14} />}
              onClick={() => { void navigate(() => openSession(mainSession)) }}>{t('openMaster')}</Button>}
          </div>
          <p className="dt-hint">{t('project.startHint')}</p>
          {startup && !data.reason && <code className="dt-project-command">{startup}</code>}
        </section>
        {summary && <section className="dt-card dt-project-summary" aria-labelledby={`${id}-summary`}>
          <div className="dt-history-head"><h2 id={`${id}-summary`} className="dt-block-title">{t('project.summary')}</h2>
            {summary.updatedAt && <span className="dt-project-caption">{t('project.updated')} {stamp(summary.updatedAt)}</span>}</div>
          <dl className="dt-project-metrics">{(['open', 'person', 'working', 'ended'] as const).map(key => <div key={key}>
            <dt>{t(`project.count.${key}`)}</dt><dd>{summary.counts[key]}</dd>
          </div>)}</dl>
          <p className="dt-hint">{t('project.savedHint')}</p>
          <div className="dt-row-meta">{summary.maxWorkers !== null && <span>{t('project.maxWorkers', { count: summary.maxWorkers })}</span>}
            {summary.paused && <span>{t('project.paused')}</span>}</div>
        </section>}
        {data.summaryError && <p className="dt-error" role="alert">{t('project.summaryFailed')} {data.summaryError}</p>}
        {!summary && data.repository && !data.reason && !data.summaryError && <p className="dt-hint">{t('project.noSummary')}</p>}
        {summary && <section className="dt-card" aria-labelledby={`${id}-tickets`}>
          <h2 id={`${id}-tickets`} className="dt-block-title">{t('project.tickets')}</h2>
          {!summary.recentTickets.length && <p className="dt-hint">{t('project.noTickets')}</p>}
          <ul className="dt-history-list">{summary.recentTickets.map(ticket => <li key={ticket.id} className="dt-history-row">
            <div className="dt-history-heading"><h3>{ticket.title}</h3><span className="dt-project-caption">{ticket.stage.stage === 'ended' ? t('ticket.ended')
              : ticket.stage.stage === 'person' ? t(`stage.${ticket.stage.action}`)
                : ticket.stage.stage === 'working' ? t(ticket.stage.action === 'queued' ? 'stage.queued' : 'stage.working') : t('stage.idle')}</span></div>
            <div className="dt-row-meta"><span>{ticket.id}</span>{stamp(ticket.updatedAt)}</div>
            {ticket.workerSessionId && <div className="dt-actions"><Button variant="outline" size="sm" disabled={opening}
              icon={<Icon name="session" size={14} />} onClick={() => { void navigate(() => openSession(ticket.workerSessionId!)) }}>{t('project.openWorker')}</Button></div>}
          </li>)}</ul>
        </section>}
        <section className="dt-card" aria-labelledby={`${id}-history`}>
          <h2 id={`${id}-history`} className="dt-block-title">{t('project.history')}</h2>
          <p className="dt-hint">{t('project.historyHint')}</p>
          {data.history.error && <p className="dt-error" role="alert">{data.history.error}</p>}
          {!data.history.entries.length && <p className="dt-hint">{t('project.noHistory')}</p>}
          <ol className="dt-history-list">{data.history.entries.map(entry => <li key={entry.id} className="dt-history-row">
            <div className="dt-history-heading"><h3>{entry.repository}</h3><span className="dt-launch-state"><Dot state={marks[entry.phase]} />{t(`launcher.phase.${entry.phase}`)}</span></div>
            <p className="dt-hint">{t('launcher.selectedBranch', { branch: entry.branch ?? t('launcher.defaultBranch') })}</p>
            <div className="dt-row-meta"><span>{t('launcher.historyStarted')} {stamp(entry.startedAt)}</span>
              {entry.endedAt && <span>{t('launcher.historyEnded')} {stamp(entry.endedAt)}</span>}</div>
            {entry.error && <p className="dt-error">{entry.error}</p>}
            <div className="dt-actions">{entry.consoleId && <Button variant="outline" size="sm" disabled={opening} onClick={() => { void navigate(() => openSession(entry.consoleId!)) }}>{t('launcher.openConsole')}</Button>}
              {entry.masterId && <Button variant="outline" size="sm" disabled={opening} onClick={() => { void navigate(() => openSession(entry.masterId!)) }}>{t('openMaster')}</Button>}</div>
          </li>)}</ol>
        </section>
      </>}
    </div>
  </div>
}
