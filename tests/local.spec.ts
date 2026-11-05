import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, runningAssignment, type Candidate, type ChannelRef, type Executor, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { Passes } from '../src/app/passes.ts'
import { Outbox } from '../src/app/outbox.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { LOCAL_TASK_TEXT_LIMIT } from '../src/app/api.ts'
import { SettingsSchema, policyVersion, type Settings } from '../src/policy.ts'
import { settingsPolicy } from '../src/policy.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { Commands } from '../src/infra/commands.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { apply, initializeLocalPolicy, localKind, LocalTaskError, LocalTasks } from '../src/sources/local.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'local-source-')), path = join(dir, 'db.sqlite'), store = new Store(path)
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } }))
  const board = new HealthBoard(), sources = new SourceRegistry(() => store.settings(), board, kind => {
    if (kind.kind === 'local') initializeLocalPolicy(store)
    return () => {}
  })
  sources.register(localKind); sources.register({ ...githubKind, channel: { ...githubKind.channel!, send: async () => 'sent' } })
  const effects = new Effects(store, board), commands = { run: vi.fn(() => { throw new Error('No external commands in local lifecycle') }) }
  const outbox = new Outbox({ store, effects, sources, commands: commands as unknown as Commands, paused: () => store.settings().paused })
  const candidates: Candidate[] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })),
    deliver: vi.fn(ticket => effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })), stop: vi.fn(),
  }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    executor, outbox, assessor: { request: candidate => { candidates.push(candidate) } } })
  // These are the worker's facts, through the real Engine; no alternate executor or external process runs.
  effects.handle('launch', async ({ ticketId, assignmentId }) => { engine.assignmentStarted(ticketId, assignmentId) })
  effects.handle('delivery', async ({ ticketId }) => {
    const ticket = store.tickets.get(ticketId)!, assignment = runningAssignment(ticket)
    if (!assignment) return
    engine.inputsDelivered(ticketId, assignment.id, ticket.undelivered)
    engine.inputsRead(ticketId, ticket.undelivered)
  })
  let configured = true
  const passes = new Passes({ engine, effects, health: board.claim('runtime'), lifetime: new AbortController().signal,
    configured: () => configured, closing: () => false })
  const receive = vi.fn((trigger: Trigger) => passes.receive(trigger))
  const deps = { store, sources, engine, receive, configured: () => configured }
  const local = new LocalTasks(deps)
  effects.start()
  cleanup.push(async () => { await passes.stop(); await effects.drain(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const update = (change: (settings: Settings) => Settings) => store.saveSettings(change(store.settings()))
  const accept = async (triggerId: string) => {
    await passes.idle()
    const decision = engine.decide(triggerId, { kind: 'accept', title: 'Fix requested wording', scope: 'Fix the specified wording',
      reason: 'The owner requested it', acknowledgement: 'Accepted', evalId: engine.candidate(triggerId)!.evalId })
    await passes.idle()
    return store.tickets.get(decision.ticketId!)!
  }
  return { store, path, sources, engine, effects, passes, outbox, commands, executor, candidates, local, receive, deps,
    update, accept, setConfigured: (value: boolean) => { configured = value } }
}
const request = (requestId = 'request-0001', text = 'Fix the typo in the heading') => ({ requestId, text })
function serving(h: ReturnType<typeof harness>) {
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 49183, register: (value: { handler: Handler }) => {
    handler = value.handler; return () => {}
  } } }
  registerHttp(ctx as never, { ...h.deps, localTasks: h.local, ready: Promise.resolve(), ticketEnvironment: () => [],
    links: () => ((channel: ChannelRef) => h.sources.link(channel, {})) } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    let status = 0, text = ''
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:49183', 'x-orchestrator-request': '1', ...headers },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    await handler(req, { writeHead: (value: number) => { status = value }, end: (value: string) => { text = value } })
    return { status, body: JSON.parse(text) as Record<string, any> }
  }
}

