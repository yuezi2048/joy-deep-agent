import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentLoop, type AgentLoopOptions } from '../src/core/agent-loop.js';
import { InMemoryCheckpointStore } from '../src/memory/checkpoint-store.js';
import type { ChatResponse } from '../src/providers/chat-model.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { StubChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

function twoTools() {
  const calls: string[] = [];
  const make = (name: string) => ({
    name,
    description: name,
    schema: z.object({ key: z.string() }),
    handler: async ({ key }: { key: string }) => {
      calls.push(`${name}:${key}`);
      return `${name} 看到了 ${key}`;
    },
  });
  const tools = new ToolRegistry().register(make('lookup')).register(make('update'));
  return { tools, calls };
}

/** 按剧本回放，剧本用完后再决定是「一直挂着」还是给个收尾回答。 */
function scriptedModel(script: ChatResponse[], afterScript: () => Promise<ChatResponse>) {
  const model = new StubChatModel('fake', () => {
    const next = script.shift();
    return next ? Promise.resolve(next) : afterScript();
  });
  return model;
}

describe('死循环治理 · 横跳检测', () => {
  it('A/B/A/B 在两个工具之间来回绕时提前停止，原因可区分', async () => {
    const { tools, calls } = twoTools();
    const model = scriptedModel(
      [
        toolTurn('lookup', { key: 'x' }),
        toolTurn('update', { key: 'x' }),
        toolTurn('lookup', { key: 'x' }),
        toolTurn('update', { key: 'x' }),
      ],
      async () => answerTurn('不该走到这里'),
    );

    const result = await new AgentLoop({ model, tools, options: { maxSteps: 20 } }).run('绕圈');

    expect(result.stopReason).toBe('loop_detected');
    expect(result.stopDetail).toContain('周期 2');
    expect(result.steps).toBe(4); // 检出那一轮仍然执行完
    expect(calls).toEqual(['lookup:x', 'update:x', 'lookup:x', 'update:x']);
    // 轨迹完整：assistant 声明的每个调用都有对应的 tool 结果
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(4);
  });

  it('周期 3 的横跳同样能检出', async () => {
    const { tools } = twoTools();
    const plan = [
      ['lookup', 'k0'],
      ['update', 'k1'],
      ['lookup', 'k2'],
      ['lookup', 'k0'],
      ['update', 'k1'],
      ['lookup', 'k2'],
    ] as const;
    const model = scriptedModel(
      plan.map(([name, key], index) => toolTurn(name, { key }, `c${index}`)),
      async () => answerTurn('不该走到这里'),
    );

    const result = await new AgentLoop({ model, tools, options: { maxSteps: 20 } }).run('绕圈');

    expect(result.stopReason).toBe('loop_detected');
    expect(result.stopDetail).toContain('周期 3');
    expect(result.steps).toBe(6);
  });

  it('正常任务不被误杀：调用各不相同就一路跑完', async () => {
    const { tools } = twoTools();
    const model = scriptedModel(
      [
        toolTurn('lookup', { key: 'a' }),
        toolTurn('lookup', { key: 'b' }),
        toolTurn('update', { key: 'c' }),
      ],
      async () => answerTurn('都处理完了'),
    );

    const result = await new AgentLoop({ model, tools, options: { maxSteps: 20 } }).run('正常任务');

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('都处理完了');
  });

  it('A/B/A 这种还看不出周期的序列不误判', async () => {
    const { tools } = twoTools();
    const model = scriptedModel(
      [
        toolTurn('lookup', { key: 'x' }),
        toolTurn('update', { key: 'x' }),
        toolTurn('lookup', { key: 'x' }),
      ],
      async () => answerTurn('我收敛了'),
    );

    const result = await new AgentLoop({ model, tools, options: { maxSteps: 20 } }).run('先查再改');

    expect(result.stopReason).toBe('completed');
  });
});

