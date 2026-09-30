import { describe, expect, it } from 'vitest';
import { buildProviders, selectProvider } from '../src/providers/provider-config.js';

describe('buildProviders', () => {
  it('没配任何 Key 时返回空列表', () => {
    expect(buildProviders({})).toEqual([]);
  });

  it('按 priority 升序排列', () => {
    const providers = buildProviders({
      DEEPSEEK_API_KEY: 'd',
      OPENAI_API_KEY: 'o',
      QWEN_API_KEY: 'q',
    });
    expect(providers.map((p) => p.key)).toEqual(['deepseek', 'openai', 'qwen']);
  });

  it('OpenAI 在支持列表里（原型漏配的那家）', () => {
    const providers = buildProviders({ OPENAI_API_KEY: 'sk-test' });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      key: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
  });

  it('Ollama 只在 USE_OLLAMA=true 时出现，且不需要 Key', () => {
    expect(buildProviders({ USE_OLLAMA: 'true' }).map((p) => p.key)).toEqual(['ollama']);
    expect(buildProviders({ USE_OLLAMA: 'false' })).toEqual([]);
  });

  it('baseURL 与 model 可被覆盖', () => {
    const [provider] = buildProviders({
      DEEPSEEK_API_KEY: 'd',
      DEEPSEEK_BASE_URL: 'https://proxy.internal/v1',
      AGENT_MODEL: 'deepseek-reasoner',
    });
    expect(provider?.baseURL).toBe('https://proxy.internal/v1');
    expect(provider?.model).toBe('deepseek-reasoner');
  });
});

describe('selectProvider（零改动切换）', () => {
  const providers = buildProviders({ DEEPSEEK_API_KEY: 'd', OPENAI_API_KEY: 'o' });

  it('不指定时取 priority 最高的', () => {
    expect(selectProvider(providers).key).toBe('deepseek');
  });

  it('指定 key 即可切换供应商，调用方无需改代码', () => {
    expect(selectProvider(providers, 'openai').key).toBe('openai');
  });

  it('指定了不存在的供应商时，报错里列出可用项', () => {
    expect(() => selectProvider(providers, 'gemini')).toThrow(/deepseek, openai/);
  });

  it('一个都没配时给出可操作的提示', () => {
    expect(() => selectProvider([])).toThrow(/\.env/);
  });
});
