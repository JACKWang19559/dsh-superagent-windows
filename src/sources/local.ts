/** Explicit requests from the local management panel, through the same intake, Policy and Ticket lifecycle as other Sources. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type Engine, type ReceiveResult, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, policyVersion, settingsPolicy } from '../policy.ts'
import { LOCAL_TASK_TEXT_LIMIT, type LocalTaskRequest } from '../app/api.ts'
import type { Store, Receipt } from '../app/store.ts'
import type { SourceRegistry } from './registry.ts'
import type { SourceKind } from './kind.ts'

/** A server-owned identity. Request bodies cannot choose an actor, Source, strength or reply destination. */
export const LOCAL_OWNER = 'owner'
const owner = { source: 'local', id: LOCAL_OWNER }
const RequestId = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/)
const ThreadId = z.string().regex(/^[a-f0-9]{32}$/)
export const LocalTaskRequestSchema = z.object({ requestId: RequestId, text: z.string().trim().min(1).max(LOCAL_TASK_TEXT_LIMIT) }).strict()
const ConfigSchema = z.object({}).strict()
const PolicySchema = z.object({ allowed: z.array(z.object({ id: z.literal(LOCAL_OWNER), name: z.string().trim().max(100).optional() }).strict())
  .default([{ id: LOCAL_OWNER }]) }).strict()

export const localKind: SourceKind = {
  kind: 'local', title: { zh: '本地任务', en: 'Local tasks' },
  description: { zh: '只接收本机管理页明确提交的任务和跟进。', en: 'Receives only tasks and follow-ups explicitly submitted in the local panel.' },
  schema: ConfigSchema, fields: [], health: [],
  scope: ({ meta }) => meta.local === true && meta.direct === true && ThreadId.safeParse(meta.threadId).success
    && RequestId.safeParse(meta.requestId).success
    ? { listened: true, observed: false, row: 'desktop' } : { listened: false, reason: 'local_request_required' },
  channel: {
    allowed: address => address.owner === LOCAL_OWNER && ThreadId.safeParse(address.threadId).success,
    // Outbox has already persisted the message by ID. Reading its receipt is local delivery; no second message store is needed.
    send: async (_host, message) => message.channel.address.owner === LOCAL_OWNER
      && ThreadId.safeParse(message.channel.address.threadId).success
      && message.channel.thread === `local:${message.channel.address.threadId}` ? 'sent' : 'gone',
    link: () => ({ url: '', label: { zh: '本地任务对话', en: 'Local task conversation' } }),
  },
  policy: {
    schema: PolicySchema,
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '可提交任务的本机用户', en: 'Local owner allowed to submit tasks' }, columns: [
      { key: 'id', type: 'text', pattern: 'owner', label: { zh: '本机用户（owner）', en: 'Local owner (owner)' } },
      { key: 'name', type: 'text', optional: true, label: { zh: '显示名称', en: 'Display name' } },
    ] }],
    explicit: { zh: '本机用户在管理页提交任务或跟进。删除 owner 可撤销提交权限。',
      en: 'The local owner submits a task or follow-up in the panel. Remove owner to revoke submission.' },
    rows: () => [{ id: 'desktop', label: { zh: '本机明确请求', en: 'Explicit local requests' },
      note: { zh: '仅本机用户主动提交', en: 'Submitted by the local owner only' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }],
  },
}

/** Seed once through versioned settings; an explicitly empty allowed list remains a revocation on later registrations. */
export function initializeLocalPolicy(store: Pick<Store, 'settings' | 'saveSettings'>): void {
  const settings = store.settings()
  if (settings.policy.sources.local !== undefined) return
  const value = { ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
    local: { allowed: [{ id: LOCAL_OWNER }], admission: {} } } } }
  store.saveSettings(value, { source: 'internal', block: 'policy', policyVersion: policyVersion(value), policyChanged: true, notified: [] })
}

export interface LocalTaskResult { requestId: string; triggerId: string; thread: string; received: ReceiveResult; ticketId?: string }
export type LocalTaskRefusal = 'notConfigured' | 'sourceOff' | 'notAllowed' | 'ticketEnded' | 'mandateRevoked'
export interface LocalConversation {
  thread: string
  allowed: boolean
  reason?: LocalTaskRefusal
  messages: { id: string; text: string; at: string }[]
  replies: Pick<Receipt, 'id' | 'text' | 'kind' | 'status' | 'channel'>[]
}
/** A controlled local ingress refusal, serialized by the existing HTTP error handler. */
export class LocalTaskError extends Error {
  constructor(readonly status: 403 | 404 | 409, message: string) { super(message) }
}
interface LocalTaskHost {
  store: Pick<Store, 'atomic' | 'settings' | 'triggers' | 'threads' | 'tickets' | 'read'>
  sources: SourceRegistry
  engine: Pick<Engine, 'attach'>
  receive(trigger: Trigger): ReceiveResult
  configured(): boolean
}

