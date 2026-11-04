// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectPanel, type ProjectPanelProps } from '../src/client/project.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { ProjectView } from '../src/on-demand/project-types.ts'
import type { T } from '../src/client/text.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, values: Record<string, unknown> = {}) => zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))) as T
const views: (() => void)[] = []
afterEach(() => { for (const dispose of views.splice(0)) dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })
const project = (sessionId = 'session-a', overrides: Partial<ProjectView> = {}): ProjectView => ({
  sessionId, workspace: { id: 'workspace-a', title: 'Widgets', path: 'D:/Projects/widgets', source: 'registry' },
  repository: 'acme/widgets', branch: 'feature/ui', defaultBranch: 'main', source: 'git', reason: null, status: null,
  history: { entries: [], limit: 30, error: null }, summary: null, summaryError: null, error: null, ...overrides,
})
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function mount(props: Partial<ProjectPanelProps> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const defaults = { sessionId: 'session-a', t, openSession: vi.fn(async () => {}), startSession: vi.fn() }
  let current = { ...defaults, ...props }
  await act(async () => { root.render(<ProjectPanel {...current} />) })
  await settle()
  const dispose = () => { act(() => { root.unmount() }); container.remove() }
  views.push(dispose)
  return { container, props: current, update: async (next: Partial<ProjectPanelProps>) => {
    current = { ...current, ...next }
    await act(async () => { root.render(<ProjectPanel {...current} />) })
  } }
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!

it('renders the selected project and its saved work without global management calls or mutations', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(project('session-a', { summary: {
    source: 'saved', counts: { total: 3, open: 2, person: 1, working: 1, idle: 0, ended: 1 },
    recentTickets: [{ id: 'ticket-one', title: 'Fix project navigation', stage: { stage: 'person', action: 'review' },
      updatedAt: '2026-11-04T01:00:00.000Z', workerSessionId: 'worker-one' }],
    maxWorkers: 3, paused: true, masterId: 'master-one', updatedAt: '2026-11-04T01:00:00.000Z',
  } }))))
  const { container, props } = await mount()
  expect(container.textContent).toContain('acme/widgets')
  expect(container.textContent).toContain('feature/ui')
  expect(container.textContent).toContain('Fix project navigation')
  expect(container.textContent).toContain(zh['project.savedHint'])
  expect(container.textContent).toContain(zh['project.paused'])
  expect(container.querySelector('input')).toBeNull()
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1)
  expect(vi.mocked(fetch).mock.calls[0]).toEqual(['/orchestrator/project?sessionId=session-a', expect.objectContaining({ method: 'GET', headers: { 'x-orchestrator-request': '1' } })])
  await act(async () => { button(container, zh['project.openWorker']).click() })
  expect(props.openSession).toHaveBeenCalledExactlyOnceWith('worker-one')
  expect(props.startSession).not.toHaveBeenCalled()
})

it('drops the previous project immediately on Session change and ignores late responses', async () => {
  let finishOld: (value: Response) => void = () => {}
  let oldSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith('session-a')) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finishOld = resolve }) }
    return Promise.resolve(Response.json(project('session-b', { repository: 'other/project', workspace: { id: 'workspace-b', title: 'Other', path: '/other', source: 'registry' } })))
  }))
  const view = await mount()
  await view.update({ sessionId: 'session-b' }); await settle()
  expect(oldSignal?.aborted).toBe(true)
  expect(view.container.textContent).toContain('other/project')
  await act(async () => { finishOld(Response.json(project())) })
  expect(view.container.textContent).not.toContain('acme/widgets')
  expect(view.container.textContent).toContain('other/project')
})

it('does not preserve another Session’s already loaded data while the new request is pending', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('session-a') ? Promise.resolve(Response.json(project())) : new Promise<Response>(() => {})))
  const view = await mount()
  expect(view.container.textContent).toContain('acme/widgets')
  await view.update({ sessionId: 'session-b' })
  expect(view.container.textContent).not.toContain('acme/widgets')
  expect(view.container.textContent).toContain(zh['project.loading'])
})

