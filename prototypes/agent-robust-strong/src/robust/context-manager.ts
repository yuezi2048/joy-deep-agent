// 第5节：上下文管理器
import { Message, estimateMessagesTokens } from './token-counter.js'
import { applySlidingWindow } from './sliding-window.js'
import { compactMessages } from './compaction.js'
import { SafeLLM } from './safe-llm.js'
export type Strategy = 'sliding' | 'compaction'
export interface ContextManagerConfig {
  maxTokens?: number
  strategy?: Strategy
  llm?: SafeLLM
}
export class ContextManager {
  private config: Required<Omit<ContextManagerConfig, 'llm'>>
  private llm?: SafeLLM
  constructor(config: ContextManagerConfig = {}) {
    this.config = { maxTokens: config.maxTokens ?? 100000, strategy: config.strategy ?? 'compaction' }
    this.llm = config.llm
  }
  async manage(messages: Message[]): Promise<Message[]> {
    const currentTokens = estimateMessagesTokens(messages)
    console.log(`[Context] 当前约 ${currentTokens} token / 上限 ${this.config.maxTokens}`)
    if (currentTokens < this.config.maxTokens) return messages
    console.log(`[Context] 接近上限，启用 ${this.config.strategy} 策略`)
    if (this.config.strategy === 'compaction' && this.llm) {
      const compacted = await compactMessages(messages, this.llm, { triggerTokens: this.config.maxTokens })
      if (estimateMessagesTokens(compacted) >= this.config.maxTokens) {
        return applySlidingWindow(compacted, { maxTokens: this.config.maxTokens })
      }
      return compacted
    }
    return applySlidingWindow(messages, { maxTokens: this.config.maxTokens })
  }
}
