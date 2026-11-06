/** Read-only projection of confirmed result replies from the host's durable tool-call blocks. */
export interface ChatResult {
  callId: string
  text: string
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function json(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try { return record(JSON.parse(value)) } catch { return undefined }
}
const normalized = (text: string) => text.trim().replace(/\s+/g, ' ')

/** A finished tool call alone is insufficient: only the same call's explicit sent receipt confirms delivery. */
export function chatResults(blocks: readonly unknown[], assistantTexts: readonly string[] = []): ChatResult[] {
  const results: ChatResult[] = []
  const seen = new Set<string>()
  const visited = new Set<unknown>()
  const existing = assistantTexts.map(normalized).filter(Boolean)
  const visit = (value: unknown) => {
    const block = record(value)
    if (!block || visited.has(block)) return
    visited.add(block)
    const call = record(block.call)
    if (block.kind === 'tool-result' && call?.name === 'orchestrator_reply' && block.isError !== true && !block.error &&
      typeof block.callId === 'string' && Array.isArray(block.content)) {
      const args = json(call.argsRaw)
      const receipt = json(block.content.map(part => {
        const item = record(part)
        return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
      }).join(''))
      if (args?.purpose === 'result' && typeof args.text === 'string' && args.text.trim() && receipt?.status === 'sent') {
        const identity = JSON.stringify([args.ticket_id ?? null, args.trigger_id ?? null, args.text])
        if (!seen.has(identity) && !existing.some(text => text.includes(normalized(args.text as string)))) {
          seen.add(identity)
          results.push({ callId: block.callId, text: args.text })
        }
      }
    }
    // PTC dispatch children retain their own correlated call/result blocks.
    if (Array.isArray(block.subCalls)) block.subCalls.forEach(visit)
  }
  blocks.forEach(visit)
  return results
}
