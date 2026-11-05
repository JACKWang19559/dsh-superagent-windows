import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import * as github from '../src/sources/github.ts'
import * as feishu from '../src/sources/feishu.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import { deferred, track } from './fixtures/async.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const plugins = [{ kind: 'github', plugin: github }, { kind: 'feishu', plugin: feishu }] as const
function host() {
  const ctx = new Context(), board = new HealthBoard(), ready = deferred()
  contexts.push(ctx)
  const configured = vi.fn(() => { throw new Error('Source read deployment after unloading') })
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  ctx.provide('orchestrator', { sources, context: (kind: { kind: string; health: readonly string[] }) => {
    const entries = sources.healthEntries(kind.health)
    return { ready: ready.promise, configured, report: (name: string, health: Health) => { entries.get(name)?.set(health) } } as unknown as SourceContext
  } })
  return { ctx, board, ready, configured }
}

for (const { kind, plugin } of plugins) {
  it.each(['resolve', 'reject'] as const)(`${kind} unloads while ready is pending and ignores its late %s`, async outcome => {
    const { ctx, board, ready, configured } = host()
    const fiber = ctx.plugin(plugin)
    await fiber
    const stopped = track(fiber.dispose())
    try {
      await vi.waitFor(() => expect(stopped.settled).toBe(true), { timeout: 1000 })
      expect(stopped.error).toBeUndefined()
      expect(board.all).toEqual({})
    } finally {
      if (outcome === 'resolve') ready.resolve()
      else ready.reject(new Error('retired runtime failed'))
      await ready.promise.catch(() => {})
      await stopped.promise
    }
    await Promise.resolve()
    expect(configured).not.toHaveBeenCalled()
    expect(board.all).toEqual({})
    expect(ctx.logger.buffer.filter(message => message.type === 'error')).toEqual([])
  })

  it(`${kind} reports a ready rejection and still releases its Source registration`, async () => {
    const { ctx, board, ready, configured } = host()
    const fiber = ctx.plugin(plugin)
    await fiber
    ready.reject(new Error('startup failed'))
    await vi.waitFor(() => expect(board.all[kind]).toMatchObject({ state: 'error', detail: 'Error: startup failed' }))
    if (kind === 'feishu') expect(board.all.history).toMatchObject({ state: 'error', detail: 'Error: startup failed' })
    await fiber.dispose()
    expect(configured).not.toHaveBeenCalled()
    expect(board.all).toEqual({})
  })
}
