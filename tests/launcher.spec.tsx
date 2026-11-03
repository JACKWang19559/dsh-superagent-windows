// @vitest-environment jsdom
import { act, type ComponentType, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { Launcher } from '../src/client/launcher.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import type { LaunchHistory, LaunchRequest, LaunchStatus } from '../src/on-demand/types.ts'
import { server, usePanelServer } from './fixtures/panel-server.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const idle = (lastRepository: string | null = null): LaunchStatus => ({ phase: 'idle', executor: 'harness', repository: null,
  lastRepository, branch: null, lastBranch: null, masterId: null, panelAvailable: false, error: null })
const running = (fields: Partial<LaunchStatus> = {}): LaunchStatus => ({ ...idle('acme/widgets'), phase: 'running',
  repository: 'acme/widgets', masterId: 'master', panelAvailable: true, ...fields })
const translator = (dictionary: Record<string, string>): T => ((key: string, values?: Record<string, unknown>) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)) as T
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let root: Root | undefined, container: HTMLDivElement | undefined
function unmount() { act(() => { root?.unmount() }); root = undefined; container?.remove(); container = undefined }
usePanelServer(unmount)
type Request = { url: string; method: string; body?: LaunchRequest; init: RequestInit }
let requests: Request[], status: LaunchStatus, history: LaunchHistory
let opened = vi.fn(async (_id: string) => {}), created = vi.fn(() => {})
let answer: (request: Request) => Promise<Response>, answerHistory: () => Promise<Response>
beforeEach(() => {
  requests = []; status = idle(); history = { entries: [], limit: 30, error: null }
  opened = vi.fn(async (_id: string) => {}); created = vi.fn(() => {})
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  answer = async ({ body }) => { if (body?.action === 'stop') status = idle(status.repository ?? status.lastRepository); return Response.json(status) }
  answerHistory = async () => Response.json(history)
  const managementFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const request: Request = { url, method: init.method ?? 'GET', init, ...init.body ? { body: JSON.parse(String(init.body)) as LaunchRequest } : {} }
    requests.push(request)
    return url === '/orchestrator/control' ? answer(request) : url === '/orchestrator/history' ? answerHistory() : managementFetch(url, init)
  }))
})
afterEach(() => { unmount(); vi.useRealTimers(); vi.restoreAllMocks() })
async function mount(element?: ReactElement, dictionary = zh) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(element ?? <Launcher t={translator(dictionary)} openSession={opened} startSession={created} deploymentForm={undefined} />) })
}
const all = <E extends Element = HTMLElement,>(selector: string) => [...document.querySelectorAll<E>(selector)]
const button = (label: string) => {
  const found = all<HTMLButtonElement>('button').find(item => item.textContent === label)
  if (!found) throw new Error(`No button named ${label}`)
  return found
}
const bodyText = () => { const copy = container!.cloneNode(true) as HTMLElement; copy.querySelectorAll('style').forEach(style => style.remove()); return copy.textContent ?? '' }
async function click(label: string) { await act(async () => { button(label).click() }) }
const controlRequests = () => requests.filter(request => request.url === '/orchestrator/control')
const historyRequests = () => requests.filter(request => request.url === '/orchestrator/history')
const mutations = () => controlRequests().filter(request => request.method === 'POST')
const tabs = () => all('[role="tab"]').map(tab => tab.textContent)

it('reads only status and history while idle, with no repository form, implicit start or management reads', async () => {
  status = { ...idle('remembered/project'), lastBranch: 'feature/history' }
  await mount()
  expect(requests.map(request => request.url).sort()).toEqual(['/orchestrator/control', '/orchestrator/history'])
  expect(requests.every(request => request.method === 'GET' && request.init.body === undefined)).toBe(true)
  expect(requests.every(request => new Headers(request.init.headers).get('x-orchestrator-request') === '1')).toBe(true)
  expect(tabs()).toEqual([])
  expect(all('input, form')).toHaveLength(0)
  expect(bodyText()).toContain(zh['launcher.historyEmpty'])
  expect(bodyText()).toContain(zh['launcher.sessionHint'])
  expect(created).not.toHaveBeenCalled()
  await click(zh['launcher.newSession'])
  expect(created).toHaveBeenCalledOnce()
  expect(requests).toHaveLength(2)
  expect(mutations()).toEqual([])
})

it('can open the Superagent session while status or history is unavailable and reports synchronous navigation failure', async () => {
  answer = async () => Response.json({ error: 'Status unavailable' }, { status: 503 })
  answerHistory = async () => new Response(null, { status: 404 })
  created.mockImplementationOnce(() => { throw new Error('Workspace unavailable') })
  await mount()
  expect(button(zh['launcher.newSession']).disabled).toBe(false)
  await click(zh['launcher.newSession'])
  expect(bodyText()).toContain('Workspace unavailable')
  expect(bodyText()).toContain(zh['launcher.historyUnavailable'])
  await click(zh['launcher.newSession'])
  expect(created).toHaveBeenCalledTimes(2)
  expect(bodyText()).not.toContain('Workspace unavailable')
  expect(mutations()).toEqual([])
})

