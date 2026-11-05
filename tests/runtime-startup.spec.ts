import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as plugin from '../src/index.ts'
import type { Runtime } from '../src/app/runtime.ts'
import { Setup } from '../src/app/setup.ts'
import { Sessions } from '../src/app/sessions.ts'
import { Passes } from '../src/app/passes.ts'
import { Effects } from '../src/app/effects.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { deferred, track } from './fixtures/async.ts'

const contexts: Context[] = [], directories: string[] = []
beforeEach(() => { vi.spyOn(Setup.prototype, 'run').mockResolvedValue(false) })
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function host() {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-startup-'))
  directories.push(stateDir)
  const ctx = new Context()
  contexts.push(ctx)
  const routes: { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }[] = []
  const unregister = vi.fn(), flush = vi.fn(async () => {})
  const controller = { resolveAgent: vi.fn(async () => ({ error: { code: 'session/not-found' } })), create: vi.fn(async () => {}), rename: vi.fn(async () => {}) }
  const workspace = { create: vi.fn(async () => ({ id: 'workspace' })) }
  const services: Record<string, unknown> = { agents: new Map(), sessionController: controller, sessionPersistence: { flush }, workspaceRegistry: workspace,
    webServer: { host: '127.0.0.1', port: 3082, register: (route: typeof routes[number]) => { routes.push(route); return unregister } } }
  for (const name of plugin.inject) ctx.provide(name, services[name] ?? {})
  const start = async () => {
    const fiber = ctx.plugin(plugin, { stateDir })
    await fiber
    const runtime = ctx.get('orchestrator') as unknown as Runtime
    return { fiber, runtime }
  }
  return { ctx, stateDir, start, routes, unregister, controller, workspace, flush }
}
const loops = () => ({ passes: vi.spyOn(Passes.prototype, 'start'), effects: vi.spyOn(Effects.prototype, 'start'), resume: vi.spyOn(DshExecutor.prototype, 'resume') })

it('keeps HTTP behind the actual ready promise and preserves setupPending UI', async () => {
  const setup = deferred<boolean>()
  vi.mocked(Setup.prototype.run).mockReturnValue(setup.promise)
  const h = host(), { runtime } = await h.start()
  let status = 0, body = ''
  const request = track(h.routes[0]!.handler({ method: 'GET', url: '/orchestrator/api/state', headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } } as unknown as IncomingMessage,
    { writeHead: (value: number) => { status = value }, end: (value: string) => { body = value } } as unknown as ServerResponse))
  await Promise.resolve(); await Promise.resolve()
  expect(request.settled).toBe(false)
  setup.resolve(false)
  await runtime.ready
  await request.promise
  expect(status).toBe(200)
  expect(JSON.parse(body)).toMatchObject({ setup: { accounts: null }, health: { runtime: { state: 'paused', code: 'setupPending' } } })
})

it('disposes during setup without installing Sessions or starting loops on a late completion', async () => {
  const setup = deferred<boolean>(), installed = vi.spyOn(Sessions.prototype, 'install'), started = loops()
  vi.mocked(Setup.prototype.run).mockReturnValue(setup.promise)
  const h = host(), { fiber, runtime } = await h.start()
  const stopped = track(fiber.dispose())
  await vi.waitFor(() => expect(stopped.settled).toBe(true), { timeout: 1000 })
  expect(runtime.lifetime.aborted).toBe(true)
  expect(h.unregister).toHaveBeenCalledTimes(1)
  expect(() => runtime.store.settings()).toThrow()
  setup.resolve(true)
  await runtime.ready
  expect(installed).not.toHaveBeenCalled()
  for (const spy of Object.values(started)) expect(spy).not.toHaveBeenCalled()
})