it('rejects a response naming another Session, offers refresh, and recovers', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(project('wrong-session'))).mockResolvedValueOnce(Response.json(project())))
  const { container } = await mount()
  expect(container.textContent).toContain(zh['project.invalid'])
  expect(container.textContent).not.toContain('acme/widgets')
  await act(async () => { button(container, zh['launcher.refresh']).click() }); await settle()
  expect(container.textContent).toContain('acme/widgets')
  expect(container.textContent).not.toContain(zh['project.invalid'])
})

it.each([
  { repository: 'other/project', branch: 'feature/ui' },
  { repository: 'acme/widgets', branch: 'other-branch' },
])('rejects mixed-project run data even if the Session id matches: %j', async target => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(project('session-a', { status: {
    phase: 'running', executor: 'harness', ...target, lastRepository: target.repository, lastBranch: target.branch,
    masterId: 'other-master', consoleId: 'other-console', panelAvailable: true, error: null,
  } }))))
  const { container } = await mount()
  expect(container.textContent).toContain(zh['project.invalid'])
  expect(container.textContent).not.toContain(target.repository)
  expect(container.textContent).not.toContain(zh['launcher.phase.running'])
})

it('shows an explicit unresolved state and never substitutes a global repository', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(project('session-a', { repository: null, branch: null, reason: 'ambiguous-remotes' }))))
  const { container } = await mount()
  expect(container.textContent).toContain(zh['project.reason.ambiguous-remotes'])
  expect(container.textContent).not.toContain('acme/widgets')
  expect(container.textContent).toContain(zh['project.noHistory'])
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('/orchestrator/project?'))).toBe(true)
})

it('opens only project history sessions and reports navigation failures inline', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(project('session-a', { history: { limit: 30, error: null, entries: [{
    id: 'run-one', repository: 'acme/widgets', branch: 'feature/ui', phase: 'stopped', consoleId: 'console-one', masterId: null,
    startedAt: '2026-11-04T00:00:00.000Z', endedAt: '2026-11-04T01:00:00.000Z', error: null,
  }] } }))))
  const openSession = vi.fn(async () => { throw new Error('Session no longer exists') })
  const { container } = await mount({ openSession })
  expect(container.textContent).toContain(zh['launcher.phase.stopped'])
  await act(async () => { button(container, zh['launcher.openConsole']).click() })
  expect(openSession).toHaveBeenCalledExactlyOnceWith('console-one')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Session no longer exists')
})

it('keeps project status available when only saved ticket data failed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(project('session-a', {
    status: { phase: 'running', executor: 'harness', repository: 'acme/widgets', branch: 'feature/ui', lastRepository: 'acme/widgets',
      lastBranch: 'feature/ui', masterId: 'master-one', consoleId: 'console-one', panelAvailable: true, error: null },
    summaryError: 'Unsupported saved schema',
  }))))
  const { container } = await mount()
  expect(container.textContent).toContain(zh['launcher.phase.running'])
  expect(container.textContent).toContain('Unsupported saved schema')
  expect(button(container, zh.openMaster)).toBeDefined()
})

it('localizes the startup instruction and preserves special branch characters in a usable URL', async () => {
  const english = ((key: keyof typeof en, values: Record<string, unknown> = {}) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))) as T
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(project('session-a', { branch: 'feature/#修复' }))))
  const { container } = await mount({ t: english })
  expect(container.querySelector('code')?.textContent).toBe('Start Superagent for https://github.com/acme/widgets/tree/feature/%23%E4%BF%AE%E5%A4%8D')
})

it('reports an unavailable Host route without claiming the repository is running', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
  const { container } = await mount()
  expect(container.textContent).toContain(zh['project.unavailable'])
  expect(container.textContent).not.toContain(zh['launcher.phase.running'])
})
