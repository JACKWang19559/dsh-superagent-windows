/** Feishu background loops: live event stream consumer, chat/topic history backfill, chat name refresh, and subscribed thread polling. */
import { streamCommand } from '../infra/command-process.ts'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import { feishuChatLink } from './feishu-channel.ts'
import type { FeishuBot } from '../deployment.ts'
import { commandError, validItems, type Tally } from '../infra/commands.ts'
import { readFeishu, type FeishuRef } from './feishu-read.ts'
import { feishuRef, feishuTime, feishuTrigger, HistoricalMessageSchema, historyEvent, HistoryPageSchema, SOURCE, topicEvent }
  from './feishu-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, POLL_HORIZON_MS, polled, pollThreads as pollEach, sourceReady } from './poll.ts'
import type { FeishuConfig } from './feishu.ts'

export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, backfillLoop, chatNamesLoop].map((loop, index) => loop(ctx, signal).catch((error: unknown) => {
    if (!signal.aborted) ctx.report(index === 1 ? 'history' : 'feishu', { state: 'error', detail: String(error) })
  })))
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
async function receive(ctx: SourceContext, trigger: Trigger, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await ctx.receive(trigger)
  if (signal?.aborted) return
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
const chatLink = (ctx: SourceContext, chatId: string): string => feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  if (!await sourceReady(ctx, signal)) return
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('feishu', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const lifetime = AbortSignal.any([signal, running.signal])
    const began = Date.now()
    try { await consume(ctx, lifetime) }
    catch (error) { if (!lifetime.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
    finally { clearInterval(check) }
    if (lifetime.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
/** Frame incrementally: a missing delimiter must not retain an unlimited line, and awaiting the caller applies backpressure. */
async function* eventLines(input: Readable, label: string): AsyncGenerator<string> {
  const maximum = 1_048_576
  let parts: Buffer[] = [], bytes = 0, skipLF = false
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    if (!data.length) continue
    let start = skipLF && data[0] === 10 ? 1 : 0
    skipLF = false
    while (start < data.length) {
      const lf = data.indexOf(10, start), cr = data.indexOf(13, start)
      const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr)
      const part = data.subarray(start, end < 0 ? data.length : end)
      bytes += part.length
      if (bytes > maximum) throw new Error(`${label} exceeds 1 MiB`)
      if (part.length) parts.push(part)
      if (end < 0) break
      const line = Buffer.concat(parts, bytes).toString('utf8')
      parts = []; bytes = 0; start = end + 1
      if (data[end] === 13) {
        if (start < data.length && data[start] === 10) start++
        else if (start === data.length) skipLF = true
      }
      yield line
    }
  }
  if (bytes) yield Buffer.concat(parts, bytes).toString('utf8')
}

async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const deadline = new AbortController(), lifetime = AbortSignal.any([signal, deadline.signal])
  const cli = bot(ctx).cli
  let child: ReturnType<typeof streamCommand>
  try {
    child = streamCommand([cli, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'], { signal: lifetime,
      environment: [{ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }] })
  } catch (error) { throw commandError(error, cli) }
  let diagnostic = ''; let ready = false
  let release!: () => void
  const stopped = new Promise<void>(resolve => { release = resolve })
  const stop = (): void => { child.stdout.destroy(); child.stderr.destroy(); release() }
  lifetime.addEventListener('abort', stop, { once: true })
  if (lifetime.aborted) stop()
  const timeout = setTimeout(() => {
    deadline.abort(new Error('Feishu event consumer did not become ready within 45 seconds'))
  }, 45_000)
  const stderr = (async () => {
    try {
      for await (const line of eventLines(child.stderr, 'Feishu event consumer stderr')) {
        if (lifetime.aborted) return
        diagnostic = line.slice(0, 4000)
        if (line.startsWith('[event] ready')) {
          ready = true; clearTimeout(timeout)
          ctx.report('feishu', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
        } else if (/WARN|drop|error/.test(line)) ctx.report('feishu', { state: 'error', detail: diagnostic })
      }
    } catch (error) { if (!lifetime.aborted) deadline.abort(error) }
  })()
  const stdout = (async () => {
    try {
      for await (const line of eventLines(child.stdout, 'Feishu event')) {
        // Process exactly one event at a time. A slow receive stops pulling more chunks from the CLI.
        if (lifetime.aborted) return
        if (!enabled(ctx)) continue
        try {
          const trigger = feishuTrigger(JSON.parse(line), bot(ctx).botId, bot(ctx).appId)
          if (!trigger) continue
          const chats = ctx.state.get(KV.feishu.chats) ?? {}
          chats[String(trigger.meta.chatId)] = trigger.meta.direct === true
          ctx.state.set(KV.feishu.chats, chats)
          await Promise.race([receive(ctx, trigger, lifetime), stopped])
        } catch (error) { if (!lifetime.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
      }
    } catch (error) { if (!lifetime.aborted) deadline.abort(error) }
  })()
  try {
    let result
    try { result = await child.done } catch (error) {
      if (signal.aborted) return
      if (deadline.signal.aborted) throw deadline.signal.reason
      throw commandError(error, cli)
    }
    await Promise.all([stdout, stderr])
    if (signal.aborted) return
    if (deadline.signal.aborted) throw deadline.signal.reason
    throw new Error(`Feishu event consumer exited (${result.code}, ready=${ready}): ${diagnostic}`)
  } finally {
    clearTimeout(timeout)
    try { await Promise.all([stdout, stderr]) }
    finally { lifetime.removeEventListener('abort', stop) }
  }
}

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
export async function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const commands = ctx.commands.withSignal(signal)
  const result = z.looseObject({ chats: z.array(z.looseObject({ chat_id: z.string(), name: z.string().nullish() })).optional() })
    .parse(await commands.lark(['im', '+chat-list', '--page-all', '--page-size', '100']))
  const names = Object.fromEntries((result.chats ?? []).filter(chat => chat.name).map(chat => [chat.chat_id, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list every minute independently of history backfill (whose rounds can take much longer), so newly joined chats appear within a minute. */
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  if (!await sourceReady(ctx, signal)) return
  if (!available(ctx)) return
  while (!signal.aborted) {
    if (enabled(ctx)) {
      try { await refreshChatNames(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  if (!await sourceReady(ctx, signal)) return
  if (!available(ctx)) { ctx.report('history', health('paused', 'feishuBotMissing')); return }
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    const seen = ctx.state.get(KV.feishu.chats) ?? {}
    const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
    const chats = { ...Object.fromEntries(config.chats.map(chat => [chat.chatId, false])), ...Object.fromEntries(known) }
    const errors: string[] = []
    const tally = { skipped: 0 }
    for (const [chatId, direct] of Object.entries(chats)) {
      if (signal.aborted) break
      const started = new Date().toISOString()
      const cursorKey = KV.feishu.history(chatId)
      const since = ctx.state.get(cursorKey)
      if (since === undefined) { ctx.state.set(cursorKey, started); continue }
      try {
        await backfillChat(ctx, chatId, direct, since, started, signal, tally)
        if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
      } catch (error) { if (!signal.aborted) errors.push(`${chatId}: ${String(error)}`) }
    }
    await pollThreads(ctx, signal, tally)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    if (!signal.aborted) ctx.report('history', errors.length
      ? { state: 'error', detail: errors.join('\n') }
      : { state: 'ready', detail: `Configured groups and known direct chats recovered${skipped}`, at: new Date().toISOString() })
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
export async function backfillChat(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const topicsKey = KV.feishu.topics(chatId)
  const topics = { ...ctx.state.get(topicsKey) }
  const scan = async (kind: 'chat' | 'thread', id: string): Promise<void> => {
    let page: string | undefined
    const pages = new Set<string>()
    do {
      if (signal.aborted) throw signal.reason
      const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
      const parameters = { container_id_type: kind, container_id: id, start_time: seconds(since), end_time: seconds(until),
        sort_type: 'ByCreateTimeAsc', page_size: 50, ...(page ? { page_token: page } : {}) }
      const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
      const result = HistoryPageSchema.parse(await commands.lark(request))
      for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
        const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
        if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
        if (message.deleted) continue
        const at = feishuTime(message.create_time)
        if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) topics[message.thread_id] = at
        const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId)
        if (trigger) await receive(ctx, trigger, signal)
      }
      const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
      if (stuck) throw new Error('Feishu history pagination did not advance')
      page = result.has_more ? result.page_token : undefined
      if (page) pages.add(page)
    } while (page)
  }
  await scan('chat', chatId)
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  const followed = new Set(ctx.threads.subscribed(SOURCE).filter(thread => polled(ctx, thread))
    .map(thread => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')))
  for (const [id, seen] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) delete topics[id]
  }
  ctx.state.set(topicsKey, topics)
  for (const id of Object.keys(topics)) await scan('thread', id)
  ctx.state.set(topicsKey, topics)
}

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  if (meta.chatId && meta.messageId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? feishuRef(trigger) : undefined
}
/** Polls subscribed Feishu threads within the polling horizon so replies missed by the live stream become triggers. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally): Promise<void> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, tally))
}
async function pollThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal, tally?: Tally): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  if (!config) return
  const commands = ctx.commands.withSignal(signal)
  const pageSize = config.readPageSize
  const checkpoint = KV.feishu.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  if (!initialized) {
    // Mark root and parent messages as seen on first poll so historical context is not ingested as new triggers.
    for (const section of ['root', 'parent']) {
      const result = await readFeishu(commands, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
      if ('message' in result && result.message) known.add(result.message.message_id)
    }
    ctx.state.set(checkpoint, [...known])
  }
  const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true
  const since = Date.parse(thread.createdAt)
  const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  let resource: string | null = `feishu/${ref.triggerId}/thread`
  while (resource) {
    if (signal?.aborted) return
    const result = await readFeishu(commands, ref, resource, pageSize, 'desc')
    if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
    if (tally && 'skipped' in result) tally.skipped += result.skipped ?? 0
    if ('thread_id' in result && result.thread_id && thread.meta.threadId !== result.thread_id) {
      ctx.threads.patch(thread.key, { threadId: result.thread_id })
    }
    const encounteredKnown = result.messages.some(message => known.has(message.message_id))
    const { botId, appId } = bot(ctx)
    for (const message of result.messages.filter(item => !known.has(item.message_id) && !item.deleted).reverse()) {
      if (signal?.aborted) return
      const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId)
      // Ignore messages older than the thread subscription on initial poll.
      if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
      await receive(ctx, trigger, signal)
    }
    result.messages.forEach(message => known.add(message.message_id))
    ctx.state.set(checkpoint, [...known])
    if (initialized && encounteredKnown) break
    resource = result.next_resource
  }
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
