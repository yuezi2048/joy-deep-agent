/**
 * 多供应商管理器（核心）
 * 自动故障转移 + 熔断
 */

import OpenAI from 'openai'
import { ProviderConfig } from './provider-config.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { withRetry } from '../01_failed_call/retry.js'
import { withTimeout } from '../01_failed_call/timeout.js'

interface ProviderRuntime {
  config: ProviderConfig
  client: OpenAI
  breaker: CircuitBreaker
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class MultiProvider {
  private providers: ProviderRuntime[]

  constructor(configs: ProviderConfig[]) {
    if (configs.length === 0) {
      throw new Error('至少要配置一个供应商')
    }
    this.providers = configs.map((config) => ({
      config,
      client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
      breaker: new CircuitBreaker(),
    }))
  }

  /**
   * 调用，自动在供应商间故障转移
   */
  async chat(messages: Message[]): Promise<string> {
    const errors: string[] = []

    // 按优先级依次尝试每个供应商
    for (const provider of this.providers) {
      // 熔断中的供应商，跳过
      if (!provider.breaker.canRequest()) {
        console.warn(`[MultiProvider] ${provider.config.name} 熔断中，跳过`)
        errors.push(`${provider.config.name}: 熔断中`)
        continue
      }

      try {
        console.log(`[MultiProvider] 尝试供应商：${provider.config.name}`)

        // 单个供应商内部也做重试和超时
        const result = await withRetry(
          () =>
            withTimeout(
              provider.client.chat.completions.create({
                model: provider.config.model,
                messages,
              }),
              30000,
              provider.config.name,
            ),
          { maxRetries: 2 },
        )

        const content = result.choices[0]?.message?.content
        if (!content) throw new Error('返回空内容')

        // 成功，记录并返回
        provider.breaker.recordSuccess()
        console.log(`[MultiProvider] ${provider.config.name} 调用成功`)
        return content
      } catch (error: any) {
        // 这个供应商失败，记录，转移到下一个
        provider.breaker.recordFailure()
        console.warn(
          `[MultiProvider] ${provider.config.name} 失败：${error.message}，转移到下一个供应商`,
        )
        errors.push(`${provider.config.name}: ${error.message}`)
      }
    }

    // 所有供应商都失败
    console.error('[MultiProvider] 所有供应商都不可用')
    return `抱歉，AI 服务暂时全部不可用。尝试记录：${errors.join('；')}`
  }

  /**
   * 查看各供应商当前状态
   */
  getStatus() {
    return this.providers.map((p) => ({
      name: p.config.name,
      priority: p.config.priority,
      circuitState: p.breaker.getState(),
    }))
  }
}