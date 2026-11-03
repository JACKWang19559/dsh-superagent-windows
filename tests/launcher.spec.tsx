// @vitest-environment jsdom
import { act, type ComponentType, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { Launcher } from '../src/client/launcher.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import type { LaunchRequest, LaunchStatus } from '../src/on-demand/types.ts'
import { server, usePanelServer } from './fixtures/panel-server.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const idle = (lastRepository: string | null = null): LaunchStatus => ({ phase: 'idle', executor: 'harness', repository: null,
  lastRepository, branch: null, lastBranch: null, masterId: null, panelAvailable: false, error: null })
const running = (fields: Partial<LaunchStatus> = {}): LaunchStatus => ({ ...idle('acme/widgets'), phase: 'running',
  repository: 'acme/widgets', masterId: 'master', panelAvailable: true, ...fields })
const translator = (dictionary: Record<string, string>): T => ((key: string, values?: Record<string, unknown>) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)) as T
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let root: Root | undefined, container: HTMLDivElement | undefined
function unmount() { act(() => { root?.unmount() }); root = undefined; container?.remove(); container = undefined }
usePanelServer(unmount)
type Request = { url: string; method: string; body?: LaunchRequest; init: RequestInit }
let requests: Request[], status: LaunchStatus
let opened = vi.fn(async (_id: string) => {})
let answer: (request: Request) => Promise<Response>
beforeEach(() => {
  requests = []; status = idle(); opened = vi.fn(async (_id: string) => {})
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  answer = async ({ body }) => {
    if (body?.action === 'start') status = running({ repository: body.repository, lastRepository: body.repository })
    if (body?.action === 'stop') status = idle(status.repository ?? status.lastRepository)
    return Response.json(status)
  }
  const managementFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const request: Request = { url, method: init.method ?? 'GET', init,
      ...init.body ? { body: JSON.parse(String(init.body)) as LaunchRequest } : {} }
    requests.push(request)
    return url === '/orchestrator/control' ? answer(request) : managementFetch(url, init)
  }))
})
afterEach(() => { unmount(); vi.useRealTimers(); vi.restoreAllMocks() })
async function mount(element?: ReactElement, dictionary = zh) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(element ?? <Launcher t={translator(dictionary)} openSession={opened} deploymentForm={undefined} />) })
}
const all = <E extends Element = HTMLElement,>(selector: string) => [...document.querySelectorAll<E>(selector)]
const button = (label: string) => {
  const found = all<HTMLButtonElement>('button').find(item => item.textContent === label)
  if (!found) throw new Error(`No button named ${label}`)
  return found
}
const input = () => document.querySelector<HTMLInputElement>('.dt-launch-card input')!
const bodyText = () => {
  const copy = container!.cloneNode(true) as HTMLElement
  copy.querySelectorAll('style').forEach(style => style.remove())
  return copy.textContent ?? ''
}
async function type(value: string) {
  await act(async () => {
    const field = input()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(label: string) { await act(async () => { button(label).click() }) }
const controlRequests = () => requests.filter(request => request.url === '/orchestrator/control')
const mutations = () => controlRequests().filter(request => request.method === 'POST')
const tabs = () => all('[role="tab"]').map(tab => tab.textContent)

it('reads only local status on mount and typing, with no runtime panel or implicit start', async () => {
  await mount()
  expect(requests.map(({ url, method }) => [url, method])).toEqual([['/orchestrator/control', 'GET']])
  expect(requests[0]!.init.headers).toEqual({ 'x-orchestrator-request': '1' })
  expect(requests[0]!.init.body).toBeUndefined()
  expect(tabs()).toEqual([])
  expect(bodyText()).toContain(zh['launcher.title'])
  expect(bodyText()).toContain(zh['launcher.usage'])
  expect(bodyText()).toContain(zh['launcher.consoleHint'])
  expect(bodyText()).toContain(zh['launcher.accessHint'])
  expect(button(zh['launcher.start']).disabled).toBe(true)
  for (const value of ['widgets', 'https://evil.example/acme/widgets', '../widgets', 'acme/widgets/extra']) {
    await type(value)
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(button(zh['launcher.start']).disabled).toBe(true)
  }
  await type('acme/widgets')
  expect(button(zh['launcher.start']).disabled).toBe(false)
  expect(input().hasAttribute('aria-invalid')).toBe(false)
  expect(requests).toHaveLength(1)
  expect(all('input')).toHaveLength(1)
  expect(bodyText()).not.toMatch(/Codex|Claude|Token/)
  const access = button(zh['launcher.start']).getAttribute('aria-describedby')!
  expect(document.getElementById(access)?.textContent).toBe(zh['launcher.accessHint'])
})

it.each(['5th-Axiom/VideoInWay', 'https://github.com/5th-Axiom/VideoInWay',
  'https://github.com/5th-Axiom/VideoInWay/tree/codex/video-editing'])('submits supported input %s intact, with no request while typing', async repository => {
  answer = async request => Response.json(request.body?.action === 'start'
    ? running({ repository: '5th-Axiom/VideoInWay', branch: repository.includes('/tree/') ? 'codex/video-editing' : null }) : status)
  await mount(); await type(repository)
  expect(button(zh['launcher.start']).disabled).toBe(false)
  expect(input().hasAttribute('aria-invalid')).toBe(false)
  expect(document.querySelector('.dt-launch-target')?.textContent).toContain(repository.includes('/tree/') ? 'codex/video-editing' : zh['launcher.defaultBranch'])
  expect(requests).toHaveLength(1)
  await click(zh['launcher.start'])
  expect(mutations().map(item => item.body)).toEqual([{ action: 'start', repository }])
  expect(document.querySelector('.dt-launchbar')?.textContent).toContain(repository.includes('/tree/') ? 'codex/video-editing' : zh['launcher.defaultBranch'])
})

it('restores the whole remembered branch link after restart without auto-starting', async () => {
  status = { ...idle('5th-Axiom/VideoInWay'), lastBranch: 'codex/video-editing' }
  await mount()
  expect(input().value).toBe('https://github.com/5th-Axiom/VideoInWay/tree/codex/video-editing')
  expect(button(zh['launcher.start']).disabled).toBe(false)
  expect(mutations()).toEqual([])
  expect(tabs()).toEqual([])
})

it('fills the last repository after a cold restart but stays idle through polling and preserves a draft', async () => {
  vi.useFakeTimers()
  status = idle('remembered/project')
  await mount()
  expect(input().value).toBe('remembered/project')
  expect(bodyText()).toContain(zh['launcher.remembered'])
  await type('new/project')
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(input().value).toBe('new/project')
  expect(requests.map(request => request.method)).toEqual(['GET', 'GET'])
  expect(tabs()).toEqual([])
})

it('keeps start disabled until initial status arrives without overwriting text typed while loading', async () => {
  const reply = deferred<Response>()
  answer = async () => reply.promise
  await mount()
  await type('typed/project')
  expect(bodyText()).toContain(zh['launcher.loading'])
  expect(button(zh['launcher.start']).disabled).toBe(true)
  await act(async () => { reply.resolve(Response.json(idle('remembered/project'))) })
  expect(input().value).toBe('typed/project')
  expect(button(zh['launcher.start']).disabled).toBe(false)
  expect(requests).toHaveLength(1)
})

it('posts one explicit start, disables editing while pending and exposes the existing panel when ready', async () => {
  const reply = deferred<Response>()
  answer = async request => request.method === 'POST' ? reply.promise : Response.json(status)
  await mount()
  await type(' acme/widgets ')
  await act(async () => {
    const form = document.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(mutations()).toHaveLength(1)
  expect(mutations()[0]).toMatchObject({ method: 'POST', body: { action: 'start', repository: 'acme/widgets' },
    init: { headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' } } })
  expect(input().disabled).toBe(true)
  expect(button(zh['launcher.starting']).disabled).toBe(true)
  expect(tabs()).toEqual([])
  await act(async () => { status = running(); reply.resolve(Response.json(status)) })
  expect(tabs()).toContain(zh['tab.overview'])
  expect(tabs()).toContain(zh['tab.execution'])
  expect(tabs()).toContain(zh['tab.settings'])
  expect(all('button').filter(item => item.textContent === zh.openMaster)).toHaveLength(1)
  await click(zh.openMaster)
  expect(opened).toHaveBeenCalledExactlyOnceWith('master')
  expect(requests.filter(request => request.url.startsWith('/orchestrator/api/')).length).toBeGreaterThan(0)
  expect(requests.every(request => new Headers(request.init.headers).get('x-orchestrator-request') === '1')).toBe(true)
})

it('continues local status polling when start returns a transitional state', async () => {
  vi.useFakeTimers()
  const starting = running({ phase: 'starting', panelAvailable: false, masterId: null })
  answer = async request => Response.json(request.method === 'POST' ? starting : status)
  await mount()
  await type('acme/widgets')
  await click(zh['launcher.start'])
  expect(input().disabled).toBe(true)
  expect(tabs()).toEqual([])
  status = running()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(tabs()).toContain(zh['tab.overview'])
  expect(controlRequests().map(request => request.method)).toEqual(['GET', 'POST', 'GET'])
})

it('keeps settings and tickets available when the runtime needs setup, and disables a missing master link', async () => {
  status = running({ phase: 'needs-setup', masterId: null, error: 'GitHub sign-in is required' })
  await mount()
  expect(bodyText()).toContain(zh['launcher.phase.needs-setup'])
  expect(bodyText()).toContain('GitHub sign-in is required')
  expect(button(zh.openMaster).disabled).toBe(true)
  expect(button(zh['launcher.stop']).disabled).toBe(false)
  await click(zh['tab.settings'])
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(zh['tab.settings'])
  expect(server.requests.some(request => request.path === 'settings')).toBe(true)
  await click(zh['tab.execution'])
  expect(server.requests.some(request => request.path.startsWith('tickets'))).toBe(true)
})

it.each(['starting', 'stopping'] as const)('shows Host %s state with no active panel or available mutations', async phase => {
  status = running({ phase, panelAvailable: false, masterId: null })
  await mount()
  expect(bodyText()).toContain(zh[`launcher.phase.${phase}`])
  expect(tabs()).toEqual([])
  if (phase === 'starting') {
    expect(input().disabled).toBe(true)
    expect(button(zh['launcher.starting']).disabled).toBe(true)
  } else {
    expect(button(zh['launcher.stop']).disabled).toBe(true)
    expect(button(zh.openMaster).disabled).toBe(true)
  }
  expect(mutations()).toHaveLength(0)
})

it('shows a rejected start, preserves the repository and allows an explicit retry', async () => {
  answer = async request => request.method === 'POST' ? Response.json({ error: 'gh was not found on PATH' }, { status: 400 })
    : Response.json(status)
  await mount()
  await type('acme/widgets')
  await click(zh['launcher.start'])
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('gh was not found on PATH')
  expect(input().value).toBe('acme/widgets')
  expect(button(zh['launcher.start']).disabled).toBe(false)
  expect(tabs()).toEqual([])
  expect(mutations()).toHaveLength(1)
  answer = async request => Response.json(request.method === 'POST' ? running() : status)
  await click(zh['launcher.start'])
  expect(mutations()).toHaveLength(2)
  expect(tabs()).toContain(zh['tab.overview'])
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it.each(['offline', 'invalid', 'rejected'] as const)('shows an initial %s status failure and retries with GET only', async kind => {
  answer = async () => {
    if (kind === 'offline') throw new TypeError('Failed to fetch')
    return kind === 'invalid' ? Response.json({ phase: 'running' }) : Response.json({ error: 'Status temporarily unavailable' }, { status: 503 })
  }
  await mount()
  await type('acme/widgets')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(kind === 'offline' ? zh['launcher.offline']
    : kind === 'invalid' ? zh['launcher.invalidResponse'] : 'Status temporarily unavailable')
  expect(button(zh['launcher.start']).disabled).toBe(true)
  expect(tabs()).toEqual([])
  answer = async () => Response.json(idle())
  await click(zh['launcher.refresh'])
  expect(button(zh['launcher.start']).disabled).toBe(false)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(controlRequests().map(request => request.method)).toEqual(['GET', 'GET'])
})

it('stops once with the stated worker/polling impact and unmounts the management panel while stopping', async () => {
  vi.useFakeTimers()
  status = running()
  const reply = deferred<Response>()
  answer = async request => request.method === 'POST' ? reply.promise : Response.json(status)
  await mount()
  const stop = button(zh['launcher.stop'])
  expect(document.getElementById(stop.getAttribute('aria-describedby')!)?.textContent).toBe(zh['launcher.stopHint'])
  await act(async () => { stop.click(); stop.click() })
  expect(mutations().map(request => request.body)).toEqual([{ action: 'stop' }])
  expect(button(zh['launcher.stop']).disabled).toBe(true)
  expect(button(zh.openMaster).disabled).toBe(true)
  expect(tabs()).toEqual([])
  const panelRequests = server.requests.length
  await act(async () => { status = idle('acme/widgets'); reply.resolve(Response.json(status)) })
  expect(input().value).toBe('acme/widgets')
  expect(button(zh['launcher.start']).disabled).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(server.requests).toHaveLength(panelRequests)
  expect(mutations()).toHaveLength(1)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('shows a Host startup error status and permits another explicit attempt', async () => {
  answer = async request => Response.json(request.method === 'POST'
    ? { ...idle('acme/widgets'), phase: 'error', error: 'Repository access check failed' } : status)
  await mount()
  await type('acme/widgets')
  await click(zh['launcher.start'])
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Repository access check failed')
  expect(bodyText()).toContain(zh['launcher.phase.error'])
  expect(button(zh['launcher.start']).disabled).toBe(false)
  expect(tabs()).toEqual([])
  expect(mutations()).toHaveLength(1)
})

it('returns to idle after a Host restart without automatically restarting the remembered repository', async () => {
  vi.useFakeTimers()
  status = running()
  await mount()
  status = idle('acme/widgets')
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(tabs()).toEqual([])
  expect(input().value).toBe('acme/widgets')
  expect(bodyText()).toContain(zh['launcher.remembered'])
  const panelRequests = server.requests.length
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(server.requests).toHaveLength(panelRequests)
  expect(mutations()).toHaveLength(0)
})

it('serializes status reads, backs off while hidden and clears the scheduled poll on unmount', async () => {
  vi.useFakeTimers()
  await mount()
  const reply = deferred<Response>()
  answer = async () => reply.promise
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(requests).toHaveLength(2)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { reply.resolve(Response.json(idle())) })
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999) })
  expect(requests).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(requests).toHaveLength(3)
  unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(requests).toHaveLength(3)
})

it('aborts the browser start request on unmount and ignores its late success', async () => {
  vi.useFakeTimers()
  const reply = deferred<Response>()
  answer = async request => request.method === 'POST' ? reply.promise : Response.json(status)
  await mount()
  await type('acme/widgets')
  await click(zh['launcher.start'])
  const mutation = mutations()[0]!
  unmount()
  expect(mutation.init.signal?.aborted).toBe(true)
  await act(async () => { reply.resolve(Response.json(running())); await vi.advanceTimersByTimeAsync(60_000) })
  expect(requests.map(request => request.method)).toEqual(['GET', 'POST'])
  expect(server.requests).toHaveLength(0)
})

it('reports a stop failure and restores the available panel for retry', async () => {
  status = running()
  answer = async request => request.method === 'POST' ? Response.json({ error: 'Worker shutdown failed' }, { status: 500 })
    : Response.json(status)
  await mount()
  await click(zh['launcher.stop'])
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Worker shutdown failed')
  expect(button(zh['launcher.stop']).disabled).toBe(false)
  expect(tabs()).toContain(zh['tab.overview'])
})

it('ignores a stale idle poll after an explicit start and aborts that stale request', async () => {
  vi.useFakeTimers()
  await mount()
  await type('acme/widgets')
  const oldRead = deferred<Response>()
  answer = async request => request.method === 'GET' ? oldRead.promise : Response.json(running())
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  const polling = controlRequests().at(-1)!
  await click(zh['launcher.start'])
  expect(polling.init.signal?.aborted).toBe(true)
  await act(async () => { oldRead.resolve(Response.json(idle())) })
  expect(tabs()).toContain(zh['tab.overview'])
  expect(document.querySelector('.dt-launch-card')).toBeNull()
})

it('removes polling and aborts an in-flight request when the panel is closed', async () => {
  vi.useFakeTimers()
  const reply = deferred<Response>()
  answer = async () => reply.promise
  await mount()
  const request = controlRequests()[0]!
  unmount()
  expect(request.init.signal?.aborted).toBe(true)
  await act(async () => { reply.resolve(Response.json(running())); await vi.advanceTimersByTimeAsync(60_000) })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(requests).toHaveLength(1)
  expect(document.querySelector('.dt-launcher')).toBeNull()
})

it('renders English copy and reports navigation failures without issuing control mutations', async () => {
  status = running()
  opened.mockRejectedValueOnce(new Error('Session list not ready'))
  await mount(undefined, en)
  expect(bodyText()).toContain(en['launcher.executor'])
  expect(bodyText()).toContain(en['launcher.stopHint'])
  await click(en.openMaster)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Session list not ready')
  expect(button(en.openMaster).disabled).toBe(false)
  expect(mutations()).toHaveLength(0)
})

it('mounts the launcher through the existing main slot and opens the separate master via workspace navigation', async () => {
  type Entry = { options: { name: string }; Component: ComponentType<{ t: T }> }
  const entries: Entry[] = [], t = translator(zh), open = vi.fn()
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(),
      register: (options: Entry['options'], Component: Entry['Component']) => { entries.push({ options, Component }); return () => {} } },
    locale: { register: () => () => {}, bind: () => t }, effect: (effect: () => unknown) => effect(), get: () => undefined,
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { master: {} } }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: open },
  }
  apply(ctx as never)
  const Main = entries.find(entry => entry.options.name === 'main')!.Component
  await mount(<Main t={t} />)
  expect(requests).toHaveLength(1)
  expect(bodyText()).toContain(zh['launcher.title'])
  await type('acme/widgets')
  await click(zh['launcher.start'])
  await click(zh.openMaster)
  expect(open).toHaveBeenCalledExactlyOnceWith('master')
  expect(mutations()).toHaveLength(1)
})
