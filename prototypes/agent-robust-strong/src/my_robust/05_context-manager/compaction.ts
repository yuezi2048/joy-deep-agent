/**
 * 摘要压缩（Compaction）
 * 把早期历史压缩成摘要，保留关键信息
 */

import { Message, estimateMessagesTokens } from './token-counter.js'
import { SafeLLM } from '../01_failed_call/safe-llm.js'

export interface CompactionConfig {
  // 触发压缩的 token 阈值
  triggerTokens?: number
  // 保留最近几条不压缩
  keepRecent?: number
}

/**
 * 压缩消息历史
 * 把早期消息总结成一条摘要，最近的保留原样
 */
export async function compactMessages(
  messages: Message[],
  llm: SafeLLM,
  config: CompactionConfig = {},
): Promise<Message[]> {
  const { triggerTokens = 80000, keepRecent = 4 } = config

  // 没超过阈值，不压缩
  if (estimateMessagesTokens(messages) < triggerTokens) {
    return messages
  }

  const systemMessages = messages.filter((m) => m.role === 'system')
  const otherMessages = messages.filter((m) => m.role !== 'system')

  // 要压缩的（早期）和要保留的（最近）
  const toCompact = otherMessages.slice(0, -keepRecent)
  const toKeep = otherMessages.slice(-keepRecent)

  if (toCompact.length === 0) return messages

  // 让模型把早期对话总结成摘要
  const historyText = toCompact
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n')

  const summary = await llm.chat([
    {
      role: 'user',
      content: `请把下面这段对话历史压缩成一段简洁的摘要，保留关键信息、已完成的步骤、重要结论和待办事项，去掉冗余细节。直接给摘要，不要解释。

对话历史：
${historyText}`,
    },
  ])

  // 用摘要替代早期历史
  const summaryMessage: Message = {
    role: 'system',
    content: `【早期对话摘要】\n${summary}`,
  }

  console.log(
    `[Compaction] 压缩了 ${toCompact.length} 条消息为 1 条摘要`,
  )

  return [...systemMessages, summaryMessage, ...toKeep]
}