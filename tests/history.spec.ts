import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Launcher, LaunchFailure, LaunchRequestSchema, type ActiveRun } from '../src/on-demand/controller.ts'
import { HISTORY_LIMIT, LaunchHistoryStore } from '../src/on-demand/history.ts'
import { dispatch } from '../src/on-demand/http.ts'

const temporary: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'superagent-history-')); temporary.push(path); return path }
afterEach(() => { vi.restoreAllMocks(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const running = (): ActiveRun => ({ view: () => ({ phase: 'running', masterId: 'master-1', panelAvailable: true, error: null }), stop: vi.fn(async () => {}) })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const persistent = (factory = vi.fn(async () => running())) => {
  const root = directory(), file = join(root, 'history.json')
  return { root, file, factory, control: new Launcher(factory, null, new LaunchHistoryStore(file)) }
}

it('keeps history reads inert and detached, deduplicates starts, and preserves the first console', async () => {
  const gate = deferred(), factory = vi.fn(async () => { await gate.promise; return running() })
  const { control, root, file } = persistent(factory)
  expect(control.history()).toEqual({ entries: [], limit: 30, error: null })
  expect(readdirSync(root)).toEqual([])
  expect(factory).not.toHaveBeenCalled()
  const first = control.start('https://github.com/acme/widgets/tree/codex/video-editing', 'console-1')
  const duplicate = control.start('https://github.com/ACME/widgets/tree/codex/video-editing', 'console-2')
  await expect(control.start('other/repo')).rejects.toThrow('Stop it')
  await expect(control.start('../bad')).rejects.toThrow()
  expect(control.history().entries).toHaveLength(1)
  expect(control.history().entries[0]).toMatchObject({ repository: 'acme/widgets', branch: 'codex/video-editing', consoleId: 'console-1', phase: 'starting', masterId: null, endedAt: null })
  const before = readFileSync(file, 'utf8'), snapshot = control.history()
  snapshot.entries[0]!.repository = 'mutated/repo'; snapshot.entries.length = 0
  expect(control.history().entries[0]!.repository).toBe('acme/widgets')
  expect(readFileSync(file, 'utf8')).toBe(before)
  gate.resolve()
  expect(await first).toMatchObject({ phase: 'running', consoleId: 'console-1' })
  expect(await duplicate).toEqual(await control.start('https://github.com/acme/widgets/tree/codex/video-editing', 'console-3'))
  expect(factory).toHaveBeenCalledTimes(1)
  await control.stop()
  expect(control.history().entries[0]).toMatchObject({ phase: 'stopped', consoleId: 'console-1', masterId: 'master-1', endedAt: expect.any(String) })
  expect(readdirSync(root)).toEqual(['history.json'])
})

it('overlays live state without writing and clears resolved setup errors before persisting stop', async () => {
  let view: ReturnType<ActiveRun['view']> = { phase: 'needs-setup', masterId: null, panelAvailable: true, error: 'Authenticate gh' }
  const active: ActiveRun = { view: () => view, stop: vi.fn(async () => { view = { ...view, masterId: null } }) }
  const { control, file } = persistent(vi.fn(async () => active))
  await control.start('acme/widgets', 'console-setup')
  expect(control.history().entries[0]).toMatchObject({ phase: 'needs-setup', error: 'Authenticate gh' })
  const before = readFileSync(file, 'utf8')
  view = { phase: 'running', masterId: 'master-created-later', panelAvailable: true, error: null }
  expect(control.history().entries[0]).toMatchObject({ phase: 'running', masterId: 'master-created-later', error: null })
  expect(readFileSync(file, 'utf8')).toBe(before)
  await control.stop()
  const recovered = new LaunchHistoryStore(file).snapshot()
  expect(recovered.entries[0]).toMatchObject({ phase: 'stopped', masterId: 'master-created-later', error: null, endedAt: expect.any(String) })
})

it('recovers unfinished launches as interrupted, keeps unknown end times null, and stays cold', async () => {
  const { control, file } = persistent()
  await control.start('acme/widgets', 'console-before-restart')
  const before = readFileSync(file, 'utf8'), factory = vi.fn(async () => running())
  const recovered = new Launcher(factory, 'acme/widgets', new LaunchHistoryStore(file))
  expect(recovered.status()).toMatchObject({ phase: 'idle', repository: null })
  expect(recovered.history().entries[0]).toMatchObject({ phase: 'interrupted', endedAt: null, consoleId: 'console-before-restart', masterId: 'master-1' })
  expect(factory).not.toHaveBeenCalled()
  expect(readFileSync(file, 'utf8')).toBe(before)
  await recovered.start('other/repo', 'console-after-restart'); await recovered.stop()
  expect(new LaunchHistoryStore(file).snapshot().entries.map(entry => entry.phase)).toEqual(['stopped', 'interrupted'])
  await control.dispose() // The old writer detects the changed file and cannot replace the recovered history.
  expect(new LaunchHistoryStore(file).snapshot().entries).toHaveLength(2)
})

it('persists only the latest 30 actual attempts in newest-first order', async () => {
  const { control, file } = persistent()
  for (let index = 0; index < HISTORY_LIMIT + 3; index++) {
    await control.start(`acme/repo-${index}`, `console-${index}`); await control.stop()
  }
  const history = new LaunchHistoryStore(file).snapshot()
  expect(history.error).toBeNull()
  expect(history.entries).toHaveLength(30)
  expect(history.entries.map(entry => entry.repository)).toEqual(Array.from({ length: 30 }, (_, index) => `acme/repo-${32 - index}`))
  expect(new Set(history.entries.map(entry => entry.id)).size).toBe(30)
  expect(history.entries.every(entry => entry.phase === 'stopped' && entry.endedAt !== null)).toBe(true)
}, 30_000)

it('retains console and known master links for a failed startup without inventing a link', async () => {
  const factory = vi.fn().mockRejectedValueOnce(new Error('No gh login')).mockRejectedValueOnce(new LaunchFailure(new Error('Startup failed after creating master'), 'master-created'))
  const { control, file } = persistent(factory)
  await control.start('acme/widgets', 'console-failure'); await control.start('acme/widgets', 'console-retry')
  expect(new LaunchHistoryStore(file).snapshot().entries).toMatchObject([
    { phase: 'error', consoleId: 'console-retry', masterId: 'master-created', error: 'Startup failed after creating master', endedAt: expect.any(String) },
    { phase: 'error', consoleId: 'console-failure', masterId: null, error: 'No gh login', endedAt: expect.any(String) },
  ])
})

it('captures a late master during cancellation, waits for cleanup, and records a single ended attempt', async () => {
  const gate = deferred(), active = running()
  const { control, file } = persistent(vi.fn(async () => { await gate.promise; return active }))
  const start = control.start('acme/widgets', 'console-cancel'), stop = control.stop(), duplicateStop = control.stop()
  await expect(control.start('acme/widgets')).rejects.toThrow('stopping')
  gate.resolve(); await start
  expect(await stop).toEqual(await duplicateStop)
  expect(active.stop).toHaveBeenCalledTimes(1)
  expect(new LaunchHistoryStore(file).snapshot().entries).toMatchObject([
    { phase: 'stopped', consoleId: 'console-cancel', masterId: 'master-1', endedAt: expect.any(String) },
  ])
})

it('keeps failed stop visible and retryable, including cleanup after cancelled activation', async () => {
  const gate = deferred(), active = running()
  vi.mocked(active.stop).mockRejectedValueOnce(new Error('Flush failed'))
  const { control } = persistent(vi.fn(async () => { await gate.promise; return active }))
  const start = control.start('acme/widgets', 'console-cancel'), stop = control.stop()
  gate.resolve(); await start
  await expect(stop).rejects.toThrow('Flush failed')
  expect(control.history().entries[0]).toMatchObject({ phase: 'error', error: 'Flush failed', masterId: 'master-1', consoleId: 'console-cancel', endedAt: null })
  await control.stop()
  expect(control.history().entries[0]).toMatchObject({ phase: 'stopped', endedAt: expect.any(String), error: 'Flush failed' })
})

it('preserves failure metadata when cancellation cleanup fails before the factory returns a Runtime', async () => {
  const gate = deferred()
  const { control } = persistent(vi.fn(async () => { await gate.promise; throw new LaunchFailure(new Error('Cleanup failed'), 'known-master', true) }))
  const start = control.start('acme/widgets', 'console-cancel'), stop = control.stop()
  const startFailure = expect(start).rejects.toThrow('Cleanup failed'), stopFailure = expect(stop).rejects.toThrow('Cleanup failed')
  gate.resolve(); await Promise.all([startFailure, stopFailure])
  expect(control.history().entries[0]).toMatchObject({ phase: 'error', masterId: 'known-master', consoleId: 'console-cancel', error: 'Cleanup failed' })
  await control.stop()
})

it('reports a write failure while allowing stop and preserving the previous complete file', async () => {
  const active = running(), { control, root, file } = persistent(vi.fn(async () => active))
  await control.start('acme/widgets', 'console-1')
  const before = readFileSync(file, 'utf8')
  mkdirSync(`${file}.lock`)
  expect((await control.stop()).phase).toBe('idle')
  expect(active.stop).toHaveBeenCalledTimes(1)
  expect(control.history()).toMatchObject({ error: expect.stringContaining('Cannot save launch history'), entries: [{ phase: 'stopped' }] })
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it.each(['{broken', JSON.stringify({ version: 99, entries: [] }), JSON.stringify({ version: 1, entries: [{}] })])('protects corrupt history instead of silently replacing it: %s', async bytes => {
  const root = directory(), file = join(root, 'history.json')
  writeFileSync(file, bytes)
  const control = new Launcher(vi.fn(async () => running()), null, new LaunchHistoryStore(file))
  expect(control.history()).toMatchObject({ entries: [], error: expect.stringContaining('Cannot read launch history') })
  await control.start('acme/widgets', 'console-1'); await control.stop()
  expect(control.history()).toMatchObject({ entries: [{ phase: 'stopped', consoleId: 'console-1' }], error: expect.any(String) })
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it('preserves corruption introduced after load and still stops the active worker', async () => {
  const { control, file } = persistent()
  await control.start('acme/widgets')
  writeFileSync(file, '{changed-after-load')
  await control.stop()
  expect(control.history().error).toContain('History changed on disk')
  expect(readFileSync(file, 'utf8')).toBe('{changed-after-load')
})

it.each([
  { repository: 'https://evil.example/owner/repo' }, { branch: '../escape' }, { consoleId: '\0bad' },
  { masterId: '' }, { startedAt: 'yesterday' }, { endedAt: 123 }, { phase: 'idle' }, { unexpected: true },
])('validates stored fields before exposing or writing them: %j', async patch => {
  const { control, file } = persistent()
  await control.start('acme/widgets'); await control.stop()
  const value = JSON.parse(readFileSync(file, 'utf8'))
  Object.assign(value.entries[0], patch)
  const bytes = JSON.stringify(value); writeFileSync(file, bytes)
  const recovered = new LaunchHistoryStore(file)
  expect(recovered.snapshot()).toMatchObject({ entries: [], error: expect.any(String) })
  recovered.begin({ repository: 'other/repo', branch: null }, null)
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it('validates session/request fields before creating history and shares history dispatch', async () => {
  const { control, factory, file } = persistent()
  for (const consoleId of ['', ' bad ', '\0bad', 'x'.repeat(513)]) await expect(control.start('acme/widgets', consoleId)).rejects.toThrow()
  expect(factory).not.toHaveBeenCalled(); expect(existsSync(file)).toBe(false)
  expect(LaunchRequestSchema.safeParse({ action: 'history', repository: 'acme/widgets' }).success).toBe(false)
  expect(LaunchRequestSchema.safeParse({ action: 'history' }).success).toBe(true)
  expect(dispatch(control, { action: 'history' })).toEqual(control.history())
  await dispatch(control, { action: 'start', repository: 'acme/widgets' }, 'console-dispatch')
  expect(control.history().entries[0]!.consoleId).toBe('console-dispatch')
  await control.stop()
})