it('disposes during real Session resolution and prevents late creation or closed-DB access', async () => {
  vi.mocked(Setup.prototype.run).mockResolvedValue(true)
  const resolution = deferred<{ error: { code: string } }>(), started = loops()
  const h = host()
  h.controller.resolveAgent.mockReturnValue(resolution.promise)
  const { fiber, runtime } = await h.start()
  await vi.waitFor(() => expect(h.controller.resolveAgent).toHaveBeenCalledTimes(1))
  const stopped = track(fiber.dispose())
  await vi.waitFor(() => expect(stopped.settled).toBe(true), { timeout: 1000 })
  vi.mocked(Setup.prototype.run).mockResolvedValue(false)
  const { runtime: next } = await h.start()
  await next.ready
  const errorsBefore = h.ctx.logger.buffer.filter(message => message.type === 'error')
  resolution.resolve({ error: { code: 'session/not-found' } })
  await expect(runtime.ready).rejects.toMatchObject({ name: 'AbortError' })
  expect(next.store.settings()).toBeDefined()
  expect(h.ctx.logger.buffer.filter(message => message.type === 'error')).toEqual(errorsBefore)
  expect(h.workspace.create).not.toHaveBeenCalled()
  expect(h.controller.create).not.toHaveBeenCalled()
  expect(h.controller.rename).not.toHaveBeenCalled()
  for (const spy of Object.values(started)) expect(spy).not.toHaveBeenCalled()
})

it('cancels an initializing policy sync before it can save to the closed database', async () => {
  const setup = deferred<boolean>(), sync = deferred<{ allowed: { id: string }[] }>(), started = loops()
  vi.mocked(Setup.prototype.run).mockReturnValue(setup.promise)
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(true)
  vi.spyOn(Sessions.prototype, 'ensure').mockResolvedValue({} as never)
  const run = vi.fn(() => sync.promise), label = { en: 'Pending', zh: 'Pending' }
  const kind: SourceKind = { kind: 'pending', title: label, description: label, schema: z.object({}), fields: [], health: [], policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string() })).default([]) }), fields: [], explicit: label,
    sync: { label, ready: () => true, run },
  } }
  const h = host(), { fiber, runtime } = await h.start()
  runtime.sources.register(kind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, pending: { enabled: true, config: {} } } })
  const save = vi.spyOn(runtime.settings, 'save')
  setup.resolve(true)
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  const stopped = track(fiber.dispose())
  await vi.waitFor(() => expect(stopped.settled).toBe(true), { timeout: 1000 })
  sync.resolve({ allowed: [{ id: 'late' }] })
  await runtime.ready
  expect(save).not.toHaveBeenCalled()
  expect(runtime.health['sync:pending']).not.toMatchObject({ state: 'error' })
  for (const spy of Object.values(started)) expect(spy).not.toHaveBeenCalled()
})

it('reclaims HTTP, Session hooks, database and lock after a ready failure, allowing a real reload', async () => {
  vi.mocked(Setup.prototype.run).mockResolvedValue(true)
  const ensure = vi.spyOn(Sessions.prototype, 'ensure').mockRejectedValue(new Error('router unavailable'))
  const started = loops(), h = host(), { fiber, runtime } = await h.start()
  await expect(runtime.ready).rejects.toThrow('router unavailable')
  await runtime.stop()
  expect(h.unregister).toHaveBeenCalledTimes(1)
  expect(h.flush).toHaveBeenCalledTimes(1)
  expect(() => runtime.store.settings()).toThrow()
  for (const spy of Object.values(started)) expect(spy).not.toHaveBeenCalled()
  ensure.mockResolvedValue({} as never)
  await fiber.ctx.fiber.restart()
  const next = h.ctx.get('orchestrator') as unknown as Runtime
  await next.ready
  expect(next).not.toBe(runtime)
  expect(next.store.settings()).toBeDefined()
  expect(h.ctx.logger.buffer.filter(message => message.type === 'error').map(message => message.args.join(' ')))
    .toContain('dsh-superagent startup failed: %s Error: router unavailable')
})

it('continues resource cleanup after executor shutdown fails', async () => {
  const h = host(), { runtime } = await h.start()
  await runtime.ready
  vi.spyOn(runtime.executor, 'shutdown').mockRejectedValue(new Error('jobs unavailable'))
  const sessions = vi.spyOn(runtime.sessions, 'dispose')
  await expect(runtime.stop()).rejects.toThrow('dsh-superagent shutdown failed')
  expect(sessions).toHaveBeenCalledTimes(1)
  expect(h.unregister).toHaveBeenCalledTimes(1)
  expect(h.flush).toHaveBeenCalledTimes(1)
  expect(() => runtime.store.settings()).toThrow()
})
