/**
 * 上下文管理器
 * 集成 token 计数 + 滑动窗口/压缩 + 溢出兜底
 */

import { Message, estimateMessagesTokens } from './token-counter.js'
import { applySlidingWindow } from './sliding-window.js'
import { compactMessages } from './compaction.js'
import { SafeLLM } from '../01_failed_call/safe-llm.js'

export type Strategy = 'sliding' | 'compaction'

export interface ContextManagerConfig {
  maxTokens?: number
  strategy?: Strategy
  llm?: SafeLLM  // compaction 策略需要
}

export class ContextManager {
  private config: Required<Omit<ContextManagerConfig, 'llm'>>
  private llm?: SafeLLM

  constructor(config: ContextManagerConfig = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 100000,
      strategy: config.strategy ?? 'compaction',
    }
    this.llm = config.llm
  }

  /**
   * 处理消息历史，确保不超上下文
   */
  async manage(messages: Message[]): Promise<Message[]> {
    const currentTokens = estimateMessagesTokens(messages)
    console.log(
      `[Context] 当前约 ${currentTokens} token / 上限 ${this.config.maxTokens}`,
    )

    // 没超，直接返回
    if (currentTokens < this.config.maxTokens) {
      return messages
    }

    console.log(`[Context] 接近上限，启用 ${this.config.strategy} 策略`)

    // 压缩策略
    if (this.config.strategy === 'compaction' && this.llm) {
      const compacted = await compactMessages(messages, this.llm, {
        triggerTokens: this.config.maxTokens,
      })
      // 压缩后还是太大，再叠加滑动窗口兜底
      if (estimateMessagesTokens(compacted) >= this.config.maxTokens) {
        return applySlidingWindow(compacted, { maxTokens: this.config.maxTokens })
      }
      return compacted
    }

    // 滑动窗口策略（或没提供 llm 时的兜底）
    return applySlidingWindow(messages, { maxTokens: this.config.maxTokens })
  }
}