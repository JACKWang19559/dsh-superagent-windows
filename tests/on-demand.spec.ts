import { Context } from '@deepseek-ai/cordis'
import * as githubPlugin from '../src/sources/github.ts'
import * as feishuPlugin from '../src/sources/feishu.ts'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { apply as applyHost } from '../src/index.ts'
import { Store } from '../src/app/store.ts'
import { Setup } from '../src/app/setup.ts'
import { testMachine } from './fixtures/deployment.ts'
import { Launcher, type ActiveRun } from '../src/on-demand/controller.ts'
import { defaultPrepare, initializeRepository, rememberedRepository, repositoryDirectory } from '../src/on-demand/host.ts'
import { registerLaunchHttp } from '../src/on-demand/http.ts'
import { apply as applyPreset, LAUNCH_GUIDANCE, ControlArguments } from '../src/on-demand/preset.ts'

const temporary: string[] = []
const contexts: Context[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'superagent-demand-')); temporary.push(path); return path }
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); vi.restoreAllMocks(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const running = (): ActiveRun => ({ view: () => ({ phase: 'running', masterId: 'master', panelAvailable: true, error: null }), stop: vi.fn(async () => {}) })

it('stays inert with remembered repository until an explicit start, including concurrent same-repository requests', async () => {
  const gate = deferred(), active = running()
  const factory = vi.fn(async () => { await gate.promise; return active })
  const control = new Launcher(factory, 'acme/widgets')
  expect(control.status()).toMatchObject({ phase: 'idle', lastRepository: 'acme/widgets', repository: null })
  expect(factory).not.toHaveBeenCalled()
  const first = control.start('acme/widgets'), second = control.start('ACME/widgets')
  expect(control.status().phase).toBe('starting')
  await expect(control.start('other/repository')).rejects.toThrow('Stop it')
  gate.resolve()
  expect(await first).toMatchObject({ phase: 'running', masterId: 'master' })
  expect(await second).toEqual(await control.start('acme/widgets'))
  expect(factory).toHaveBeenCalledTimes(1)
  await control.stop()
  expect(active.stop).toHaveBeenCalledTimes(1)
  expect(control.status()).toMatchObject({ phase: 'idle', repository: null, lastRepository: 'acme/widgets' })
})

it('cancels startup, waits for cleanup, rejects racing starts, then permits a fresh repository', async () => {
  const gate = deferred(), active = running()
  const factory = vi.fn(async () => { await gate.promise; return active })
  const control = new Launcher(factory)
  const start = control.start('acme/widgets'), stop = control.stop(), anotherStop = control.stop()
  expect(control.status().phase).toBe('stopping')
  await expect(control.start('acme/widgets')).rejects.toThrow('stopping')
  gate.resolve(); await start
  expect(await stop).toEqual(await anotherStop)
  expect(active.stop).toHaveBeenCalledTimes(1)
  expect((await control.start('other/repo')).phase).toBe('running')
  await control.dispose()
  await expect(control.start('acme/widgets')).rejects.toThrow('unloading')
})

it('makes failed startup and failed stop recoverable without hiding the error', async () => {
  const active = running()
  const factory = vi.fn().mockRejectedValueOnce(new Error('No gh login')).mockResolvedValue(active)
  const control = new Launcher(factory)
  expect(await control.start('acme/widgets')).toMatchObject({ phase: 'error', repository: null, error: 'No gh login' })
  expect((await control.start('acme/widgets')).phase).toBe('running')
  vi.mocked(active.stop).mockRejectedValueOnce(new Error('Flush failed'))
  await expect(control.stop()).rejects.toThrow('Flush failed')
  expect(control.status()).toMatchObject({ phase: 'error', repository: 'acme/widgets', error: 'Flush failed' })
  expect((await control.stop()).phase).toBe('idle')
})

it.each(['', '../repo', 'owner/..', 'https://evil.example/acme/widgets', 'owner/repo; command'])('rejects an ambiguous repository %s before any work', async repository => {
  const factory = vi.fn()
  await expect(new Launcher(factory).start(repository)).rejects.toThrow()
  expect(factory).not.toHaveBeenCalled()
})

it('passes the full slash branch to its runtime, deduplicates the same target, and rejects switching branches while active', async () => {
  const active = running(), factory = vi.fn(async () => active), control = new Launcher(factory)
  const url = 'https://github.com/5th-Axiom/VideoInWay/tree/codex/video-editing'
  expect(await control.start(url)).toMatchObject({ repository: '5th-Axiom/VideoInWay', branch: 'codex/video-editing', lastBranch: 'codex/video-editing' })
  expect(factory).toHaveBeenCalledWith({ repository: '5th-Axiom/VideoInWay', branch: 'codex/video-editing' }, expect.any(AbortSignal))
  await control.start('https://github.com/5th-axiom/videoinway/tree/codex%2Fvideo-editing')
  expect(factory).toHaveBeenCalledTimes(1)
  for (const other of ['5th-Axiom/VideoInWay', url.replace('codex', 'Codex'), url.replace('video-editing', 'other')]) {
    await expect(control.start(other)).rejects.toThrow('Stop it')
  }
  expect(await control.stop()).toMatchObject({ repository: null, branch: null, lastRepository: '5th-Axiom/VideoInWay', lastBranch: 'codex/video-editing' })
  expect(await control.start('5th-Axiom/VideoInWay')).toMatchObject({ branch: null, lastBranch: null })
  await control.dispose()
})

it('remembers a branch without starting, reads legacy launcher files, and ignores invalid saved refs', () => {
  const root = directory(), path = join(root, 'launcher.json'), factory = vi.fn()
  writeFileSync(path, JSON.stringify({ repository: '5th-Axiom/VideoInWay', branch: 'codex/video-editing' }))
  const saved = rememberedRepository(root)
  expect(saved).toBe('https://github.com/5th-Axiom/VideoInWay/tree/codex/video-editing')
  expect(new Launcher(factory, saved).status()).toMatchObject({ phase: 'idle', repository: null, branch: null, lastBranch: 'codex/video-editing' })
  expect(factory).not.toHaveBeenCalled()
  writeFileSync(path, JSON.stringify({ repository: 'acme/widgets' }))
  expect(rememberedRepository(root)).toBe('acme/widgets')
  writeFileSync(path, JSON.stringify({ repository: 'acme/widgets', branch: '../escape' }))
  expect(rememberedRepository(root)).toBeNull()
})

it('isolates branch state case-sensitively and preserves custom settings inside its matching namespace', () => {
  const root = directory(), repo = 'Acme/Widgets', branch = 'codex/video-editing'
  const state = repositoryDirectory(root, repo, branch)
  expect(state).toBe(repositoryDirectory(root, repo.toLowerCase(), branch))
  expect(state).not.toBe(repositoryDirectory(root, repo))
  expect(state).not.toBe(repositoryDirectory(root, repo, 'Codex/video-editing'))
  initializeRepository(state, repo, branch)
  const store = new Store(join(state, 'orchestrator.sqlite')), saved = store.settings()
  expect(saved.sources.github?.config.branch).toBe(branch)
  expect(saved.executor.prepare).toContain('DSH_SUPERAGENT_GITHUB_BASE_BRANCH')
  store.saveSettings({ ...saved, executor: { ...saved.executor, prepare: 'custom branch prepare' } }); store.close()
  initializeRepository(state, repo, branch)
  expect(() => initializeRepository(state, repo)).toThrow('branch does not match')
  const reopened = new Store(join(state, 'orchestrator.sqlite'))
  expect(reopened.settings().executor.prepare).toBe('custom branch prepare'); reopened.close()
})

it('separates repository state, preserves existing settings, and leaves the old root database unchanged', () => {
  const root = directory(), repo = repositoryDirectory(root, 'Acme/Widgets')
  expect(repo).toBe(repositoryDirectory(root, 'acme/widgets'))
  expect(repo).not.toBe(repositoryDirectory(root, 'other/widgets'))
  const original = new Store(join(root, 'orchestrator.sqlite'))
  original.saveSettings({ paused: true }); original.close()
  initializeRepository(repo, 'Acme/Widgets')
  const store = new Store(join(repo, 'orchestrator.sqlite'))
  const initial = store.settings()
  expect(initial.sources.github).toMatchObject({ enabled: true, config: { repository: 'Acme/Widgets', cli: 'gh' } })
  expect(initial.executor.prepare).toBe(defaultPrepare())
  store.saveSettings({ ...initial, executor: { ...initial.executor, prepare: 'custom command' } }); store.close()
  initializeRepository(repo, 'Acme/Widgets')
  expect(() => initializeRepository(repo, 'other/repository')).toThrow('does not match')
  const reopened = new Store(join(repo, 'orchestrator.sqlite'))
  expect(reopened.settings().executor.prepare).toBe('custom command'); reopened.close()
  const untouched = new Store(join(root, 'orchestrator.sqlite'))
  expect(untouched.settings().paused).toBe(true); untouched.close()
})

it('loading the Host and eager preset with valid saved configuration makes no probe, runtime, or startup request', async () => {
  const root = directory()
  initializeRepository(repositoryDirectory(root, 'acme/widgets'), 'acme/widgets')
  const ctx = new Context(); contexts.push(ctx)
  ctx.reflect.provide('webServer', { host: '127.0.0.1', port: 3082, register: vi.fn(() => () => {}) })
  const probe = vi.spyOn(Setup.prototype, 'run')
  await applyHost(ctx, testMachine({ stateDir: root }) as never)
  const start = vi.spyOn(ctx.superagentControl, 'start')
  const sourcePlugins = [ctx.plugin(githubPlugin), ctx.plugin(feishuPlugin)]
  await Promise.all(sourcePlugins.map(plugin => plugin.await()))
  expect(sourcePlugins.map(plugin => plugin.state)).toEqual([2, 2]) // Cordis FiberState.ACTIVE
  ctx.reflect.provide('tools', { register: vi.fn(() => () => {}) })
  ctx.reflect.provide('systemPrompt', { section: vi.fn(() => () => {}) })
  ctx.reflect.provide('permissionPresets', { current: () => 'danger-full-access' })
  applyPreset(ctx)
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    await agentEvents(ctx, { ctx, id: source } as never).serial('agent/created', { source: source as never })
  }
  await agentEvents(ctx, { ctx, id: 'fork', session: { header: { isSeeded: true } } } as never).serial('agent/created', { source: 'startup' })
  expect(ctx.superagentControl.status().phase).toBe('idle')
  expect(ctx.get('orchestrator')).toBeUndefined()
  expect(probe).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
})

