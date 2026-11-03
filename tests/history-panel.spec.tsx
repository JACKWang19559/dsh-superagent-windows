// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HistoryPanel } from '../src/client/history.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import type { LaunchHistory, LaunchHistoryEntry } from '../src/on-demand/types.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const row = (fields: Partial<LaunchHistoryEntry> = {}): LaunchHistoryEntry => ({ id: 'launch-1', repository: 'acme/widgets',
  branch: 'codex/video-editing', consoleId: 'console-1', masterId: 'master-1', startedAt: '2026-11-03T09:00:00Z',
  endedAt: '2026-11-03T10:00:00Z', phase: 'stopped', error: null, ...fields })
const translator = (dictionary: Record<string, string>): T => ((key: string, values?: Record<string, unknown>) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)) as T
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let root: Root | undefined, container: HTMLDivElement | undefined
let history: LaunchHistory, requests: { url: string; init: RequestInit }[], answer: () => Promise<Response>
let opened = vi.fn(async (_id: string) => {})
function unmount() { act(() => { root?.unmount() }); root = undefined; container?.remove(); container = undefined }
beforeEach(() => {
  history = { entries: [], limit: 30, error: null }; requests = []; opened = vi.fn(async (_id: string) => {})
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  answer = async () => Response.json(history)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { requests.push({ url, init }); return answer() }))
})
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function mount(dictionary = zh) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<HistoryPanel t={translator(dictionary)} openSession={opened} />) })
}
function button(label: string) {
  const item = [...container!.querySelectorAll('button')].find(button => button.textContent === label)
  if (!item) throw new Error(`No button named ${label}`)
  return item
}
async function click(label: string) { await act(async () => { button(label).click() }) }
const text = () => container!.textContent ?? ''

it('loads local history with GET only and gives an empty-state guide without an input or launch action', async () => {
  await mount()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ url: '/orchestrator/history', init: { method: 'GET', headers: { 'x-orchestrator-request': '1' } } })
  expect(requests[0]!.init.body).toBeUndefined()
  expect(text()).toContain(zh['launcher.historyEmpty'])
  expect(text()).toContain(zh['launcher.historyEmptyHint'])
  expect(text()).toContain('30')
  expect(container!.querySelectorAll('input, form')).toHaveLength(0)
  expect(opened).not.toHaveBeenCalled()
})

it('renders repository, full branch, start/end dates and terminal states with only available session buttons', async () => {
  history.entries = [row(), row({ id: 'failed', repository: 'other/project', branch: null, consoleId: null, masterId: null,
    endedAt: null, phase: 'interrupted', error: 'Desktop exited' })]
  await mount()
  const rows = [...container!.querySelectorAll('.dt-history-row')]
  expect(rows).toHaveLength(2)
  expect(rows[0]!.textContent).toContain('acme/widgets')
  expect(rows[0]!.textContent).toContain('codex/video-editing')
  expect(rows[0]!.textContent).toContain(zh['launcher.phase.stopped'])
  expect([...rows[0]!.querySelectorAll('time')].map(time => time.dateTime)).toEqual(['2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'])
  expect(rows[0]!.querySelectorAll('button')).toHaveLength(2)
  expect(rows[1]!.textContent).toContain(zh['launcher.defaultBranch'])
  expect(rows[1]!.textContent).toContain(zh['launcher.phase.interrupted'])
  expect(rows[1]!.textContent).toContain('Desktop exited')
  expect(rows[1]!.textContent).toContain(zh['launcher.historyNoSession'])
  expect(rows[1]!.querySelectorAll('button')).toHaveLength(0)
})

it('opens console and master through the existing navigation callback without any mutation request', async () => {
  history.entries = [row()]
  await mount(); await click(zh['launcher.openConsole']); await click(zh.openMaster)
  expect(opened.mock.calls).toEqual([['console-1'], ['master-1']])
  expect(requests).toHaveLength(1)
  expect(requests.every(request => request.init.method === 'GET')).toBe(true)
})

it('serializes navigation, reports missing sessions in their row, and allows a retry', async () => {
  history.entries = [row()]
  const pending = deferred<void>()
  opened.mockImplementationOnce(async () => pending.promise)
  await mount()
  const consoleButton = button(zh['launcher.openConsole']), masterButton = button(zh.openMaster)
  await act(async () => { consoleButton.click(); masterButton.click() })
  expect(opened).toHaveBeenCalledExactlyOnceWith('console-1')
  expect(masterButton.disabled).toBe(true)
  await act(async () => { pending.resolve() })
  opened.mockRejectedValueOnce(new Error(zh.sessionNotListed))
  await click(zh.openMaster)
  expect(container!.querySelector('.dt-history-row [role="alert"]')?.textContent).toBe(zh.sessionNotListed)
  expect(masterButton.disabled).toBe(false)
  await click(zh.openMaster)
  expect(container!.querySelector('[role="alert"]')).toBeNull()
  expect(requests).toHaveLength(1)
})

