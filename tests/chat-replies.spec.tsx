// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatReplies, type ChatRepliesProps } from '../src/client/chat-replies.tsx'
import { chatResults } from '../src/client/chat-results.ts'
import { zh } from '../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const reply = (id = 'reply-1', ticket = 'ticket-1', text = '已完成；24 项测试通过。', status = 'sent') => ({
  kind: 'tool-result', callId: id, isError: false,
  call: { name: 'orchestrator_reply', argsRaw: JSON.stringify({ purpose: 'result', ticket_id: ticket, text }) },
  content: [{ type: 'text', text: JSON.stringify({ status }) }], subCalls: [] as unknown[],
})

it('requires a correlated successful result receipt rather than a finished call or requested text', () => {
  const good = reply()
  expect(chatResults([good])).toEqual([{ callId: 'reply-1', text: '已完成；24 项测试通过。' }])
  for (const bad of [reply('p', 't', 'not sent', 'pending'), reply('d', 't', 'dropped', 'dropped'),
    { ...good, isError: true }, { ...good, error: { code: 'interrupted' } }, { ...good, kind: 'tool-call' },
    { ...good, content: [] }, { ...good, content: [{ type: 'text', text: 'invalid JSON' }] },
    { ...good, call: { ...good.call, argsRaw: '{' } }, { ...good, call: { ...good.call, name: 'other_tool' } },
    ...['answer', 'attention', 'noDispatch'].map(purpose => ({ ...good,
      call: { ...good.call, argsRaw: JSON.stringify({ purpose, text: 'Not a completion' }) } })),
    { ...good, call: { ...good.call, argsRaw: JSON.stringify({ purpose: 'result', text: '  ' }) } }, null]) {
    expect(chatResults([bad])).toEqual([])
  }
})

it('handles restored nested calls, trigger-addressed results, and distinct tickets without repeating a retry', () => {
  const first = reply(), second = reply('reply-2', 'ticket-2')
  const trigger = reply('trigger-result')
  trigger.call.argsRaw = JSON.stringify({ purpose: 'result', trigger_id: 'trigger-3', text: 'Third result' })
  const dispatch = { subCalls: [first, reply('retry'), second, trigger] }
  expect(chatResults([dispatch, dispatch]).map(item => item.callId)).toEqual(['reply-1', 'reply-2', 'trigger-result'])
  expect(chatResults([first], ['Planning to run tests.'])).toHaveLength(1)
  expect(chatResults([first], ['\n已完成；24 项测试通过。\n'])).toEqual([])
})

const disposers: (() => void)[] = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals() })
function source(initial: unknown[]) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (next: unknown[]) => { value = next; listeners.forEach(fn => fn()) } }
}
async function mount(turn = 2) {
  const tools = source([]), assistants = source([])
  const turnDataSource = vi.fn((number: number, kind: string) => {
    if (number !== turn) throw new Error('Read the wrong turn')
    return kind === 'tool-call' ? tools : assistants
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const nodes = { turnDataSource }
  const props = { turn: { turn, status: 'closed' }, useChat: (select: (value: unknown) => unknown) => select({ nodes }),
    t: (key: keyof typeof zh) => zh[key] } as unknown as ChatRepliesProps
  await act(async () => { root.render(<ChatReplies {...props} />) })
  disposers.push(() => { act(() => root.unmount()); container.remove() })
  return { container, tools, assistants, root, props, turnDataSource }
}

it('renders a restored result outside collapsed work, with safe links and no model/API calls', async () => {
  const fetch = vi.fn(() => { throw new Error('Rendering must not send any request') }); vi.stubGlobal('fetch', fetch)
  const view = await mount()
  expect(view.container.textContent).toBe('')
  const text = '已完成 `sum`，24 项测试通过。[查看 PR](https://github.com/owner/repo/pull/1)\n<script>alert(1)</script>'
  await act(async () => { view.tools.set([{ root: reply('historical', 't', text) }]) })
  expect(view.container.querySelector('[data-superagent-result="historical"]')?.textContent).toContain('24 项测试通过')
  expect(view.container.querySelector('a')?.href).toBe('https://github.com/owner/repo/pull/1')
  expect(view.container.querySelector('script')).toBeNull()
  expect(view.container.textContent).toContain('<script>alert(1)</script>')
  expect(view.turnDataSource.mock.calls).toEqual([[2, 'tool-call'], [2, 'assistant-step']])
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => { view.assistants.set([{ status: 'settled', blocks: [{ kind: 'text', text }] }]) })
  expect(view.container.querySelector('[data-superagent-result]')).toBeNull()
})

it('does not show ordinary sessions or incomplete turns as completed tasks', async () => {
  const view = await mount(3)
  await act(async () => { view.tools.set([{ root: { ...reply(), call: { name: 'pwsh', argsRaw: '{}' } } }]) })
  expect(view.container.textContent).toBe('')
  await act(async () => {
    view.tools.set([{ root: reply() }])
    view.root.render(<ChatReplies {...view.props} turn={{ ...view.props.turn, status: 'open' }} />)
  })
  expect(view.container.textContent).toBe('')
})
