/**
 * 供应商配置。四家都提供 OpenAI 兼容的 /chat/completions，
 * 所以「DeepSeek / OpenAI 零改动切换」等于换一条配置，而不是换一套代码（见 ADR-0003）。
 */
export interface ProviderConfig {
  /** 稳定标识，用于 AGENT_PROVIDER 选中与日志展示 */
  key: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  priority: number;
}

export interface ProviderEnv {
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  QWEN_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  OPENAI_BASE_URL?: string;
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
  USE_OLLAMA?: string;
  AGENT_MODEL?: string;
}

export const DEFAULT_BASE_URLS = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  ollama: 'http://localhost:11434/v1',
} as const;

export const DEFAULT_MODELS = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
  qwen: 'qwen-plus',
  ollama: 'qwen2.5',
} as const;

/** 按环境变量拼出可用供应商，按 priority 升序（数字小的先用）。没配 Key 的自动跳过。 */
export function buildProviders(env: ProviderEnv = process.env as ProviderEnv): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  if (env.DEEPSEEK_API_KEY) {
    providers.push({
      key: 'deepseek',
      name: 'DeepSeek',
      baseURL: env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URLS.deepseek,
      apiKey: env.DEEPSEEK_API_KEY,
      model: env.AGENT_MODEL || DEFAULT_MODELS.deepseek,
      priority: 1,
    });
  }

  if (env.OPENAI_API_KEY) {
    providers.push({
      key: 'openai',
      name: 'OpenAI',
      baseURL: env.OPENAI_BASE_URL || DEFAULT_BASE_URLS.openai,
      apiKey: env.OPENAI_API_KEY,
      model: env.AGENT_MODEL || DEFAULT_MODELS.openai,
      priority: 2,
    });
  }

  if (env.QWEN_API_KEY) {
    providers.push({
      key: 'qwen',
      name: '通义千问',
      baseURL: DEFAULT_BASE_URLS.qwen,
      apiKey: env.QWEN_API_KEY,
      model: env.AGENT_MODEL || DEFAULT_MODELS.qwen,
      priority: 3,
    });
  }

  if (env.USE_OLLAMA === 'true') {
    providers.push({
      key: 'ollama',
      name: 'Ollama 本地',
      baseURL: env.OLLAMA_BASE_URL || DEFAULT_BASE_URLS.ollama,
      apiKey: 'ollama',
      model: env.AGENT_MODEL || env.OLLAMA_MODEL || DEFAULT_MODELS.ollama,
      priority: 99,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

/** 选中默认供应商：优先按 key，其次取 priority 最高的可用项。 */
export function selectProvider(providers: readonly ProviderConfig[], key?: string): ProviderConfig {
  if (providers.length === 0) {
    throw new Error('没有可用的模型供应商，请在 .env 中至少配置一个 API Key（参考 .env.example）');
  }
  if (key) {
    const matched = providers.find((provider) => provider.key === key);
    if (!matched) {
      const available = providers.map((provider) => provider.key).join(', ');
      throw new Error(`AGENT_PROVIDER="${key}" 未配置对应的 Key。当前可用：${available}`);
    }
    return matched;
  }
  return providers[0]!;
}
