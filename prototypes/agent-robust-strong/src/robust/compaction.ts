// 第5节：摘要压缩
import { Message, estimateMessagesTokens } from './token-counter.js'
import { SafeLLM } from './safe-llm.js'
export interface CompactionConfig {
  triggerTokens?: number
  keepRecent?: number
}
export async function compactMessages(messages: Message[], llm: SafeLLM, config: CompactionConfig = {}): Promise<Message[]> {
  const { triggerTokens = 80000, keepRecent = 4 } = config
  if (estimateMessagesTokens(messages) < triggerTokens) return messages
  const systemMessages = messages.filter((m) => m.role === 'system')
  const otherMessages = messages.filter((m) => m.role !== 'system')
  const toCompact = otherMessages.slice(0, -keepRecent)
  const toKeep = otherMessages.slice(-keepRecent)
  if (toCompact.length === 0) return messages
  const historyText = toCompact.map((m) => `[${m.role}] ${m.content}`).join('\n')
  const summary = await llm.chat([{
    role: 'user',
    content: `请把下面这段对话历史压缩成一段简洁的摘要，保留关键信息、已完成的步骤、重要结论和待办事项，去掉冗余细节。直接给摘要，不要解释。\n\n对话历史：\n${historyText}`,
  }])
  const summaryMessage: Message = { role: 'system', content: `【早期对话摘要】\n${summary}` }
  console.log(`[Compaction] 压缩了 ${toCompact.length} 条消息为 1 条摘要`)
  return [...systemMessages, summaryMessage, ...toKeep]
}
