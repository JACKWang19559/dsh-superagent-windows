/** On-demand entry for the existing management panel; only an explicit submit starts the Host runtime. */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { LaunchPhase } from '../on-demand/types.ts'
import { parseRepositoryInput, repositoryInput } from '../on-demand/repository.ts'
import { App, type AppProps } from './app.tsx'
import STYLES from './client.css?raw'
import { Button, Dot, Icon, Input, type DotState } from './controls.tsx'
import { useLaunchControl } from './launch-control.ts'
import { errorText } from './text.ts'

const marks: Record<LaunchPhase, DotState> = { idle: 'idle', starting: 'ongoing', running: 'done', 'needs-setup': 'warning',
  stopping: 'ongoing', error: 'error' }

export function Launcher({ t, openSession, deploymentForm }: AppProps) {
  const { status, pending, checking, loadError, actionError, refresh, mutate } = useLaunchControl(t)
  const [draft, setDraft] = useState<string>()
  const [opening, setOpening] = useState(false)
  const [navigationError, setNavigationError] = useState<string>()
  const navigation = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const id = useId()
  const remembered = status?.repository ?? status?.lastRepository
  const rememberedBranch = status?.repository ? status.branch : status?.lastBranch
  const repository = draft ?? (remembered ? repositoryInput({ repository: remembered, branch: rememberedBranch ?? null }) : '')
  const target = parseRepositoryInput(repository)
  const valid = !!target
  const invalid = !!repository.trim() && !valid
  const phase = pending === 'start' ? 'starting' : pending === 'stop' ? 'stopping' : status?.phase
  const busy = phase === 'starting' || phase === 'stopping'
  const active = !!status && (status.panelAvailable || status.phase === 'running' || status.phase === 'needs-setup'
    || status.phase === 'stopping' || status.phase === 'error' && !!status.repository)
  const showPanel = !!status?.panelAvailable && !pending && (status.phase === 'running' || status.phase === 'needs-setup')
  const error = navigationError ?? actionError ?? loadError ?? status?.error
  const canStart = !!status && !loadError && !busy && !active && valid
  const start = (event: FormEvent) => {
    event.preventDefault()
    if (!canStart) return
    setNavigationError(undefined)
    void mutate({ action: 'start', repository: repository.trim() })
  }
  const stop = () => {
    if (busy || !active || loadError) return
    setNavigationError(undefined)
    void mutate({ action: 'stop' })
  }
  const openMaster = async () => {
    if (!status?.masterId || busy || navigation.current) return
    navigation.current = true; setOpening(true); setNavigationError(undefined)
    try { await openSession(status.masterId) }
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
            <Button variant="outline" size="sm" disabled={!status.masterId || busy || opening}
              icon={<Icon name="session" size={14} />} onClick={() => { void openMaster() }}>{t('openMaster')}</Button>
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
      <section className="dt-card dt-launch-card" aria-labelledby={`${id}-title`} aria-busy={busy || (!status && checking)}>
        <div className="dt-section">
          <h1 id={`${id}-title`} className="dt-block-title">{t('launcher.title')}</h1>
          <p className="dt-hint">{t('launcher.usage')}</p>
        </div>
        {state}
        <form className="dt-form" onSubmit={start}>
          <div className="dt-field">
            <label htmlFor={`${id}-repository`}>{t('launcher.repository')}</label>
            <Input id={`${id}-repository`} value={repository} placeholder={t('launcher.repositoryPlaceholder')} maxLength={2048} autoComplete="off" autoCapitalize="none"
              spellCheck={false} disabled={busy} aria-invalid={invalid || undefined}
              aria-describedby={`${id}-repository-hint${invalid ? ` ${id}-repository-error` : ''}`}
              onChange={event => { setDraft(event.target.value) }} />
            <p id={`${id}-repository-hint`} className="dt-hint">{t('launcher.startHint')}</p>
            {target && <p className="dt-hint dt-launch-target">{t('launcher.selectedBranch', { branch: target.branch ?? t('launcher.defaultBranch') })}</p>}
            {invalid && <p id={`${id}-repository-error`} className="dt-error">{t('launcher.repositoryInvalid')}</p>}
          </div>
          {status?.phase === 'idle' && status.lastRepository && <p className="dt-hint">{t('launcher.remembered')}</p>}
          {failure}
          <div className="dt-actions">
            <Button type="submit" variant="primary" disabled={!canStart} aria-describedby={`${id}-access`}
              icon={<Icon name={busy ? 'running' : 'play'} />}
              className={busy ? 'dt-btn-busy' : undefined}>{t(phase === 'starting' ? 'launcher.starting'
                : phase === 'stopping' ? 'launcher.stopping' : 'launcher.start')}</Button>
            {retry}
            <p id={`${id}-access`} className="dt-hint">{t('launcher.accessHint')}</p>
          </div>
        </form>
        <p className="dt-hint dt-launch-console">{t('launcher.consoleHint')}</p>
      </section>
    </div></div>}
  </div>
}