it.each(['offline', 'missing', 'invalid', 'invalid-start', 'invalid-end', 'rejected'] as const)('shows a separate %s history failure and retries with GET', async kind => {
  answer = async () => {
    if (kind === 'offline') throw new TypeError('Failed to fetch')
    if (kind === 'missing') return new Response(null, { status: 404 })
    if (kind === 'invalid') return Response.json({ entries: [{ repository: 'unsafe/shape' }], limit: 30, error: null })
    if (kind === 'invalid-start' || kind === 'invalid-end') return Response.json({ ...history,
      entries: [row(kind === 'invalid-start' ? { startedAt: 'not-a-date' } : { endedAt: 'not-a-date' })] })
    return Response.json({ error: 'History storage unavailable' }, { status: 503 })
  }
  await mount()
  expect(container!.querySelector('[role="alert"]')?.textContent).toBe(kind === 'offline' ? zh['launcher.historyOffline']
    : kind === 'missing' ? zh['launcher.historyUnavailable'] : kind.startsWith('invalid') ? zh['launcher.historyInvalid'] : 'History storage unavailable')
  expect(text()).not.toContain(zh['launcher.historyEmpty'])
  answer = async () => Response.json(history)
  await click(zh['launcher.historyRefresh'])
  expect(container!.querySelector('[role="alert"]')).toBeNull()
  expect(text()).toContain(zh['launcher.historyEmpty'])
  expect(requests).toHaveLength(2)
  expect(requests.every(request => request.init.method === 'GET' && request.init.body === undefined)).toBe(true)
})

it('keeps usable records visible with a storage warning or a failed refresh', async () => {
  history = { entries: [row()], limit: 30, error: 'History file could not be saved' }
  await mount()
  expect(text()).toContain('acme/widgets')
  expect(text()).toContain('History file could not be saved')
  answer = async () => Response.json({ error: 'Temporary read failure' }, { status: 500 })
  await click(zh['launcher.historyRefresh'])
  expect(text()).toContain('acme/widgets')
  expect(text()).toContain('Temporary read failure')
  history = { entries: [row({ repository: 'latest/project' })], limit: 30, error: null }
  answer = async () => Response.json(history)
  await click(zh['launcher.historyRefresh'])
  expect(text()).toContain('latest/project')
  expect(text()).not.toContain('acme/widgets')
  expect(container!.querySelector('[role="alert"]')).toBeNull()
})

it('caps visible records at 30 and renders the same controls in English', async () => {
  history = { entries: Array.from({ length: 31 }, (_, index) => row({ id: String(index), repository: `acme/repo-${index}` })), limit: 100, error: null }
  await mount(en)
  expect(container!.querySelectorAll('.dt-history-row')).toHaveLength(30)
  expect(text()).toContain('Up to 30 recent launches')
  expect(text()).not.toContain('acme/repo-30')
  expect(button(en['launcher.openConsole'])).toBeDefined()
  expect(text()).toContain(en['launcher.phase.stopped'])
})

it('serializes polls, slows them while hidden, refreshes on visibility, and aborts on unmount', async () => {
  vi.useFakeTimers()
  const first = deferred<Response>(); answer = async () => first.promise
  await mount()
  expect(text()).toContain(zh['launcher.historyLoading'])
  expect(button(zh['launcher.historyRefresh']).disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
  expect(requests).toHaveLength(1)
  await act(async () => { first.resolve(Response.json(history)) })
  const second = deferred<Response>(); answer = async () => second.promise
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(20_000) })
  expect(requests).toHaveLength(2)
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { second.resolve(Response.json(history)) })
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
  expect(requests).toHaveLength(2)
  const third = deferred<Response>(); answer = async () => third.promise
  hidden.mockReturnValue(false)
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(requests).toHaveLength(3)
  unmount()
  expect(requests[2]!.init.signal?.aborted).toBe(true)
  await act(async () => { third.resolve(Response.json(history)); await vi.advanceTimersByTimeAsync(120_000) })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(requests).toHaveLength(3)
})