it('scopes one bounded control tool, validates arguments, preserves permissions, and does not auto-start', async () => {
  const ctx = new Context(); contexts.push(ctx)
  const factory = vi.fn(async () => running()), control = new Launcher(factory)
  let definition: { execute: (args: unknown, execution: unknown) => Promise<unknown> } | undefined
  const permission = vi.fn(() => 'read-only')
  ctx.reflect.provide('superagentControl', control)
  ctx.reflect.provide('tools', { register: (tool: typeof definition) => { definition = tool; return () => {} } })
  ctx.reflect.provide('systemPrompt', { section: vi.fn(() => () => {}) })
  ctx.reflect.provide('permissionPresets', { current: permission })
  applyPreset(ctx)
  expect(factory).not.toHaveBeenCalled()
  expect(LAUNCH_GUIDANCE.length).toBeLessThan(1000)
  expect(ControlArguments.shape.action.options).toEqual(['status', 'start', 'stop'])
  expect(await definition!.execute({ action: 'status' }, {})).toMatchObject({ phase: 'idle' })
  const execution = { agent: { session: { header: {} } } }
  await expect(definition!.execute({ action: 'start', repository: 'acme/widgets' }, execution)).rejects.toThrow('Full access')
  expect(factory).not.toHaveBeenCalled()
  permission.mockReturnValue('danger-full-access')
  expect(await definition!.execute({ action: 'start', repository: 'acme/widgets' }, execution)).toMatchObject({ phase: 'running' })
  await expect(definition!.execute({ action: 'stop' }, { agent: { session: { header: { parentSession: 'worker' } } } })).rejects.toThrow('user Superagent')
  expect((await definition!.execute({ action: 'stop' }, execution) as { phase: string }).phase).toBe('idle')
})

