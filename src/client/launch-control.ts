/** Local supervisor status and explicit stop requests; repository startup belongs to the Superagent session. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LaunchPhase, LaunchRequest, LaunchStatus } from '../on-demand/types.ts'
import { errorText, type T } from './text.ts'

type Mutation = Extract<LaunchRequest, { action: 'stop' }>
interface View {
  status?: LaunchStatus
  pending?: Mutation['action']
  checking: boolean
  loadError?: string
  actionError?: string
}
const phases: readonly LaunchPhase[] = ['idle', 'starting', 'running', 'needs-setup', 'stopping', 'error']
const nullableString = (value: unknown) => value === null || typeof value === 'string'
function isStatus(value: unknown): value is LaunchStatus {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<LaunchStatus>
  return phases.includes(state.phase as LaunchPhase) && state.executor === 'harness' && typeof state.panelAvailable === 'boolean'
    && nullableString(state.repository) && nullableString(state.lastRepository) && nullableString(state.masterId) && nullableString(state.error)
    && (state.branch === undefined || nullableString(state.branch)) && (state.lastBranch === undefined || nullableString(state.lastBranch))
    && (state.consoleId === undefined || nullableString(state.consoleId))
}
async function request(t: T, signal: AbortSignal, body?: Mutation): Promise<LaunchStatus> {
  let response: Response
  try {
    response = await fetch('/orchestrator/control', { method: body ? 'POST' : 'GET', signal,
      headers: { 'x-orchestrator-request': '1', ...body ? { 'content-type': 'application/json' } : {} },
      ...body ? { body: JSON.stringify(body) } : {} })
  } catch (failure) {
    if (signal.aborted) throw failure
    throw new Error(t('launcher.offline'))
  }
  let value: unknown
  try { value = await response.json() } catch { value = undefined }
  if (!response.ok) {
    const failure = value as { error?: unknown } | undefined
    throw new Error(typeof failure?.error === 'string' ? failure.error : t('requestFailed', { status: response.status }))
  }
  if (!isStatus(value)) throw new Error(t('launcher.invalidResponse'))
  return { ...value, branch: value.branch ?? null, lastBranch: value.lastBranch ?? null, consoleId: value.consoleId ?? null }
}

/** Serializes status polling, cancels stale reads before mutations, and disposes all requests and timers on unmount. */
export function useLaunchControl(t: T) {
  const copy = useRef(t)
  copy.current = t
  const [view, setView] = useState<View>({ checking: true })
  const control = useRef<{ refresh: () => Promise<void>; mutate: (body: Mutation) => Promise<void> }>()
  useEffect(() => {
    let alive = true, sequence = 0
    let lastStatus: LaunchStatus | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let read: AbortController | undefined, mutation: AbortController | undefined
    const schedule = () => {
      clearTimeout(timer)
      const interval = lastStatus?.phase === 'starting' || lastStatus?.phase === 'stopping' ? 1000 : 5000
      if (alive && !mutation) timer = setTimeout(() => { void refresh() }, document.hidden ? interval * 6 : interval)
    }
    const accept = (status: LaunchStatus) => {
      lastStatus = status
      setView(previous => ({ ...previous, status, loadError: undefined }))
    }
    const refresh = async () => {
      if (!alive || read || mutation) return
      clearTimeout(timer)
      const current = ++sequence, controller = new AbortController()
      read = controller
      setView(previous => ({ ...previous, checking: true }))
      try {
        const status = await request(copy.current, controller.signal)
        if (alive && current === sequence) accept(status)
      } catch (failure) {
        if (alive && current === sequence) setView(previous => ({ ...previous, loadError: errorText(failure) }))
      } finally {
        if (read === controller) read = undefined
        if (alive && current === sequence) {
          setView(previous => ({ ...previous, checking: false }))
          schedule()
        }
      }
    }
    const mutate = async (body: Mutation) => {
      if (!alive || mutation) return
      const current = ++sequence, controller = new AbortController()
      clearTimeout(timer)
      read?.abort(); read = undefined
      mutation = controller
      setView(previous => ({ ...previous, pending: body.action, checking: false, actionError: undefined, loadError: undefined }))
      let failed = false
      try {
        const status = await request(copy.current, controller.signal, body)
        if (alive && current === sequence) accept(status)
      } catch (failure) {
        failed = true
        if (alive && current === sequence) setView(previous => ({ ...previous, actionError: errorText(failure) }))
      } finally {
        if (mutation === controller) mutation = undefined
        if (alive && current === sequence) {
          setView(previous => ({ ...previous, pending: undefined }))
          // A dropped response may still have reached the Host. Reconcile with local status before the next interval.
          if (failed) void refresh()
          else schedule()
        }
      }
    }
    control.current = { refresh, mutate }
    const shown = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', shown)
    void refresh()
    return () => {
      alive = false; sequence++
      clearTimeout(timer)
      read?.abort(); mutation?.abort()
      document.removeEventListener('visibilitychange', shown)
      control.current = undefined
    }
  }, [])
  const refresh = useCallback(async () => { await control.current?.refresh() }, [])
  const mutate = useCallback(async (body: Mutation) => { await control.current?.mutate(body) }, [])
  return { ...view, refresh, mutate }
}
