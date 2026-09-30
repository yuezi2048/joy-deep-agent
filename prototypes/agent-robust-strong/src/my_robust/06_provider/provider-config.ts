/**
 * 供应商配置
 * 定义多个大模型供应商，按优先级排列
 */

export interface ProviderConfig {
  // 供应商名称（用于日志）
  name: string
  // API 地址
  baseURL: string
  // API Key
  apiKey: string
  // 模型名
  model: string
  // 优先级，数字越小越优先
  priority: number
}

/**
 * 从环境变量构建供应商列表
 * 实际项目里 key 都从 .env 读
 */
export function buildProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = []

  // 主供应商：DeepSeek
  if (process.env.DEEPSEEK_API_KEY) {
    providers.push({
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
      priority: 1,
    })
  }

  // 备用1：通义千问（兼容 OpenAI 接口）
  if (process.env.QWEN_API_KEY) {
    providers.push({
      name: '通义千问',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: process.env.QWEN_API_KEY,
      model: 'qwen-plus',
      priority: 2,
    })
  }

  // 备用2：本地 Ollama（最后的兜底，免费且不依赖外部服务）
  if (process.env.USE_OLLAMA === 'true') {
    providers.push({
      name: 'Ollama本地',
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: process.env.OLLAMA_MODEL ?? 'qwen2.5',
      priority: 99,
    })
  }

  // 按优先级排序
  return providers.sort((a, b) => a.priority - b.priority)
}