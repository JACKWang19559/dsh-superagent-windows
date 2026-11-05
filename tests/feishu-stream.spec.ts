/** Offline event-stream transport: real Node leaves behind native argv, known CMD templates and PowerShell wrappers. */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import * as transport from '../src/infra/command-process.ts'
import { WINDOWS } from '../src/infra/platform.ts'
import { KV } from '../src/kv.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
const actualStream = transport.streamCommand
const eventArgs = ['event', 'consume', 'im.message.receive_v1', '--as', 'bot']
const event = (id = 'om_live') => JSON.stringify({ message_id: id, chat_id: 'oc_offline', chat_type: 'group',
  sender_id: 'ou_alice', sender_type: 'user', content: '离线事件 " & %', create_time: '1793836800000',
  mentions: [{ id: 'ou_bot', name: 'Bot' }] })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const until = { timeout: 10_000 }
let dir: string
let controller: AbortController
let running: Promise<unknown> | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu stream 中文 空格-')); controller = new AbortController(); running = undefined })
afterEach(async () => {
  vi.useRealTimers()
  controller.abort()
  try { await running } finally {
    // Failure cleanup is limited to PIDs recorded by this test's own offline fixture.
    for (const { pid } of records()) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } } }
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
interface Record { pid: number; args: string[]; notice: string; skills: string; electron?: string }
const records = (): Record[] => existsSync(join(dir, 'runs.ndjson'))
  ? readFileSync(join(dir, 'runs.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record) : []

/** Only native Node needs a fixed script argv inserted; all launches and termination below use the real shared transport. */
function fixture(kind: 'native' | 'cmd' | 'ps1', options: { ready?: boolean; lines?: string[]; diagnostic?: string; firstExit?: number } = {}): string {
  const file = join(dir, 'events.cjs'), log = join(dir, 'runs.ndjson')
  writeFileSync(file, `const fs=require('node:fs');
const log=${JSON.stringify(log)};
fs.appendFileSync(log,JSON.stringify({pid:process.pid,args:process.argv.slice(2),notice:process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER,skills:process.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER,electron:process.env.ELECTRON_RUN_AS_NODE})+'\\n');
const run=fs.readFileSync(log,'utf8').trim().split('\\n').length;
${options.ready === false ? '' : "console.error('[event] ready: offline fixture');"}
${options.diagnostic ? `console.error(${JSON.stringify(options.diagnostic)});` : ''}
${options.firstExit !== undefined ? `if(run===1) { process.exitCode=${options.firstExit}; } else {` : ''}
const lines=${JSON.stringify(options.lines ?? [event()])};
if(lines.length) process.stdout.write(lines.join('\\n')+'\\n');
setInterval(()=>{},1000);
${options.firstExit !== undefined ? '}' : ''}
`)
  if (kind === 'native') {
    vi.spyOn(transport, 'streamCommand').mockImplementation((argv, settings) =>
      actualStream(argv[0] === process.execPath ? [process.execPath, file, ...argv.slice(1)] : argv, settings))
    return process.execPath
  }
  const cli = join(dir, `lark-cli.${kind}`)
  if (kind === 'cmd') writeFileSync(cli, `@"${process.execPath}" "%~dp0events.cjs" %*\r\n@exit /b %errorlevel%\r\n`)
  else {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
    writeFileSync(cli, `﻿& ${literal(process.execPath)} ${literal(file)} @args\nexit $LASTEXITCODE\n`)
  }
  return cli
}

/** Strict in-memory Source capabilities fail if a queued line or late receive touches state after unload. */
function source(cli: string) {
  let enabled = true, closed = false
  const data = new Map<string, unknown>(), health: { [key: string]: Health } = {}
  const check = () => { if (closed) throw new Error('Source state was already closed') }
  const state = {
    get: vi.fn((key: string) => { check(); return data.get(key) }),
    set: vi.fn((key: string, value: unknown) => { check(); data.set(key, value) }),
    keys: () => [],
  }
  const receive = vi.fn(async (_trigger: Trigger) => {})
  const describe = vi.fn(() => { check() })
  const report = vi.fn((name: string, value: Health) => { check(); health[name] = value })
  const commands = { withSignal: (_signal: AbortSignal) => commands,
    lark: vi.fn(async () => ({ chats: [], items: [], has_more: false })) }
  const config = vi.fn(() => { check(); return enabled ? { chats: [], directMessages: false, readPageSize: 50 } : undefined })
  const ctx = { deployment: testDeployment({ stateDir: dir, feishu: { ...testDeployment().feishu!, cli } }),
    ready: Promise.resolve(), configured: () => true, config, state, commands, receive, report,
    threads: { subscribed: () => [], describe } } as unknown as SourceContext
  return { ctx, state, data, receive, describe, config, report, health,
    turnOff: () => { enabled = false }, close: () => { closed = true } }
}

for (const kind of ['native', 'cmd', 'ps1'] as const) describe.skipIf(kind !== 'native' && !WINDOWS)(`real ${kind} Feishu event stream`, () => {
  it('delivers one event, reports ready and ends the actual Node leaf on unload', async () => {
    const parentFlag = process.env.ELECTRON_RUN_AS_NODE
    const h = source(fixture(kind))
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), until)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ source: 'feishu', text: '离线事件 " & %',
      meta: { messageId: 'om_live', chatId: 'oc_offline', mentioned: true, direct: false } })
    expect(h.data.get(KV.feishu.chats)).toEqual({ oc_offline: false })
    expect(h.describe).toHaveBeenCalledTimes(1)
    expect(h.health.feishu).toMatchObject({ state: 'ready', detail: 'Listening for bot events' })
    const [record] = records()
    expect(record).toMatchObject({ args: eventArgs, notice: '1', skills: '1' })
    if (kind !== 'native') expect(record!.electron).toBe('1')
    expect(alive(record!.pid)).toBe(true)
    controller.abort(); await running
    expect(alive(record!.pid)).toBe(false)
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(parentFlag)
    const writes = h.state.set.mock.calls.length, reports = h.report.mock.calls.length
    h.close()
    await Promise.resolve()
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.state.set).toHaveBeenCalledTimes(writes)
    expect(h.report).toHaveBeenCalledTimes(reports)
  })

  it('terminates the real Node leaf within the five-second disable check', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = source(fixture(kind))
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), until)
    const pid = records()[0]!.pid
    h.turnOff()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(h.health.feishu).toMatchObject({ state: 'paused', code: 'sourceOff' }), until)
    expect(alive(pid)).toBe(false)
    expect(h.receive).toHaveBeenCalledTimes(1)
    controller.abort(); await running
  })

  it('bounds the 45-second ready deadline and stops the actual Node leaf', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = source(fixture(kind, { ready: false, lines: [] }))
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(records()).toHaveLength(1), until)
    const pid = records()[0]!.pid
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.waitFor(() => expect(h.health.feishu).toMatchObject({ state: 'error',
      detail: expect.stringContaining('did not become ready within 45 seconds') }), until)
    expect(alive(pid)).toBe(false)
    expect(h.receive).not.toHaveBeenCalled()
    controller.abort(); await running
    const failures = h.report.mock.calls.filter(([name, value]) => name === 'feishu' && value.state === 'error')
    expect(failures).toHaveLength(1)
  })
})