it('keeps GET status immediate, rejects malformed and cross-origin operations, and shares start/stop with the tool', async () => {
  const control = new Launcher(vi.fn(async () => running()))
  let handler!: (req: unknown, res: unknown) => Promise<void>
  registerLaunchHttp({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } } as never, control)
  const call = async (method: string, body = '', headers: Record<string, string> = {}) => {
    let code = 0, value: unknown
    await handler({ method, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers },
      async *[Symbol.asyncIterator]() { yield Buffer.from(body) } },
    { writeHead: (status: number) => { code = status }, end: (text: string) => { value = JSON.parse(text) } })
    return { code, value }
  }
  expect(await call('GET')).toMatchObject({ code: 200, value: { phase: 'idle' } })
  expect((await call('POST', '{')).code).toBe(400)
  expect((await call('POST', JSON.stringify({ action: 'start', repository: 'acme/widgets' }), { origin: 'https://evil.example' })).code).toBe(403)
  expect((await call('POST', ' '.repeat(8193))).code).toBe(400)
  expect((await call('POST', JSON.stringify({ action: 'start', repository: 'acme/widgets' }))).value).toMatchObject({ phase: 'running' })
  expect((await call('POST', JSON.stringify({ action: 'start', repository: 'other/repo' }))).code).toBe(409)
  expect((await call('POST', JSON.stringify({ action: 'stop' }))).value).toMatchObject({ phase: 'idle' })
})
