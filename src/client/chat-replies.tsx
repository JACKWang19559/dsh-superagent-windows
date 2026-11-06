/** Show already delivered task results outside the host's collapsed execution details. */
import { useMemo, useSyncExternalStore } from 'react'
import type { AssistantChatData, ChatNodeStore, ChatSnapshot, ToolChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { chatResults } from './chat-results.ts'
import { readableMarkers, type T } from './text.ts'
import { MarkdownContent } from './widgets.tsx'
import STYLES from './chat-replies.css?raw'

export type ChatRepliesProps = PropsRuntime<'conversation.chat.turnTail'> & { t: T }
export function ChatReplies({ turn, useChat, t }: ChatRepliesProps) {
  const nodes: ChatNodeStore = useChat((snapshot: ChatSnapshot) => snapshot.nodes)
  const toolSource = useMemo(() => nodes.turnDataSource(turn.turn, 'tool-call'), [nodes, turn.turn])
  const assistantSource = useMemo(() => nodes.turnDataSource(turn.turn, 'assistant-step'), [nodes, turn.turn])
  const tools = useSyncExternalStore<readonly ToolChatData[]>(toolSource.subscribe, toolSource.getSnapshot, toolSource.getSnapshot)
  const assistants = useSyncExternalStore<readonly AssistantChatData[]>(assistantSource.subscribe, assistantSource.getSnapshot, assistantSource.getSnapshot)
  const replies = useMemo(() => chatResults(tools.map(tool => tool.root), assistants.filter(step => step.status === 'settled')
    .map(step => step.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n'))), [tools, assistants])
  if (turn.status !== 'closed' || !replies.length) return null
  return <section className="dt-chat-replies" aria-label={t('chatReplyResult')}>
    <style>{STYLES}</style>
    {replies.map(reply => <article className="dt-chat-reply" data-superagent-result={reply.callId} key={reply.callId}>
      <div className="dt-chat-reply-header"><strong>{t('chatReplyResult')}</strong><span>{t('chatReplySent')}</span></div>
      <MarkdownContent text={readableMarkers(t, reply.text)} />
    </article>)}
  </section>
}
