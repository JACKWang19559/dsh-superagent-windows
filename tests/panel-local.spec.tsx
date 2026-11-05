// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, type, field, text, at, find } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('submits a local task with only an immutable request ID and text, then opens its Thread', async () => {
  server.localTasks = { allowed: true, reason: null }
  await mount()
  await click(zh.localNewTask)
  await type(field<HTMLTextAreaElement>(zh.localTaskText), 'Fix the heading typo')
  await click(zh.localSubmitTask)
  const posted = server.requests.find(request => request.path === 'local/tasks')!
  expect(posted.method).toBe('POST')
  expect(posted.body).toEqual({ requestId: expect.any(String), text: 'Fix the heading typo' })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('Fix the heading typo')
  expect(text()).toContain(zh['source.local'])
  expect(text()).toContain(zh.localNoReplies)
})

it('retries the same task text with the same ID when its response was lost', async () => {
  server.localTasks = { allowed: true, reason: null }
  await mount()
  const transport = globalThis.fetch, attempts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/local/tasks')) {
      attempts.push(JSON.parse(String(init?.body)))
      if (attempts.length === 1) throw new TypeError('Response lost')
    }
    return transport(url, init)
  }))
  await click(zh.localNewTask)
  await type(field<HTMLTextAreaElement>(zh.localTaskText), 'Fix this typo')
  await click(zh.localSubmitTask)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await click(zh.localSubmitTask)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toEqual(attempts[1])
})

it('follows an existing external Ticket and renders its persisted replies using the same form and controls', async () => {
  server.ticketDetails.t1!.local = { thread: 'local:abc', allowed: true, messages: [], replies: [
    { id: 'reply-1', kind: 'reply', status: 'sent', text: 'The heading has been corrected.',
      channel: { source: 'local', thread: 'local:abc', address: { owner: 'owner', threadId: 'abc' } } },
    { id: 'reply-2', kind: 'reply', status: 'pending', text: 'Waiting to send.',
      channel: { source: 'github', thread: 'github:42', address: { number: '42' } } },
  ] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(text()).toContain('The heading has been corrected.')
  expect(text()).toContain(zh['localReply.pending'])
  await type(field<HTMLTextAreaElement>(zh.localFollowupText), 'What test covers it?')
  await click(zh.localSendFollowup)
  expect(server.requests.find(request => request.path === 'tickets/t1/messages')).toMatchObject({ method: 'POST',
    body: { requestId: expect.any(String), text: 'What test covers it?' } })
  expect(text()).toContain('What test covers it?')
  expect(field<HTMLTextAreaElement>(zh.localFollowupText).value).toBe('')
})

it('disables new work when local Policy refuses it, and explains why an ended Ticket cannot receive follow-ups', async () => {
  server.localTasks = { allowed: false, reason: 'notAllowed' }
  server.ticketDetails.t1!.local = { thread: 'local:abc', allowed: false, reason: 'ticketEnded', messages: [], replies: [] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect((find(zh.localNewTask) as HTMLButtonElement).disabled).toBe(true)
  expect(text()).toContain(zh['localRefusal.ticketEnded'])
  expect(document.querySelector('textarea')).toBeNull()
})
