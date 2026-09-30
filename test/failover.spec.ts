import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/core/agent-loop.js';
import { CancelledError, RetryableError } from '../src/core/errors.js';
import type { ChatModel, ChatRequest, ChatResponse, StreamChunk } from '../src/providers/chat-model.js';
import {
  AllProvidersFailedError,
  FailoverChatModel,
  StreamInterruptedError,
  formatFailoverEvent,
} from '../src/providers/failover-model.js';
import { createFailoverModel, type ProviderConfig } from '../src/providers/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { answerTurn, toolTurn } from './helpers/fake-model.js';

/** 可编程的假供应商：行为随时可换，顺便数调用次数。 */
class StubModel implements ChatModel {
  readonly supportsTools = true;
  readonly model = 'stub-1';
  calls = 0;
  behavior: (request: ChatRequest) => Promise<ChatResponse>;
  streamBehavior?: (request: ChatRequest) => AsyncIterable<StreamChunk>;

  constructor(
    readonly name: string,
    behavior: (request: ChatRequest) => Promise<ChatResponse>,
    streamBehavior?: (request: ChatRequest) => AsyncIterable<StreamChunk>,
  ) {
    this.behavior = behavior;
    this.streamBehavior = streamBehavior;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    return this.behavior(request);
  }

  chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.calls++;
    return this.streamBehavior ? this.streamBehavior(request) : toStream(this.behavior(request));
  }
}

async function* toStream(response: Promise<ChatResponse>): AsyncIterable<StreamChunk> {
  const value = await response;
  if (value.content) yield { type: 'text', delta: value.content };
  yield {
    type: 'done',
    finishReason: value.finishReason,
    toolCalls: value.toolCalls,
    usage: value.usage,
  };
}

const failing = (name: string, error: Error = new RetryableError('429 限流')) =>
  new StubModel(name, async () => {
    throw error;
  });

const answering = (name: string, content: string) =>
  new StubModel(name, async () => answerTurn(content));

const member = (key: string, label: string, model: ChatModel) => ({ key, label, model });

describe('FailoverChatModel（供应商故障转移）', () => {
  it('主供应商失败后自动按顺序切到下一个，并把结果原样返回', async () => {
    const primary = failing('deepseek');
    const backup = answering('openai', '备用回答');
    const model = new FailoverChatModel([
      member('deepseek', 'DeepSeek', primary),
      member('openai', 'OpenAI', backup),
    ]);

    const response = await model.chat({ messages: [] });

    expect(response.content).toBe('备用回答');
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
    // 单次失败还没到阈值：记了一笔，但没熔断
    expect(model.states()).toEqual([
      expect.objectContaining({ key: 'deepseek', state: 'closed', failureCount: 1, available: true }),
      expect.objectContaining({ key: 'openai', state: 'closed', failureCount: 0, available: true }),
    ]);
  });

  it('连续失败到阈值后熔断，之后的请求直接跳过该供应商', async () => {
    const primary = failing('deepseek');
    const backup = answering('openai', 'ok');
    const model = new FailoverChatModel(
      [member('deepseek', 'DeepSeek', primary), member('openai', 'OpenAI', backup)],
      { circuit: { failureThreshold: 2 } },
    );

    await model.chat({ messages: [] });
    await model.chat({ messages: [] });
    await model.chat({ messages: [] });

    expect(primary.calls).toBe(2); // 第三次被熔断挡住，没再碰它
    expect(backup.calls).toBe(3);
    expect(model.states()[0]).toMatchObject({ state: 'open', available: false });
  });

  it('冷却到期后放探路请求：成功就闭合，失败则重新打开', async () => {
    let now = 1_000;
    const primary = failing('a');
    const backup = answering('b', 'ok');
    const model = new FailoverChatModel(
      [member('a', 'A', primary), member('b', 'B', backup)],
      { circuit: { failureThreshold: 1, resetTimeoutMs: 1_000, now: () => now } },
    );

    await model.chat({ messages: [] });
    expect(primary.calls).toBe(1);
    expect(model.states()[0]).toMatchObject({ state: 'open', available: false });

    // 查询熔断状态是只读的：到点了 available 变 true，但状态不会因为「被看了一眼」就迁移
    now += 1_000;
    expect(model.states()[0]).toMatchObject({ state: 'open', available: true });

    primary.behavior = async () => answerTurn('主供应商恢复了');
    const response = await model.chat({ messages: [] });

    expect(response.content).toBe('主供应商恢复了');
    expect(primary.calls).toBe(2); // 探路请求真的发给了主供应商
    expect(model.states()[0]).toMatchObject({ state: 'closed', failureCount: 0 });

    // 探路失败则重新打开
    now += 1_000;
    primary.behavior = async () => {
      throw new RetryableError('又挂了');
    };
    await model.chat({ messages: [] });
    expect(model.states()[0]).toMatchObject({ state: 'open' });
  });

  it('全部不可用时抛出可读的失败反馈，而不是裸异常', async () => {
    const model = new FailoverChatModel([
      member('deepseek', 'DeepSeek', failing('deepseek', new RetryableError('429 限流'))),
      member('openai', 'OpenAI', failing('openai', new Error('ENOTFOUND api.openai.com'))),
    ]);

    const error = await model.chat({ messages: [] }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AllProvidersFailedError);
    const failure = error as AllProvidersFailedError;
    expect(failure.attempts.map((attempt) => attempt.provider)).toEqual(['deepseek', 'openai']);
    expect(failure.message).toContain('DeepSeek：429 限流');
    expect(failure.message).toContain('OpenAI：ENOTFOUND');
    expect(failure.message).toContain('请检查 API Key / 网络 / 配额');
  });

  it('用户中断不算供应商故障，不再往下消耗别的供应商', async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = failing('a', new CancelledError('用户按了停止'));
    const backup = answering('b', '不该被调用');
    const model = new FailoverChatModel([member('a', 'A', primary), member('b', 'B', backup)]);

    await expect(model.chat({ messages: [], signal: controller.signal })).rejects.toThrow(
      /用户按了停止/,
    );
    expect(backup.calls).toBe(0);
  });
});

