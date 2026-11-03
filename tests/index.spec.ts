import { expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

// Capture the dormant controller's configuration without constructing a Runtime.
const controls = vi.hoisted(() => [] as { machine: Machine; start: ReturnType<typeof vi.fn> }[])
vi.mock('../src/on-demand/host.ts', () => ({ SuperagentControl: class {
  start = vi.fn()
  constructor(_ctx: unknown, readonly machine: Machine) { controls.push(this) }
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = controls.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('mounts the Host controller without starting a repository or restarting its owner', async () => {
  const { ctx } = context()
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  expect(controls.at(-1)!.start).not.toHaveBeenCalled()
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
  expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('Superagent is idle'))
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})