describe('local Source', () => {
  it('seeds owner once as a versioned Policy save, preserves revocation and registers/disposes the Source plugin', () => {
    const h = harness(), history = h.store.settingsHistory()
    expect(h.store.settings().policy.sources.local?.allowed).toEqual([{ id: 'owner' }])
    expect(h.store.settings().policy.sources.github?.allowed).toEqual([{ id: 'alice' }])
    expect(history[0]).toMatchObject({ source: 'internal', block: 'policy', policyChanged: true,
      policyVersion: policyVersion(h.store.settings()) })
    expect(h.store.blockRevision('policy')).toBe(1)
    h.update(settings => ({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, local: { allowed: [], admission: {} } } } }))
    const revision = h.store.settingsHistory()[0]!.revision
    initializeLocalPolicy(h.store)
    expect(h.store.settings().policy.sources.local?.allowed).toEqual([])
    expect(h.store.settingsHistory()[0]!.revision).toBe(revision)
    const registry = new SourceRegistry(() => h.store.settings()), disposers: (() => void)[] = []
    apply({ orchestrator: { sources: registry }, effect: (work: () => () => void) => { disposers.push(work()) } } as never)
    expect(registry.kind('local')).toBe(localKind)
    disposers[0]!()
    expect(registry.kind('local')).toBeUndefined()
    expect(localKind.scope!({ meta: {} }, {})).toMatchObject({ listened: false })
    expect(localKind.policy!.rows!({})[0]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false })
  })

  it('uses stable global request IDs and a server-owned direct actor, keeping one root Thread and rejecting ID conflicts', async () => {
    const h = harness(), created = h.local.create(request())
    expect(created).toMatchObject({ received: 'stored', triggerId: key('local-request', 'request-0001'),
      thread: `local:${key('local-task', 'request-0001')}` })
    expect(h.store.triggers.get(created.triggerId)).toMatchObject({ source: 'local', actor: { source: 'local', id: 'owner' },
      human: true, addressed: 'direct', threads: [{ source: 'local', id: key('local-task', 'request-0001') }] })
    expect(new LocalTasks(h.deps).create(request())).toEqual({ ...created, received: 'duplicate' })
    expect(() => h.local.create(request('request-0001', 'Different work'))).toThrow(LocalTaskError)
    await h.passes.idle()
    expect(h.candidates).toHaveLength(1)
    expect(h.candidates[0]!.strength).toBe('explicit')
    expect(h.store.threads.list()).toHaveLength(1)
    expect(h.store.tickets.list()).toHaveLength(0)
  })

  it('runs intake → Policy → Ticket → mock worker → persisted Channel replies, then follows the same Ticket once', async () => {
    const h = harness(), call = serving(h)
    const created = await call('POST', 'local/tasks', request())
    expect(created.status).toBe(200)
    const id = created.body.triggerId as string, ticket = await h.accept(id)
    expect(ticket.mandate).toMatchObject({ strength: 'explicit', actor: { source: 'local', id: 'owner' }, basis: { via: 'addressed', addressed: 'direct' } })
    expect(runningAssignment(ticket)).toBeDefined()
    expect(h.executor.start).toHaveBeenCalledTimes(1)
    const follow = await call('POST', `tickets/${ticket.id}/messages`, request('request-0002', 'What changed?'))
    expect(follow).toMatchObject({ status: 200, body: { thread: created.body.thread, ticketId: ticket.id, received: 'stored' } })
    expect(await call('POST', `tickets/${ticket.id}/messages`, request('request-0002', 'What changed?')))
      .toMatchObject({ status: 200, body: { received: 'duplicate' } })
    await h.passes.idle()
    expect(h.store.threads.list()).toHaveLength(1)
    expect(h.store.tickets.list()).toHaveLength(1)
    expect(h.store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'trigger')).toHaveLength(1)
    expect(h.store.tickets.get(ticket.id)!.mandate).toEqual(ticket.mandate)
    expect(h.candidates).toHaveLength(1)
    h.engine.report(ticket.id, { state: 'progress', summary: 'Wording updated', answers: follow.body.triggerId })
    const reply = h.engine.reply({ purpose: 'answer', ticketId: ticket.id, triggerId: follow.body.triggerId, text: 'The heading is corrected.' })
    expect(h.engine.reply({ purpose: 'answer', ticketId: ticket.id, triggerId: follow.body.triggerId,
      text: 'The heading is corrected.' }).reused).toBe(true)
    await h.outbox.sent()
    expect(h.store.receipts.get(reply.id)?.status).toBe('sent')
    const detail = await call('GET', `tickets/${ticket.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.local.messages.map((item: { text: string }) => item.text)).toEqual([request().text, 'What changed?'])
    expect(detail.body.local.replies.map((item: { text: string }) => item.text)).toEqual(['Accepted', 'The heading is corrected.'])
    const thread = await call('GET', `threads/${encodeURIComponent(created.body.thread)}`)
    expect(thread.body.local.replies.map((item: { id: string }) => item.id)).toContain(reply.id)
    h.engine.report(ticket.id, { state: 'ready', summary: 'Done' })
    h.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'Completed the requested fix.' })
    await h.outbox.sent()
    expect(h.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    expect(await call('POST', `tickets/${ticket.id}/messages`, request('request-0003'))).toMatchObject({ status: 403 })
    // A second handle reads the real persisted receipts; no in-memory reply cache is involved.
    const reopened = new Store(h.path)
    try { expect(reopened.read.channelReplies({ ticketId: ticket.id }).map(item => item.text))
      .toEqual(['Accepted', 'The heading is corrected.', 'Completed the requested fix.']) } finally { reopened.close() }
    expect(h.commands.run).not.toHaveBeenCalled()
  })

  it('attaches a local conversation to a GitHub Ticket through subscriptions without changing its Mandate or completion semantics', async () => {
    const h = harness(), trigger: Trigger = { id: 'github-request', source: 'github', actor: { source: 'github', id: 'alice' }, human: true,
      addressed: 'mention', threads: [{ source: 'github', id: '42' }], at: new Date().toISOString(), text: 'Fix the typo',
      meta: { number: 42 }, channel: { source: 'github', thread: 'github:42', address: { number: '42' } } }
    h.receive(trigger)
    const ticket = await h.accept(trigger.id), follow = h.local.followup(ticket.id, request('followup-001', 'Please explain the change'))
    await h.passes.idle()
    expect(h.store.threads.get(follow.thread)?.subscriptions).toEqual([ticket.id])
    expect(h.store.tickets.get(ticket.id)!.mandate).toEqual(ticket.mandate)
    expect(h.store.tickets.get(ticket.id)!.follows).toBeUndefined()
    const next = h.local.followup(ticket.id, request('followup-002', 'And its test?'))
    expect(next.thread).toBe(follow.thread)
    await h.passes.idle()
    expect(h.store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'trigger')).toHaveLength(2)
    expect(() => h.local.create(request('followup-001', 'Please explain the change'))).toThrow(/different request/)
    h.update(settings => ({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
      github: { allowed: [], admission: {} } } } }))
    expect(h.local.available(h.store.tickets.get(ticket.id)!)).toBe('mandateRevoked')
    expect(() => h.local.followup(ticket.id, request('followup-003'))).toThrow(/mandateRevoked/)
    expect(h.store.triggers.get(key('local-request', 'followup-003'))).toBeUndefined()
  })

  it('checks local allowed and scope before subscription fan-out, including an open Ticket, and refuses stopped work', async () => {
    const h = harness(), created = h.local.create(request()), ticket = await h.accept(created.triggerId)
    h.update(settings => ({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
      local: { allowed: [], admission: {} } } } }))
    expect(() => h.local.create(request('revoked-001'))).toThrow(/notAllowed/)
    expect(() => h.local.followup(ticket.id, request('revoked-002'))).toThrow(/notAllowed/)
    expect(h.store.tickets.get(ticket.id)!.inputs).toHaveLength(0)
    expect(h.store.triggers.get(key('local-request', 'revoked-002'))).toBeUndefined()
    h.update(settings => ({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
      local: { allowed: [{ id: 'owner' }], admission: {} } } }, sources: { ...settings.sources, local: { enabled: false, config: {} } } }))
    expect(() => h.local.create(request('disabled-01'))).toThrow(/sourceOff/)
    h.update(settings => ({ ...settings, sources: { ...settings.sources, local: { enabled: true, config: {} } } }))
    h.engine.stopTicket(ticket.id)
    expect(() => h.local.followup(ticket.id, request('stopped-001'))).toThrow(/ticketEnded/)
    h.setConfigured(false)
    expect(() => h.local.create(request('notready-01'))).toThrow(/notConfigured/)
  })

  it('strictly validates local HTTP bodies, refuses identity/authorization/source fields and enforces the byte limit and same Origin', async () => {
    const h = harness(), call = serving(h)
    for (const extra of [{ actor: { source: 'github', id: 'alice' } }, { source: 'github' }, { human: true }, { addressed: 'direct' },
      { strength: 'explicit' }, { mandate: {} }, { threadId: 'another' }, { channel: {} }, { ticketId: 'another' }, { owner: 'someone' }]) {
      expect(await call('POST', 'local/tasks', { ...request(), ...extra })).toMatchObject({ status: 400 })
    }
    for (const body of [{ text: 'Hi' }, request('short'), request('request-0001', '  '), request('request-0001', 'x'.repeat(LOCAL_TASK_TEXT_LIMIT + 1))]) {
      expect(await call('POST', 'local/tasks', body)).toMatchObject({ status: 400 })
    }
    expect(await call('POST', 'local/tasks', request('request-0001', 'x'.repeat(70_000))))
      .toMatchObject({ status: 400, body: { error: 'Request exceeds 68096 bytes' } })
    expect(await call('POST', 'local/tasks', request(), { origin: 'dsh-app://app' })).toMatchObject({ status: 403 })
    expect(await call('POST', 'local/tasks', request(), { origin: 'https://evil.example' })).toMatchObject({ status: 403 })
    expect(h.receive).not.toHaveBeenCalled()
    const created = await call('POST', 'local/tasks', request())
    expect(created.status).toBe(200)
    expect(await call('POST', 'local/tasks', request())).toMatchObject({ status: 200, body: { received: 'duplicate' } })
    expect(await call('POST', 'local/tasks', request('request-0001', 'Changed'))).toMatchObject({ status: 409 })
    expect(await call('POST', 'tickets/missing/messages', request('request-0002'))).toMatchObject({ status: 404 })
    const ticket = await h.accept(created.body.triggerId)
    expect(await call('POST', `tickets/${ticket.id}/messages`, { ...request('request-0002'), actor: 'someone' })).toMatchObject({ status: 400 })
  })
})