describe('FailoverChatModel · 流式', () => {
  it('还没吐出增量就失败：换供应商重来，用户看到完整的一份输出', async () => {
    const primary = failing('a');
    const backup = answering('b', '完整的回答');
    const model = new FailoverChatModel([member('a', 'A', primary), member('b', 'B', backup)]);

    const chunks: string[] = [];
    for await (const chunk of model.chatStream({ messages: [] })) {
      if (chunk.type === 'text') chunks.push(chunk.delta);
    }

    expect(chunks).toEqual(['完整的回答']);
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
  });

  it('已经吐出增量后失败：不换供应商重来（否则用户会看到两遍）', async () => {
    const primary = new StubModel(
      'a',
      async () => answerTurn('不该走这里'),
      async function* () {
        yield { type: 'text', delta: '前半段' };
        throw new RetryableError('连接断了');
      },
    );
    const backup = answering('b', '后半段重来');
    const model = new FailoverChatModel([member('a', 'A', primary), member('b', 'B', backup)]);

    const chunks: string[] = [];
    const error = await (async () => {
      try {
        for await (const chunk of model.chatStream({ messages: [] })) {
          if (chunk.type === 'text') chunks.push(chunk.delta);
        }
        return null;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(StreamInterruptedError);
    expect(chunks).toEqual(['前半段']); // 只有一份，没有被备供应商重放
    expect(backup.calls).toBe(0);
  });

  it('流式下全挂同样给出可读反馈', async () => {
    const model = new FailoverChatModel([
      member('a', 'A', failing('a')),
      member('b', 'B', failing('b', new Error('连接被重置'))),
    ]);

    const error = await (async () => {
      try {
        for await (const _chunk of model.chatStream({ messages: [] })) {
          // 不该产出任何东西
        }
        return null;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(AllProvidersFailedError);
  });
});

describe('故障转移 · 对上层透明', () => {
  it('AgentLoop 零改动：换上故障转移模型后照常跑完一次工具调用', async () => {
    const script = [toolTurn('add', { a: 2, b: 3 }), answerTurn('答案是 5')];
    const primary = failing('a');
    const backup = new StubModel('b', async () => script.shift() ?? answerTurn('剧本没了'));
    const tools = new ToolRegistry().register({
      name: 'add',
      description: '加法',
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: async ({ a, b }: { a: number; b: number }) => String(a + b),
    });
    const model = new FailoverChatModel([member('a', 'A', primary), member('b', 'B', backup)]);

    const result = await new AgentLoop({ model, tools }).run('2+3 等于几');

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('答案是 5');
    expect(result.toolCalls).toHaveLength(1);
    expect(primary.calls).toBe(2); // 两次模型调用各被主供应商拒了一次
    expect(backup.calls).toBe(2);
  });

  it('转移过程可通过 onEvent 观察（日志 / 评测都靠它）', async () => {
    const events: string[] = [];
    const model = new FailoverChatModel(
      [member('a', 'A', failing('a')), member('b', 'B', answering('b', 'ok'))],
      { onEvent: (event) => events.push(event.type) },
    );

    await model.chat({ messages: [] });

    expect(events).toEqual(['attempt', 'failed', 'switched', 'attempt', 'succeeded']);
  });

  it('事件文案：正常一次成功不产生噪音', () => {
    expect(formatFailoverEvent({ type: 'succeeded', provider: 'a', attempts: 1 })).toBeNull();
    expect(formatFailoverEvent({ type: 'attempt', provider: 'a', attempt: 1 })).toBeNull();
    expect(formatFailoverEvent({ type: 'switched', from: 'a', to: 'b', reason: '限流' })).toBe(
      'a 不可用，切换到 b（原因：限流）',
    );
    expect(
      formatFailoverEvent({
        type: 'succeeded',
        provider: 'b',
        attempts: 2,
      }),
    ).toBe('第 2 次尝试成功（b）');
  });

  it('装配：多供应商套壳、单供应商不套壳', () => {
    const deepseek: ProviderConfig = {
      key: 'deepseek',
      name: 'DeepSeek',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'deepseek-chat',
      priority: 1,
    };
    const openai: ProviderConfig = {
      key: 'openai',
      name: 'OpenAI',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      priority: 2,
    };

    const wrapped = createFailoverModel([deepseek, openai], { primaryKey: 'openai' });
    expect(wrapped).toBeInstanceOf(FailoverChatModel);
    expect(wrapped.name).toBe('failover(OpenAI → DeepSeek)');

    expect(createFailoverModel([deepseek])).not.toBeInstanceOf(FailoverChatModel);
  });
});