it('keeps active management and both known session links independent from failed history reads', async () => {
  status = running({ consoleId: 'console', branch: 'codex/video-editing' })
  answerHistory = async () => Response.json({ error: 'History storage unavailable' }, { status: 500 })
  await mount()
  expect(tabs()).toEqual(expect.arrayContaining([zh['tab.overview'], zh['tab.execution'], zh['tab.settings']]))
  expect(document.querySelector('.dt-launchbar')?.textContent).toContain('codex/video-editing')
  expect(document.querySelector('.dt-history')).toBeNull()
  expect(button(zh['launcher.stop']).disabled).toBe(false)
  await click(zh['launcher.openConsole']); await click(zh.openMaster)
  expect(opened.mock.calls).toEqual([['console'], ['master']])
  expect(mutations()).toEqual([])
})

it('keeps settings and tickets available with an older Host that has no consoleId', async () => {
  status = running({ phase: 'needs-setup', masterId: null, error: 'GitHub sign-in is required' })
  await mount()
  expect(bodyText()).toContain('GitHub sign-in is required')
  expect(button(zh.openMaster).disabled).toBe(true)
  expect(all('button').some(item => item.textContent === zh['launcher.openConsole'])).toBe(false)
  await click(zh['tab.settings']); expect(server.requests.some(request => request.path === 'settings')).toBe(true)
  await click(zh['tab.execution']); expect(server.requests.some(request => request.path.startsWith('tickets'))).toBe(true)
})

it.each(['starting', 'stopping'] as const)('polls a Host %s transition without a repository start action', async phase => {
  vi.useFakeTimers(); status = running({ phase, panelAvailable: false, masterId: null })
  await mount()
  expect(bodyText()).toContain(zh[`launcher.phase.${phase}`])
  expect(button(zh['launcher.stop']).disabled).toBe(true)
  expect(tabs()).toEqual([])
  expect(all('input, form')).toHaveLength(0)
  status = running()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(tabs()).toContain(zh['tab.overview'])
  expect(controlRequests().map(request => request.method)).toEqual(['GET', 'GET'])
})

it.each(['offline', 'invalid', 'rejected'] as const)('retries an initial %s status failure with GET only', async kind => {
  answer = async () => {
    if (kind === 'offline') throw new TypeError('Failed to fetch')
    return kind === 'invalid' ? Response.json({ phase: 'running' }) : Response.json({ error: 'Status temporarily unavailable' }, { status: 503 })
  }
  await mount()
  expect(bodyText()).toContain(kind === 'offline' ? zh['launcher.offline'] : kind === 'invalid' ? zh['launcher.invalidResponse'] : 'Status temporarily unavailable')
  expect(bodyText()).toContain(zh['launcher.historyEmpty'])
  answer = async () => Response.json(idle())
  await click(zh['launcher.refresh'])
  expect(all('[role="alert"]')).toHaveLength(0)
  expect(controlRequests().map(request => request.method)).toEqual(['GET', 'GET'])
})

it('stops once, disposes management, and fetches refreshed history after returning to idle', async () => {
  vi.useFakeTimers(); status = running()
  const reply = deferred<Response>()
  answer = async request => request.method === 'POST' ? reply.promise : Response.json(status)
  await mount()
  const stop = button(zh['launcher.stop']), beforeHistory = historyRequests().length
  expect(document.getElementById(stop.getAttribute('aria-describedby')!)?.textContent).toBe(zh['launcher.stopHint'])
  await act(async () => { stop.click(); stop.click() })
  expect(mutations().map(request => request.body)).toEqual([{ action: 'stop' }])
  expect(tabs()).toEqual([])
  expect(button(zh['launcher.stop']).disabled).toBe(true)
  const panelRequests = server.requests.length
  history.entries = [{ id: 'run-1', repository: 'acme/widgets', branch: null, consoleId: 'console', masterId: 'master',
    startedAt: '2026-11-03T10:00:00Z', endedAt: '2026-11-03T10:10:00Z', phase: 'stopped', error: null }]
  await act(async () => { status = idle('acme/widgets'); reply.resolve(Response.json(status)) })
  expect(historyRequests()).toHaveLength(beforeHistory + 1)
  expect(bodyText()).toContain(zh['launcher.phase.stopped'])
  expect(document.querySelector('.dt-history')?.textContent).toContain('acme/widgets')
  expect(all('input, form')).toHaveLength(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(server.requests).toHaveLength(panelRequests)
  expect(mutations()).toHaveLength(1)
})

it('returns to history after a Host restart without restarting the remembered repository', async () => {
  vi.useFakeTimers(); status = running(); await mount()
  status = idle('acme/widgets')
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(tabs()).toEqual([])
  expect(document.querySelector('.dt-history')).not.toBeNull()
  expect(mutations()).toEqual([])
  expect(created).not.toHaveBeenCalled()
})

it('serializes status reads, backs off while hidden and clears scheduled polls on unmount', async () => {
  vi.useFakeTimers(); await mount()
  const reply = deferred<Response>(); answer = async () => reply.promise
  await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
  expect(controlRequests()).toHaveLength(2)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { reply.resolve(Response.json(idle())) })
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999) })
  expect(controlRequests()).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(controlRequests()).toHaveLength(3)
  unmount(); const count = requests.length
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(requests).toHaveLength(count)
})

