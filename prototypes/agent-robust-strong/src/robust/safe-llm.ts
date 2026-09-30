// 第1节：带健壮性保护的大模型调用（超时+重试+降级）
import OpenAI from 'openai'
import { withRetry } from './retry.js'
import { withTimeout } from './timeout.js'
import { RetryableError } from './errors.js'
export interface SafeLLMConfig {
  apiKey: string
  baseURL?: string
  model?: string
  timeoutMs?: number
  maxRetries?: number
  fallbackModel?: string
}
export class SafeLLM {
  private client: OpenAI
  private config: Required<SafeLLMConfig>
  constructor(config: SafeLLMConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.deepseek.com/v1',
      model: config.model ?? 'deepseek-chat',
      timeoutMs: config.timeoutMs ?? 30000,
      maxRetries: config.maxRetries ?? 3,
      fallbackModel: config.fallbackModel ?? 'deepseek-chat',
    }
    this.client = new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseURL })
  }
  async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    model?: string,
  ): Promise<string> {
    const useModel = model ?? this.config.model
    try {
      const result = await withRetry(
        () => withTimeout(
          this.client.chat.completions.create({ model: useModel, messages }),
          this.config.timeoutMs, `模型调用(${useModel})`,
        ),
        {
          maxRetries: this.config.maxRetries,
          onRetry: (error, attempt, delay) => {
            console.warn(`[SafeLLM] 第 ${attempt} 次重试（等待 ${delay}ms）原因：${error.message}`)
          },
        },
      )
      const content = result.choices[0]?.message?.content
      if (!content) throw new RetryableError('模型返回了空内容')
      return content
    } catch (error: any) {
      if (model !== this.config.fallbackModel) {
        console.warn(`[SafeLLM] 主模型失败，降级到备用模型 ${this.config.fallbackModel}`)
        try { return await this.chat(messages, this.config.fallbackModel) } catch {}
      }
      console.error(`[SafeLLM] 调用彻底失败：${error.message}`)
      return `抱歉，AI 服务暂时不可用（${error.message}），请稍后再试。`
    }
  }
}
