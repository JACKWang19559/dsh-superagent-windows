/** Read-only launch history, independent of the current runtime and its management requests. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { LaunchHistory, LaunchHistoryEntry, LaunchHistoryPhase } from '../on-demand/types.ts'
import { Button, Dot, Icon, type DotState } from './controls.tsx'
import { errorText, fullTime, type T } from './text.ts'

const phases: readonly LaunchHistoryPhase[] = ['starting', 'running', 'needs-setup', 'stopping', 'error', 'stopped', 'interrupted']
const marks: Record<LaunchHistoryPhase, DotState> = { starting: 'ongoing', running: 'done', 'needs-setup': 'warning',
  stopping: 'ongoing', error: 'error', stopped: 'idle', interrupted: 'warning' }
const nullableString = (value: unknown) => value === null || typeof value === 'string'
const validDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
function isEntry(value: unknown): value is LaunchHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<LaunchHistoryEntry>
  return typeof entry.id === 'string' && typeof entry.repository === 'string' && validDate(entry.startedAt)
    && nullableString(entry.branch) && nullableString(entry.consoleId) && nullableString(entry.masterId)
    && (entry.endedAt === null || validDate(entry.endedAt)) && nullableString(entry.error) && phases.includes(entry.phase as LaunchHistoryPhase)
}
async function readHistory(t: T, signal: AbortSignal): Promise<LaunchHistory> {
  let response: Response
  try { response = await fetch('/orchestrator/history', { method: 'GET', signal, headers: { 'x-orchestrator-request': '1' } }) }
  catch (error) { if (signal.aborted) throw error; throw new Error(t('launcher.historyOffline')) }
  let value: unknown
  try { value = await response.json() } catch { value = undefined }
  if (response.status === 404) throw new Error(t('launcher.historyUnavailable'))
  if (!response.ok) {
    const error = (value as { error?: unknown } | undefined)?.error
    throw new Error(typeof error === 'string' ? error : t('requestFailed', { status: response.status }))
  }
  const history = value as Partial<LaunchHistory> | undefined
  if (!history || !Array.isArray(history.entries) || !history.entries.every(isEntry) || !nullableString(history.error)
    || !Number.isSafeInteger(history.limit) || history.limit! < 1) throw new Error(t('launcher.historyInvalid'))
  return { entries: history.entries.slice(0, 30), limit: Math.min(history.limit!, 30), error: history.error! }
}

/** Serialize reads, retain usable history on transient failure, and release polling when the view closes. */
function useLaunchHistory(t: T) {
  const copy = useRef(t); copy.current = t
  const [view, setView] = useState<{ data?: LaunchHistory; checking: boolean; error?: string }>({ checking: true })
  const control = useRef<() => Promise<void>>()
  useEffect(() => {
    let alive = true, request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (!alive || request) return
      clearTimeout(timer)
      const controller = new AbortController(); request = controller
      setView(previous => ({ ...previous, checking: true }))
      try {
        const data = await readHistory(copy.current, controller.signal)
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
  }, [])
  const refresh = useCallback(async () => { await control.current?.() }, [])
  return { ...view, refresh }
}

export function HistoryPanel({ t, openSession }: { t: T; openSession: (id: string) => Promise<void> }) {
  const { data, checking, error, refresh } = useLaunchHistory(t)
  const id = useId()
  const mounted = useRef(true), navigation = useRef(false)
  const [opening, setOpening] = useState<string>()
  const [navigationError, setNavigationError] = useState<{ id: string; message: string }>()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const open = async (entryId: string, sessionId: string) => {
    if (navigation.current) return
    navigation.current = true; setOpening(sessionId); setNavigationError(undefined)
    try { await openSession(sessionId) }
    catch (failure) { if (mounted.current) setNavigationError({ id: entryId, message: errorText(failure) }) }
    finally { navigation.current = false; if (mounted.current) setOpening(undefined) }
  }
  const failure = error ?? data?.error
  return <section className="dt-card dt-history" aria-labelledby={`${id}-title`} aria-busy={checking}>
    <header className="dt-history-head">
      <div className="dt-section"><h2 className="dt-block-title" id={`${id}-title`}>{t('launcher.historyTitle')}</h2>
        <p className="dt-hint">{t('launcher.historyLimit', { limit: data?.limit ?? 30 })}</p></div>
      <Button variant="outline" size="sm" disabled={checking} icon={<Icon name="refresh" size={14} />}
        onClick={() => { void refresh() }}>{t('launcher.historyRefresh')}</Button>
    </header>
    {failure && <p className="dt-error dt-launch-error" role="alert">{failure}</p>}
    {!data && checking && <p className="dt-hint" role="status">{t('launcher.historyLoading')}</p>}
    {data && data.entries.length === 0 && !failure && <div className="dt-section dt-history-empty">
      <p className="dt-section-title">{t('launcher.historyEmpty')}</p><p className="dt-hint">{t('launcher.historyEmptyHint')}</p>
    </div>}
    {!!data?.entries.length && <ol className="dt-history-list">{data.entries.map(entry => <li key={entry.id} className="dt-history-row">
      <div className="dt-history-heading"><h3>{entry.repository}</h3><span className="dt-launch-state">
        <Dot state={marks[entry.phase]} />{t(`launcher.phase.${entry.phase}`)}</span></div>
      <p className="dt-hint">{t('launcher.selectedBranch', { branch: entry.branch ?? t('launcher.defaultBranch') })}</p>
      <div className="dt-row-meta"><span>{t('launcher.historyStarted')} <time dateTime={entry.startedAt}>{fullTime(entry.startedAt, t('lang')) || entry.startedAt}</time></span>
        {entry.endedAt && <span>{t('launcher.historyEnded')} <time dateTime={entry.endedAt}>{fullTime(entry.endedAt, t('lang')) || entry.endedAt}</time></span>}</div>
      {entry.error && <p className="dt-error dt-launch-error">{entry.error}</p>}
      <div className="dt-actions">
        {entry.consoleId && <Button variant="outline" size="sm" disabled={!!opening} icon={<Icon name="message" size={14} />}
          onClick={() => { void open(entry.id, entry.consoleId!) }}>{t('launcher.openConsole')}</Button>}
        {entry.masterId && <Button variant="outline" size="sm" disabled={!!opening} icon={<Icon name="session" size={14} />}
          onClick={() => { void open(entry.id, entry.masterId!) }}>{t('openMaster')}</Button>}
        {!entry.consoleId && !entry.masterId && <p className="dt-hint">{t('launcher.historyNoSession')}</p>}
      </div>
      {navigationError?.id === entry.id && <p className="dt-error dt-launch-error" role="alert">{navigationError.message}</p>}
    </li>)}</ol>}
  </section>
}
