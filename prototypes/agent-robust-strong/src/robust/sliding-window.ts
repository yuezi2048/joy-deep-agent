// 第5节：滑动窗口
import { Message, estimateMessagesTokens } from './token-counter.js'
export interface WindowConfig {
  maxTokens?: number
  minRecentMessages?: number
}
export function applySlidingWindow(messages: Message[], config: WindowConfig = {}): Message[] {
  const { maxTokens = 100000, minRecentMessages = 4 } = config
  const systemMessages = messages.filter((m) => m.role === 'system')
  const otherMessages = messages.filter((m) => m.role !== 'system')
  const systemTokens = estimateMessagesTokens(systemMessages)
  let budget = maxTokens - systemTokens
  const kept: Message[] = []
  for (let i = otherMessages.length - 1; i >= 0; i--) {
    const msg = otherMessages[i]
    const msgTokens = estimateMessagesTokens([msg])
    if (budget - msgTokens > 0 || kept.length < minRecentMessages) {
      kept.unshift(msg)
      budget -= msgTokens
    } else break
  }
  return [...systemMessages, ...kept]
}
