/** Minimal local task composer and the persisted replies shared by task and Thread detail pages. */
import { useRef, useState, type FormEvent } from 'react'
import { LOCAL_TASK_TEXT_LIMIT, type LocalTaskRequest } from '../app/api.ts'
import type { LocalConversation } from '../sources/local.ts'
import { Button, Icon, Modal, Tag } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { valueLabel } from './text.ts'
import { Hint, MarkdownLite, Section, When } from './widgets.tsx'

function Composer({ submit, followup = false, disabled = false }: {
  submit: (request: LocalTaskRequest) => Promise<void>; followup?: boolean; disabled?: boolean
}) {
  const { t } = usePanel()
  const [text, setText] = useState('')
  // Retain the ID after a lost response so retrying this text cannot create a second Trigger or Ticket.
  const pending = useRef<LocalTaskRequest>()
  const action = useAction(async () => {
    const body = text.trim()
    const request = pending.current?.text === body ? pending.current : { requestId: crypto.randomUUID(), text: body }
    pending.current = request
    await submit(request)
    pending.current = undefined
    setText('')
  })
  const send = (event: FormEvent) => { event.preventDefault(); if (text.trim() && !disabled) void action.run() }
  return <form onSubmit={send}>
    <Fields disabled={disabled || action.busy}>
      <Field label={t(followup ? 'localFollowupText' : 'localTaskText')}>
        <textarea className="dt-textarea" rows={4} required maxLength={LOCAL_TASK_TEXT_LIMIT} value={text}
          placeholder={t(followup ? 'localFollowupPlaceholder' : 'localTaskPlaceholder')}
          onChange={event => setText(event.target.value)} />
      </Field>
      <div className="dt-toolbar"><Button type="submit" variant="primary" disabled={!text.trim() || disabled || action.busy}
        aria-busy={action.busy} icon={<Icon name={followup ? 'message' : 'plus'} />}>
        {t(action.busy ? 'localSubmitting' : followup ? 'localSendFollowup' : 'localSubmitTask')}
      </Button></div>
    </Fields>
  </form>
}

export function NewTaskButton() {
  const { t, call, navigate, notify } = usePanel()
  const { state } = usePanelData()
  const [open, setOpen] = useState(false)
  const submitting = useRef(false)
  const allowed = state?.localTasks?.allowed ?? false
  return <>
    <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} disabled={!allowed}
      title={!allowed ? t('localTaskUnavailable') : undefined} onClick={() => setOpen(true)}>{t('localNewTask')}</Button>
    <Modal open={open} onClose={() => { if (!submitting.current) setOpen(false) }} title={t('localNewTask')}
      closeLabel={t('close')} description={t('localTaskHint')}>
      <Composer submit={async body => {
        submitting.current = true
        try {
          const result = await call('POST local/tasks', { body })
          setOpen(false)
          notify(t('localTaskQueued'))
          navigate({ page: 'trigger', id: result.thread, query: { trigger: result.triggerId } })
        } finally { submitting.current = false }
      }} />
    </Modal>
  </>
}

/** Outbox receipts include pending/dropped replies, so a paused or failed delivery is visible without duplicating messages. */
export function LocalReplies({ replies }: { replies: LocalConversation['replies'] }) {
  const { t } = usePanel()
  if (!replies.length) return <Hint>{t('localNoReplies')}</Hint>
  return <ul className="dt-list">{replies.map(reply => <li className="dt-row" key={reply.id}>
    <div className="dt-row-main">
      <div className="dt-row-meta"><span>{valueLabel(t, 'source', reply.channel.source)}</span>
        <Tag tone={reply.status === 'dropped' ? 'warning' : reply.status === 'pending' ? 'info' : 'neutral'}>
          {t(`localReply.${reply.status}`)}
        </Tag>
      </div>
      <MarkdownLite text={reply.text} />
    </div>
  </li>)}</ul>
}

export function TaskConversation({ ticketId, conversation, reload }: {
  ticketId: string; conversation: LocalConversation; reload: () => Promise<void>
}) {
  const { t, call, notify } = usePanel()
  return <Section title={t('localConversation')} icon="message">
    {conversation.messages.length > 0 && <ul className="dt-list">{conversation.messages.map(message => <li className="dt-row"
      key={message.id}><div className="dt-row-main">
      <div className="dt-row-meta"><span>{t('localOwner')}</span><When at={message.at} /></div>
      <MarkdownLite text={message.text} />
    </div></li>)}</ul>}
    <LocalReplies replies={conversation.replies} />
    {conversation.allowed ? <>
      <Hint>{t('localFollowupHint')}</Hint>
      <Composer followup submit={async body => {
        await call('POST tickets/:id/messages', { id: ticketId, body })
        notify(t('localFollowupSent'))
        await reload()
      }} />
    </> : <Hint>{t(`localRefusal.${conversation.reason ?? 'sourceOff'}`)}</Hint>}
  </Section>
}
