// 第6节：多供应商管理器（故障转移 + 熔断）
import OpenAI from 'openai'
import { ProviderConfig } from './provider-config.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { withRetry } from './retry.js'
import { withTimeout } from './timeout.js'
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
    if (configs.length === 0) throw new Error('至少要配置一个供应商')
    this.providers = configs.map((config) => ({
      config,
      client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
      breaker: new CircuitBreaker(),
    }))
  }
  async chat(messages: Message[]): Promise<string> {
    const errors: string[] = []
    for (const provider of this.providers) {
      if (!provider.breaker.canRequest()) {
        console.warn(`[MultiProvider] ${provider.config.name} 熔断中，跳过`)
        errors.push(`${provider.config.name}: 熔断中`)
        continue
      }
      try {
        console.log(`[MultiProvider] 尝试供应商：${provider.config.name}`)
        const result = await withRetry(
          () => withTimeout(
            provider.client.chat.completions.create({ model: provider.config.model, messages }),
            30000, provider.config.name,
          ),
          { maxRetries: 2 },
        )
        const content = result.choices[0]?.message?.content
        if (!content) throw new Error('返回空内容')
        provider.breaker.recordSuccess()
        console.log(`[MultiProvider] ${provider.config.name} 调用成功`)
        return content
      } catch (error: any) {
        provider.breaker.recordFailure()
        console.warn(`[MultiProvider] ${provider.config.name} 失败：${error.message}，转移到下一个供应商`)
        errors.push(`${provider.config.name}: ${error.message}`)
      }
    }
    console.error('[MultiProvider] 所有供应商都不可用')
    return `抱歉，AI 服务暂时全部不可用。尝试记录：${errors.join('；')}`
  }
  getStatus() {
    return this.providers.map((p) => ({ name: p.config.name, priority: p.config.priority, circuitState: p.breaker.getState() }))
  }
}
