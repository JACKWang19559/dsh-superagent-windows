/** Sidebar entry: launch history and session navigation, plus management of an already running repository. */
import { useEffect, useId, useRef, useState } from 'react'
import type { LaunchPhase } from '../on-demand/types.ts'
import { App, type AppProps } from './app.tsx'
import STYLES from './client.css?raw'
import { Button, Dot, Icon, type DotState } from './controls.tsx'
import { HistoryPanel } from './history.tsx'
import { useLaunchControl } from './launch-control.ts'
import { errorText } from './text.ts'

const marks: Record<LaunchPhase, DotState> = { idle: 'idle', starting: 'ongoing', running: 'done', 'needs-setup': 'warning',
  stopping: 'ongoing', error: 'error' }
export interface LauncherProps extends AppProps { startSession: () => void }

export function Launcher({ t, openSession, startSession, deploymentForm }: LauncherProps) {
  const { status, pending, checking, loadError, actionError, refresh, mutate } = useLaunchControl(t)
  const [opening, setOpening] = useState(false)
  const [navigationError, setNavigationError] = useState<string>()
  const navigation = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const id = useId()
  const phase = pending === 'stop' ? 'stopping' : status?.phase
  const busy = phase === 'starting' || phase === 'stopping'
  const active = !!status && (status.panelAvailable || status.phase === 'starting' || status.phase === 'running'
    || status.phase === 'needs-setup' || status.phase === 'stopping' || status.phase === 'error' && !!status.repository)
  const showPanel = !!status?.panelAvailable && !pending && (status.phase === 'running' || status.phase === 'needs-setup')
  const error = navigationError ?? actionError ?? loadError ?? status?.error
  const stop = () => {
    if (busy || !active || loadError) return
    setNavigationError(undefined)
    void mutate({ action: 'stop' })
  }
  const navigate = async (action: () => void | Promise<void>) => {
    if (navigation.current) return
    navigation.current = true; setOpening(true); setNavigationError(undefined)
    try { await action() }
    catch (failure) { if (mounted.current) setNavigationError(errorText(failure)) }
    finally { navigation.current = false; if (mounted.current) setOpening(false) }
  }
  const state = <span className="dt-launch-state" role="status" aria-live="polite">
    <Dot state={phase ? marks[phase] : loadError ? 'error' : 'ongoing'} />
    {phase ? t(`launcher.phase.${phase}`) : loadError ? t('launcher.statusUnknown') : t('launcher.loading')}
  </span>
  const failure = error && <p className="dt-error dt-launch-error" role="alert">{error}</p>
  const retry = loadError && <Button variant="outline" size="sm" disabled={checking || !!pending}
    icon={<Icon name="refresh" size={14} />} onClick={() => { void refresh() }}>{t('launcher.refresh')}</Button>
  const newSession = <Button variant={active ? 'outline' : 'primary'} size={active ? 'sm' : 'md'} disabled={opening}
    aria-describedby={active ? undefined : `${id}-session`} icon={<Icon name="plus" size={active ? 14 : 16} />}
    onClick={() => { void navigate(startSession) }}>{t('launcher.newSession')}</Button>
  return <div className="dt-launcher">
    {!showPanel && <style>{STYLES}</style>}
    {active ? <>
      <header className="dt-launchbar" aria-label={t('launcher.controls')}>
        <div className="dt-launchbar-content">
          <div className="dt-launch-meta">
            <div className="dt-launch-heading"><strong>{status.repository ?? status.lastRepository}</strong>{state}</div>
            <p className="dt-hint">{t('launcher.executor')}</p>
            <p className="dt-hint">{t('launcher.selectedBranch', { branch: status.branch ?? t('launcher.defaultBranch') })}</p>
          </div>
          <div className="dt-actions">
            {status.consoleId && <Button variant="outline" size="sm" disabled={busy || opening}
              icon={<Icon name="message" size={14} />} onClick={() => { void navigate(() => openSession(status.consoleId!)) }}>{t('launcher.openConsole')}</Button>}
            <Button variant="outline" size="sm" disabled={!status.masterId || busy || opening}
              icon={<Icon name="session" size={14} />} onClick={() => { void navigate(() => openSession(status.masterId!)) }}>{t('openMaster')}</Button>
            {newSession}
            <Button variant="outline" size="sm" disabled={busy || !!loadError} aria-describedby={`${id}-stop`}
              icon={<Icon name="stop" size={14} />} onClick={stop}>{t('launcher.stop')}</Button>
            {retry}
          </div>
          <p id={`${id}-stop`} className="dt-hint dt-launch-stop-hint">{t('launcher.stopHint')}</p>
          {failure}
        </div>
      </header>
      {showPanel ? <App key={`${status.repository}\0${status.branch ?? ''}`} t={t} openSession={openSession} deploymentForm={deploymentForm} showMasterLink={false} />
        : <div className="dt-page"><div className="dt-column"><p className="dt-hint" role="status">
          {t(phase === 'error' ? 'launcher.stopHint' : phase === 'stopping' ? 'launcher.stoppingHint' : 'launcher.startingHint')}
        </p></div></div>}
    </> : <div className="dt-page"><div className="dt-column">
      <section className="dt-card dt-launch-card" aria-labelledby={`${id}-title`}>
        <div className="dt-history-head"><h1 id={`${id}-title`} className="dt-block-title">{t('launcher.title')}</h1>{state}</div>
        <p className="dt-hint">{t('launcher.usage')}</p>
        <div className="dt-actions">{newSession}{retry}</div>
        <p id={`${id}-session`} className="dt-hint">{t('launcher.sessionHint')}</p>
        {failure}
      </section>
      <HistoryPanel t={t} openSession={openSession} />
    </div></div>}
  </div>
}
