/**
 * 滑动窗口
 * 保留系统提示 + 最近 N 轮，丢弃更早的
 */

import { Message, estimateMessagesTokens } from './token-counter.js'

export interface WindowConfig {
  // token 上限（留出余量，不要顶满模型上限）
  maxTokens?: number
  // 至少保留最近几条消息
  minRecentMessages?: number
}

/**
 * 用滑动窗口裁剪消息历史
 * 系统提示永远保留，从最近往前保留，直到接近 token 上限
 */
export function applySlidingWindow(
  messages: Message[],
  config: WindowConfig = {},
): Message[] {
  const { maxTokens = 100000, minRecentMessages = 4 } = config

  // 分离系统提示和其他消息
  const systemMessages = messages.filter((m) => m.role === 'system')
  const otherMessages = messages.filter((m) => m.role !== 'system')

  // 系统提示的 token（必保留）
  const systemTokens = estimateMessagesTokens(systemMessages)
  let budget = maxTokens - systemTokens

  // 从最近往前，能放多少放多少
  const kept: Message[] = []
  for (let i = otherMessages.length - 1; i >= 0; i--) {
    const msg = otherMessages[i]
    const msgTokens = estimateMessagesTokens([msg])

    // 还放得下，或者还没达到最少保留数
    if (budget - msgTokens > 0 || kept.length < minRecentMessages) {
      kept.unshift(msg)
      budget -= msgTokens
    } else {
      break
    }
  }

  return [...systemMessages, ...kept]
}