it('aborts a pending stop on unmount and ignores late completion', async () => {
  vi.useFakeTimers(); status = running()
  const reply = deferred<Response>(); answer = async request => request.method === 'POST' ? reply.promise : Response.json(status)
  await mount(); await click(zh['launcher.stop'])
  const mutation = mutations()[0]!; unmount()
  expect(mutation.init.signal?.aborted).toBe(true)
  const count = requests.length
  await act(async () => { reply.resolve(Response.json(idle())); await vi.advanceTimersByTimeAsync(60_000) })
  expect(requests).toHaveLength(count)
})

it('shows a stop failure and restores the current management panel for retry', async () => {
  status = running()
  answer = async request => request.method === 'POST' ? Response.json({ error: 'Worker shutdown failed' }, { status: 500 }) : Response.json(status)
  await mount(); await click(zh['launcher.stop'])
  expect(bodyText()).toContain('Worker shutdown failed')
  expect(button(zh['launcher.stop']).disabled).toBe(false)
  expect(tabs()).toContain(zh['tab.overview'])
})

it('aborts and ignores a stale running poll after an explicit stop', async () => {
  vi.useFakeTimers(); status = running(); await mount()
  const oldRead = deferred<Response>()
  answer = async request => request.method === 'GET' ? oldRead.promise : Response.json(idle())
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  const polling = controlRequests().at(-1)!
  await click(zh['launcher.stop'])
  expect(polling.init.signal?.aborted).toBe(true)
  await act(async () => { oldRead.resolve(Response.json(running())) })
  expect(tabs()).toEqual([])
  expect(document.querySelector('.dt-history')).not.toBeNull()
})

it('aborts pending status and history reads when closed and ignores late responses', async () => {
  vi.useFakeTimers(); const reply = deferred<Response>(), historyReply = deferred<Response>()
  answer = async () => reply.promise; answerHistory = async () => historyReply.promise
  await mount(); unmount()
  expect(requests.every(request => request.init.signal?.aborted)).toBe(true)
  await act(async () => { reply.resolve(Response.json(running())); historyReply.resolve(Response.json(history)); await vi.advanceTimersByTimeAsync(60_000) })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(requests).toHaveLength(2)
})

it('renders English runtime controls and reports session navigation failures without control mutations', async () => {
  status = running(); opened.mockRejectedValueOnce(new Error('Session list not ready'))
  await mount(undefined, en); await click(en.openMaster)
  expect(bodyText()).toContain(en['launcher.stopHint'])
  expect(bodyText()).toContain('Session list not ready')
  expect(button(en.openMaster).disabled).toBe(false)
  expect(mutations()).toEqual([])
})

it('uses the public workspace action with only the Superagent preset and opens history sessions through existing navigation', async () => {
  type Entry = { options: { name: string }; Component: ComponentType<{ t: T }> }
  const entries: Entry[] = [], t = translator(zh), open = vi.fn(), start = vi.fn()
  history.entries = [{ id: 'previous', repository: 'acme/widgets', branch: null, consoleId: 'console', masterId: 'master',
    startedAt: '2026-11-03T10:00:00Z', endedAt: '2026-11-03T10:10:00Z', phase: 'stopped', error: null }]
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], Component: Entry['Component']) => { entries.push({ options, Component }); return () => {} } },
    locale: { register: () => () => {}, bind: () => t }, effect: (effect: () => unknown) => effect(), get: () => undefined,
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { master: {}, console: {} } }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: open, startSession: start },
  }
  apply(ctx as never)
  const Main = entries.find(entry => entry.options.name === 'main')!.Component
  await mount(<Main t={t} />); await click(zh['launcher.newSession'])
  expect(start).toHaveBeenCalledExactlyOnceWith(undefined, { agentPreset: 'superagent' })
  await click(zh['launcher.openConsole']); await click(zh.openMaster)
  expect(open.mock.calls).toEqual([['console'], ['master']])
  expect(requests.every(request => request.method === 'GET')).toBe(true)
})