describe('死循环治理 · 墙钟上限', () => {
  it('步与步之间累计超时就停下，并把已产生的轨迹留着', async () => {
    let clock = 0;
    const { tools } = twoTools();
    let index = 0;
    const model = new StubChatModel('fake', async () => {
      clock += 400; // 每一次模型调用都很慢
      index += 1;
      return toolTurn('lookup', { key: `k${index}` }, `c${index}`);
    });

    const result = await new AgentLoop({
      model,
      tools,
      options: { maxSteps: 20, maxDurationMs: 1_000, now: () => clock },
    }).run('慢任务');

    expect(result.stopReason).toBe('timeout');
    expect(result.stopDetail).toContain('超过墙钟上限 1000ms');
    // 每步 400ms：跑完 3 步后累计 1200ms 已过 1000ms，第 4 步不再发起
    expect(result.steps).toBe(3);
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(3);
  });

  it('在飞的调用到点会被掐断，且轨迹保持完整合法', async () => {
    const { tools } = twoTools();
    const signals: (AbortSignal | undefined)[] = [];
    const script: ChatResponse[] = [toolTurn('lookup', { key: 'x' })];
    const model = new StubChatModel('fake', (request) => {
      signals.push(request.signal);
      const next = script.shift();
      if (next) return Promise.resolve(next);
      // 之后一直挂着，模拟卡死的供应商
      return new Promise<ChatResponse>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('调用被掐断')));
      });
    });

    const result = await new AgentLoop({
      model,
      tools,
      options: { maxDurationMs: 30 },
    }).run('会卡住的任务');

    expect(result.stopReason).toBe('timeout');
    expect(signals[0]?.aborted).toBe(true); // 在飞的那次调用收到了中断
    // 轨迹完整：user → assistant(调用) → tool(结果)，没有半截结构
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(result.messages[1]?.toolCalls).toHaveLength(1);
    expect(result.messages[2]?.toolCallId).toBe(result.messages[1]?.toolCalls?.[0]?.id);
  });

  it('maxDurationMs 为 0 表示不限时', async () => {
    let clock = 0;
    const { tools } = twoTools();
    const model = new StubChatModel('fake', async () => {
      clock += 60 * 60 * 1_000;
      return answerTurn('慢是慢，但跑完了');
    });

    const result = await new AgentLoop({
      model,
      tools,
      options: { maxDurationMs: 0, now: () => clock },
    }).run('不限时的任务');

    expect(result.stopReason).toBe('completed');
  });

  it('超时后检查点还在，续跑不用重来', async () => {
    const { tools } = twoTools();
    const store = new InMemoryCheckpointStore();
    const script: ChatResponse[] = [toolTurn('lookup', { key: 'x' })];
    const model = new StubChatModel('fake', (request) => {
      const next = script.shift();
      if (next) return Promise.resolve(next);
      return new Promise<ChatResponse>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('调用被掐断')));
      });
    });

    const result = await new AgentLoop({
      model,
      tools,
      options: { maxDurationMs: 30, checkpoint: { store, id: 'slow-1' } },
    }).run('会卡住的任务');

    expect(result.stopReason).toBe('timeout');
    const saved = await store.load<{ messages: unknown[] }>('slow-1');
    expect(saved?.state.messages).toHaveLength(3);
  });

  it('卡死的模型不会让 run() 一直等下去', async () => {
    const { tools } = twoTools();
    const model = new StubChatModel('fake', (request) =>
      new Promise<ChatResponse>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('调用被掐断')));
        if (!request.signal) reject(new Error('调用没有带上可中断的信号'));
      }),
    );

    const startedAt = Date.now();
    const result = await new AgentLoop({ model, tools, options: { maxDurationMs: 20 } }).run('卡住');

    expect(result.stopReason).toBe('timeout');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('四个停止原因可区分', () => {
  const run = async (options: AgentLoopOptions, script: ChatResponse[]) => {
    const { tools } = twoTools();
    const model = scriptedModel(script, async () => answerTurn('没了'));
    return new AgentLoop({ model, tools, options }).run('跑');
  };

  it('步数用尽 → max_steps，无进展 → no_progress，横跳 → loop_detected', async () => {
    const capped = await run({ maxSteps: 1, maxDurationMs: 0 }, [toolTurn('lookup', { key: 'x' })]);
    expect(capped.stopReason).toBe('max_steps');

    const spinning = await run({ maxSteps: 10, maxDurationMs: 0 }, [
      toolTurn('lookup', { key: 'x' }),
      toolTurn('lookup', { key: 'x' }),
      toolTurn('lookup', { key: 'x' }),
    ]);
    expect(spinning.stopReason).toBe('no_progress');

    const hopping = await run({ maxSteps: 10, maxDurationMs: 0 }, [
      toolTurn('lookup', { key: 'x' }),
      toolTurn('update', { key: 'x' }),
      toolTurn('lookup', { key: 'x' }),
      toolTurn('update', { key: 'x' }),
    ]);
    expect(hopping.stopReason).toBe('loop_detected');

    expect(new Set([capped.stopReason, spinning.stopReason, hopping.stopReason]).size).toBe(3);
  });
});