/** Controlled inputs expose exactly how much the consumer pulls, while its CLI and stop lifecycle remain real. */
function inputFor(stream: 'stdout' | 'stderr', input: Readable): void {
  const start = vi.mocked(transport.streamCommand).getMockImplementation()!
  vi.mocked(transport.streamCommand).mockImplementation((...parameters) => ({ ...start(...parameters), [stream]: input }))
}

describe('event processing and startup failures on every host', () => {
  for (const stream of ['stdout', 'stderr'] as const) it(`bounds an unfinished ${stream} line before reading an entire 24 MiB producer`, async () => {
    const h = source(fixture('native', { lines: [] }))
    let pulled = 0, released = false
    const block = Buffer.alloc(64 * 1024, 'x')
    const input = Readable.from((async function* () {
      try { for (let index = 0; index < 384; index++) { pulled++; yield block } }
      finally { released = true }
    })(), { objectMode: true, highWaterMark: 1 })
    inputFor(stream, input)
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.health.feishu).toMatchObject({ state: 'error', detail: expect.stringContaining('exceeds 1 MiB') }), until)
    controller.abort(); await running
    expect(pulled).toBeLessThanOrEqual(20)
    expect(released).toBe(true)
    expect(input.destroyed).toBe(true)
    expect(h.receive).not.toHaveBeenCalled()
    expect(records().every(({ pid }) => !alive(pid))).toBe(true)
  })

  it('applies backpressure instead of retaining 20,000 events behind a pending receive', async () => {
    const h = source(fixture('native', { lines: [] }))
    let pulled = 0, closed = false, release!: () => void
    const receiving = new Promise<void>(resolve => { release = resolve })
    h.receive.mockImplementation(async () => receiving)
    const input = Readable.from((async function* () {
      try {
        for (let index = 0; index < 20_000; index++) {
          pulled++
          yield Buffer.from(JSON.stringify({ ...JSON.parse(event(`om_${index}`)), content: 'x'.repeat(1024) }) + '\n')
        }
      } finally { closed = true }
    })(), { objectMode: true, highWaterMark: 1 })
    inputFor('stdout', input)
    running = runFeishu(h.ctx, controller.signal)
    try {
      await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), until)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(pulled).toBeLessThanOrEqual(4)
      controller.abort(); await running
      expect(closed).toBe(true)
      expect(input.destroyed).toBe(true)
      const writes = h.state.set.mock.calls.length, reads = h.state.get.mock.calls.length
      h.close(); release()
      for (let index = 0; index < 12; index++) await Promise.resolve()
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.state.set).toHaveBeenCalledTimes(writes)
      expect(h.state.get).toHaveBeenCalledTimes(reads)
      expect(h.describe).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('frames split UTF-8, CRLF across chunks and a final event without a newline', async () => {
    const h = source(fixture('native', { lines: [] })), first = Buffer.from(event('om_split'))
    const at = first.indexOf(Buffer.from('离')) + 1
    const input = Readable.from([first.subarray(0, at), first.subarray(at), Buffer.from('\r'),
      Buffer.from('\n' + event('om_final'))], { objectMode: true, highWaterMark: 1 })
    inputFor('stdout', input)
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(2), until)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['离线事件 " & %', '离线事件 " & %'])
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_split', 'om_final'])
    controller.abort(); await running
  })

  it('continues after malformed NDJSON and retains stderr warning diagnostics', async () => {
    const h = source(fixture('native', { lines: ['not json', event()], diagnostic: 'WARN drop: offline test' }))
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), until)
    const errors = h.report.mock.calls.filter(([name, value]) => name === 'feishu' && value.state === 'error').map(([, value]) => value.detail)
    expect(errors).toContain('WARN drop: offline test')
    expect(errors.some(detail => detail.includes('JSON'))).toBe(true)
    controller.abort(); await running
    expect(alive(records()[0]!.pid)).toBe(false)
  })

  it('drops queued lines and releases unload while a receive is still awaiting', async () => {
    const h = source(fixture('native', { lines: [event('om_first'), event('om_queued'), 'not json'] }))
    let release!: () => void
    const receiving = new Promise<void>(resolve => { release = resolve })
    h.receive.mockImplementation(async () => receiving)
    running = runFeishu(h.ctx, controller.signal)
    try {
      await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), until)
      expect(h.describe).not.toHaveBeenCalled()
      controller.abort()
      let settled = false
      void running.then(() => { settled = true })
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 7000 })
      expect(alive(records()[0]!.pid)).toBe(false)
      const reads = h.state.get.mock.calls.length, writes = h.state.set.mock.calls.length
      const reports = h.report.mock.calls.length, configs = h.config.mock.calls.length
      h.close()
      release()
      for (let index = 0; index < 12; index++) await Promise.resolve()
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.describe).not.toHaveBeenCalled()
      expect(h.state.get).toHaveBeenCalledTimes(reads)
      expect(h.state.set).toHaveBeenCalledTimes(writes)
      expect(h.report).toHaveBeenCalledTimes(reports)
      expect(h.config).toHaveBeenCalledTimes(configs)
    } finally { release() }
  })

  it('restarts an exited consumer after backoff and preserves its ready/exit diagnostic', async () => {
    const h = source(fixture('native', { firstExit: 23, diagnostic: 'WARN offline retry' }))
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.report.mock.calls.some(([name, value]) => name === 'feishu'
      && value.detail.includes('exited (23, ready=true): WARN offline retry'))).toBe(true), until)
    await vi.waitFor(() => expect(records()).toHaveLength(2), until)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), until)
    const [first, second] = records()
    expect(alive(first!.pid)).toBe(false)
    expect(alive(second!.pid)).toBe(true)
    expect(h.health.feishu).toMatchObject({ state: 'error', detail: 'WARN offline retry' })
    controller.abort(); await running
    expect(alive(second!.pid)).toBe(false)
  })

  it('reports an unknown CLI once and stops without leaving a pending stream', async () => {
    const h = source('superagent-offline-missing-feishu-cli')
    running = runFeishu(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.health.feishu).toMatchObject({ state: 'error', detail: expect.stringContaining('ENOENT') }), until)
    controller.abort(); await running
    h.close()
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.report.mock.calls.filter(([name, value]) => name === 'feishu' && value.state === 'error')).toHaveLength(1)
    expect(records()).toEqual([])
  })

  it('does not start an already-unloaded Source', async () => {
    const h = source(fixture('native'))
    controller.abort()
    running = runFeishu(h.ctx, controller.signal)
    await running
    expect(transport.streamCommand).not.toHaveBeenCalled()
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.report).not.toHaveBeenCalled()
    expect(records()).toEqual([])
  })

  it('handles unload just after spawning and before the consumer registers its listeners', async () => {
    const h = source(fixture('native'))
    const start = vi.mocked(transport.streamCommand).getMockImplementation()!
    vi.mocked(transport.streamCommand).mockImplementation((...parameters) => {
      const child = start(...parameters)
      controller.abort()
      return child
    })
    running = runFeishu(h.ctx, controller.signal)
    await running
    h.close()
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.report.mock.calls.filter(([name]) => name === 'feishu')).toEqual([])
    expect(records().every(({ pid }) => !alive(pid))).toBe(true)
  })
})
