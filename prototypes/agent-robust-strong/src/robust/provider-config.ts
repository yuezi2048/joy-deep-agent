// 第6节：供应商配置
export interface ProviderConfig {
  name: string
  baseURL: string
  apiKey: string
  model: string
  priority: number
}
export function buildProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = []
  if (process.env.DEEPSEEK_API_KEY) {
    providers.push({ name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY, model: 'deepseek-chat', priority: 1 })
  }
  if (process.env.QWEN_API_KEY) {
    providers.push({ name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: process.env.QWEN_API_KEY, model: 'qwen-plus', priority: 2 })
  }
  if (process.env.USE_OLLAMA === 'true') {
    providers.push({ name: 'Ollama本地', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama', model: process.env.OLLAMA_MODEL ?? 'qwen2.5', priority: 99 })
  }
  return providers.sort((a, b) => a.priority - b.priority)
}