/** Local ingress uses Runtime.receive (Passes → Engine), never launches workers or writes Ticket/Subscription aggregates. */
export class LocalTasks {
  constructor(private readonly host: LocalTaskHost) {}
  available(ticket?: Ticket): LocalTaskRefusal | undefined {
    const { sources, store } = this.host
    if (!this.host.configured()) return 'notConfigured'
    if (!sources.instance('local')?.enabled) return 'sourceOff'
    if (!allowedSender(store.settings(), owner)) return 'notAllowed'
    if (ticket?.ended) return 'ticketEnded'
    if (ticket && !settingsPolicy(store.settings(), sources).revalidate(ticket.mandate)) return 'mandateRevoked'
    return undefined
  }
  create(value: unknown): LocalTaskResult { return this.submit(LocalTaskRequestSchema.parse(value)) }
  followup(ticketId: string, value: unknown): LocalTaskResult {
    const request = LocalTaskRequestSchema.parse(value)
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new LocalTaskError(404, 'Ticket not found')
    return this.submit(request, ticket)
  }
  private localThread(ticket: Ticket): string {
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    return origin?.source === 'local' ? origin.threads[0]!.id : key('local-ticket', ticket.id)
  }
  private submit(request: LocalTaskRequest, ticket?: Ticket): LocalTaskResult {
    const { store, sources } = this.host
    return store.atomic(() => {
      const id = key('local-request', request.requestId)
      const previous = store.triggers.get(id)
      if (previous) {
        if (previous.source !== 'local' || previous.text !== request.text || previous.meta.ticketId !== ticket?.id) {
          throw new LocalTaskError(409, 'This requestId was already used for a different request')
        }
        return { requestId: request.requestId, triggerId: id, thread: threadKey(previous.threads[0]!), received: 'duplicate',
          ...ticket ? { ticketId: ticket.id } : {} }
      }
      const refusal = this.available(ticket)
      if (refusal) throw new LocalTaskError(403, `Local task request refused: ${refusal}`)
      const threadId = ticket ? this.localThread(ticket) : key('local-task', request.requestId)
      const ref = { source: 'local', id: threadId }, thread = threadKey(ref)
      const trigger: Trigger = { id, source: 'local', threads: [ref], actor: owner, human: true, addressed: 'direct',
        at: new Date().toISOString(), text: request.text,
        channel: { source: 'local', thread, address: { threadId, owner: LOCAL_OWNER } },
        meta: { local: true, direct: true, threadId, requestId: request.requestId, ...ticket ? { ticketId: ticket.id } : {} } }
      // Check the normal gate before intake: subscription fan-out itself does not authorize a new local sender.
      const current: Thread = store.threads.get(thread) ?? { key: thread, ref, createdAt: trigger.at,
        subscriptions: [], correlated: [], pending: [], meta: {} }
      const gate = settingsPolicy(store.settings(), sources).gate(trigger, current, [])
      if (!sources.scope(trigger).listened || !gate.admissible || gate.strength !== 'explicit') {
        throw new LocalTaskError(403, 'Local task request is not authorized by the Source Policy')
      }
      const received = this.host.receive(trigger)
      if (received === 'filtered') throw new LocalTaskError(403, 'Local task Source is not receiving requests')
      // A newly added local conversation of an existing Ticket subscribes through attach, preserving its original Mandate.
      if (ticket && !store.triggers.disposition(id)?.fanout.includes(ticket.id)) this.host.engine.attach(ticket.id, id)
      return { requestId: request.requestId, triggerId: id, thread, received, ...ticket ? { ticketId: ticket.id } : {} }
    })
  }
  conversation(ticketId: string): LocalConversation {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new LocalTaskError(404, 'Ticket not found')
    return this.readConversation(`local:${this.localThread(ticket)}`, ticket)
  }
  threadConversation(thread: string): LocalConversation | undefined {
    const current = this.host.store.threads.get(thread)
    if (current?.ref.source !== 'local') return undefined
    return this.readConversation(thread)
  }
  private readConversation(thread: string, ticket?: Ticket): LocalConversation {
    const { store } = this.host
    const reason = this.available(ticket)
    return { thread, allowed: !reason, ...reason ? { reason } : {},
      messages: store.read.threadTriggers(thread, 100).map(({ id, text, at }) => ({ id, text, at })),
      replies: store.read.channelReplies(ticket ? { ticketId: ticket.id } : { thread }).map(({ id, text, kind, status, channel }) =>
        ({ id, text, kind, status, channel })) }
  }
}

export const name = 'dsh-superagent-local'
export const inject = ['orchestrator']
export function apply(ctx: Context): void { ctx.effect(() => ctx.orchestrator.sources.register(localKind), 'local: source kind') }
