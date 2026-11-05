import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, type Machine } from '../src/deployment.ts'
import * as plugin from '../src/index.ts'
import { deferred, track } from './fixtures/async.ts'

const stateDir = join(tmpdir(), 'superagent-index-state')
interface StubRuntime {
  ctx: Context; machine: Machine; restart: () => void; ready: Promise<void>; stop: ReturnType<typeof vi.fn>
}
// Substitute Runtime business work only: every service lookup, provider, injection, Loader and fiber is real Cordis.
const state = vi.hoisted(() => ({ runtimes: [] as StubRuntime[], initialize: undefined as ((ctx: Context) => Promise<void>) | undefined,
  stopError: undefined as Error | undefined }))
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  readonly ready: Promise<void>
  stop = vi.fn(async () => { if (state.stopError) throw state.stopError })
  constructor(readonly ctx: Context, readonly machine: Machine, readonly restart: () => void) {
    this.ready = state.initialize?.(ctx) ?? Promise.resolve()
    state.runtimes.push(this)
  }
  configured() { return true }
} }))
/** Simulate the Cordis loader committing a volatile configuration value in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }
const contexts: Context[] = []
function host() {
  const ctx = new Context()
  contexts.push(ctx)
  for (const name of plugin.inject) ctx.provide(name, {})
  const configure = vi.fn(() => () => {}), describe = vi.fn(() => [])
  ctx.provide('settings', { configure, describe })
  return { ctx, configure, describe }
}
const messages = (ctx: Context) => ctx.logger.buffer.map(message => message.args.map(String).join(' '))
beforeEach(() => { state.runtimes.length = 0; state.initialize = undefined; state.stopError = undefined })
afterEach(async () => {
  state.stopError = undefined
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

it('reads a volatile limit without restarting and suppresses the generated settings page', async () => {
  const { ctx, configure } = host()
  const config = { stateDir, promptMaxChars: 5000 }
  const fiber = ctx.plugin(plugin, config)
  await fiber
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, fiber.ctx.fiber)
  const { machine } = state.runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(fiber.ctx.fiber.config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(state.runtimes).toHaveLength(1)
})

it('refreshes the settings descriptor after a real fiber restart completes', async () => {
  const { ctx, describe } = host()
  await ctx.plugin(plugin, { stateDir })
  state.runtimes[0]!.restart()
  await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(1))
  expect(state.runtimes).toHaveLength(2)
  expect(state.runtimes[0]!.stop).toHaveBeenCalledTimes(1)
})

it('refuses obsolete configuration keys before publishing the execution provider', async () => {
  const { ctx } = host()
  await expect(plugin.apply(ctx, Config({ stateDir, github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.get('superagentExecution')).toBeUndefined()
  expect(state.runtimes).toHaveLength(0)
})

it('activates its strict provider before ready and reports and cleans a ready failure', async () => {
  const { ctx } = host(), ready = deferred()
  state.initialize = () => ready.promise
  const fiber = ctx.plugin(plugin, { stateDir })
  await fiber
  expect(fiber.ctx.fiber.state).toBe(2 /* ACTIVE */)
  expect(ctx.get('superagentExecution')).toBeDefined()
  expect(messages(ctx).some(message => message.includes('dsh-superagent ready;'))).toBe(false)
  ready.reject(new Error('router mount failed'))
  await vi.waitFor(() => expect(state.runtimes[0]!.stop).toHaveBeenCalledTimes(1))
  expect(messages(ctx)).toContain('dsh-superagent startup failed: %s Error: router mount failed')
  expect(messages(ctx).some(message => message.includes('dsh-superagent ready;'))).toBe(false)
})

it('consumes and reports a failure of startup cleanup', async () => {
  const { ctx } = host()
  state.stopError = new Error('flush failed')
  state.initialize = () => Promise.reject(new Error('preset unavailable'))
  await ctx.plugin(plugin, { stateDir })
  await vi.waitFor(() => expect(messages(ctx)).toContain('dsh-superagent startup cleanup failed: %s Error: flush failed'))
})

it.each(['resolve', 'reject'] as const)('suppresses a disposed instance’s late ready %s after reload', async outcome => {
  const { ctx } = host(), oldReady = deferred()
  state.initialize = () => oldReady.promise
  const fiber = ctx.plugin(plugin, { stateDir })
  await fiber
  const old = state.runtimes[0]!
  state.initialize = () => Promise.resolve()
  await fiber.ctx.fiber.restart()
  const current = state.runtimes[1]!
  await vi.waitFor(() => expect(messages(ctx).filter(message => message.includes('dsh-superagent ready;'))).toHaveLength(1))
  const before = messages(ctx)
  if (outcome === 'resolve') oldReady.resolve()
  else oldReady.reject(new Error('retired startup failed'))
  await oldReady.promise.catch(() => {})
  await Promise.resolve()
  expect(messages(ctx)).toEqual(before)
  expect(old.stop).toHaveBeenCalledTimes(1)
  expect(current.stop).not.toHaveBeenCalled()
})

it.each([false, true])('settles npm Loader and the real preset registry with missing dependency=%s', async missing => {
  const { ctx } = host()
  ctx.provide('sessionProjections', { register: vi.fn(() => () => {}) })
  await ctx.plugin(Loader)
  await ctx.plugin(AgentPresetRegistry, { default: 'router' })
  const execution = vi.fn((child: Context) => { expect(child.superagentExecution).toBeDefined() })
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.execution = { name: 'test-execution', inject: ['superagentExecution', ...missing ? ['missingPresetService'] : []], apply: (child: Context) => { execution(child) } }
  ctx.loader.builtins.superagent = plugin
  const unregister = await ctx.agentPresets.register({ id: 'router', plugins: [
    { name: 'cordis:group', group: true, config: [{ name: 'cordis:execution' }] },
  ] })
  expect(execution).not.toHaveBeenCalled()
  let strictProviderAtStart: unknown
  state.initialize = async child => {
    strictProviderAtStart = child.root.get('superagentExecution')
    const lease = await child.get('agentPresets')!.acquireScope('router')
    await lease[Symbol.asyncDispose]()
  }
  try {
    await ctx.loader.root.update([{ id: 'superagent', name: 'cordis:superagent', config: { stateDir } }])
    const settled = track(ctx.loader.await())
    await vi.waitFor(() => expect(settled.settled).toBe(true), { timeout: 2000 })
    const runtime = state.runtimes[0]!
    const initialized = track(runtime.ready)
    await vi.waitFor(() => expect(initialized.settled).toBe(true), { timeout: 2000 })
    expect(strictProviderAtStart).toBeUndefined()
    expect(ctx.loader.resolve('superagent').fiber!.state).toBe(2 /* ACTIVE */)
    if (missing) {
      expect(initialized.error).toMatchObject({ message: expect.stringContaining('missingPresetService') })
      await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1))
      expect(execution).not.toHaveBeenCalled()
      expect(messages(ctx).some(message => message.includes('dsh-superagent startup failed:'))).toBe(true)
    } else {
      expect(initialized.error).toBeUndefined()
      expect(execution).toHaveBeenCalledTimes(1)
      expect(messages(ctx).some(message => message.includes('dsh-superagent ready;'))).toBe(true)
    }
    await ctx.loader.resolve('superagent').fiber!.dispose()
  } finally { await unregister() }
})
