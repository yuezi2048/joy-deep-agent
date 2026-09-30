import { HttpException } from '@nestjs/common';
import { firstValueFrom, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentController } from '../src/nest/agent.controller.js';
import { AgentService } from '../src/nest/agent.service.js';
import type { AgentRuntime } from '../src/nest/runtime.js';
import type { ChatResponse } from '../src/providers/chat-model.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

function makeRuntime(script: ChatResponse[], tools = new ToolRegistry()) {
  const model = new FakeChatModel(script);
  return { runtime: { model, tools } satisfies AgentRuntime, model };
}

describe('AgentService（服务化外壳）', () => {
  it('暴露运行时自检信息', () => {
    const tools = new ToolRegistry().register({
      name: 'ping',
      description: 'ping',
      schema: z.object({}),
      handler: async () => 'pong',
    });
    const { runtime } = makeRuntime([answerTurn('hi')], tools);

    expect(new AgentService(runtime).info()).toEqual({
      provider: 'fake',
      model: 'fake-1',
      tools: ['ping'],
      sessions: 0,
    });
  });

  it('run 返回与 AgentLoop 一致的结构化结果', async () => {
    const tools = new ToolRegistry().register({
      name: 'add',
      description: '加法',
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: async ({ a, b }: { a: number; b: number }) => String(a + b),
    });
    const { runtime } = makeRuntime([toolTurn('add', { a: 2, b: 3 }), answerTurn('5')], tools);

    const result = await new AgentService(runtime).run('2+3');

    expect(result.content).toBe('5');
    expect(result.stopReason).toBe('completed');
    expect(result.toolCalls.map((c) => c.name)).toEqual(['add']);
  });

  it('同一 sessionId 复用上下文，不同 sessionId 互不串味', async () => {
    const { runtime, model } = makeRuntime([answerTurn('第一次'), answerTurn('第二次')]);
    const service = new AgentService(runtime);

    await service.run('你好', 's1');
    await service.run('再说一次', 's2');

    // s2 的首次请求不应带上 s1 的历史
    const secondSessionRequest = model.calls[1];
    const userMessages = secondSessionRequest?.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages?.[0]?.content).toBe('再说一次');
    expect(service.info().sessions).toBe(2);
  });

  it('同一会话的第二轮能看到上一轮历史', async () => {
    const { runtime, model } = makeRuntime([answerTurn('好的'), answerTurn('嗯')]);
    const service = new AgentService(runtime);

    await service.run('第一句', 's1');
    await service.run('第二句', 's1');

    const secondTurnMessages = model.calls[1]?.messages ?? [];
    expect(secondTurnMessages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      '第一句',
      '第二句',
    ]);
  });

  it('reset 清空指定会话上下文', async () => {
    const { runtime, model } = makeRuntime([answerTurn('a'), answerTurn('b')]);
    const service = new AgentService(runtime);

    await service.run('第一句', 's1');
    service.reset('s1');
    await service.run('重新开始', 's1');

    const userMessages = model.calls[1]?.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
  });
});

describe('AgentController', () => {
  it('GET /agent/info 返回运行时自检', () => {
    const { runtime } = makeRuntime([answerTurn('x')]);
    const controller = new AgentController(new AgentService(runtime));

    expect(controller.info().model).toBe('fake-1');
  });

  it('POST /agent/run 空 input 返回 400', async () => {
    const { runtime } = makeRuntime([answerTurn('x')]);
    const controller = new AgentController(new AgentService(runtime));

    await expect(controller.run({ input: '   ' })).rejects.toBeInstanceOf(HttpException);
  });

  it('POST /agent/run 返回可序列化的结果，不泄漏内部消息结构', async () => {
    const { runtime } = makeRuntime([answerTurn('好了')]);
    const controller = new AgentController(new AgentService(runtime));

    const payload = await controller.run({ input: '做点事' });

    expect(payload).toEqual({
      content: '好了',
      stopReason: 'completed',
      steps: 1,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  });

  it('GET /agent/stream 以 SSE 事件逐个推送，末条为 done', async () => {
    const tools = new ToolRegistry().register({
      name: 'add',
      description: '加法',
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: async ({ a, b }: { a: number; b: number }) => String(a + b),
    });
    const { runtime } = makeRuntime([toolTurn('add', { a: 2, b: 3 }), answerTurn('5')], tools);
    const controller = new AgentController(new AgentService(runtime));

    const events = await firstValueFrom(controller.stream('2+3', 's1').pipe(toArray()));

    expect(events.map((e) => e.type)).toEqual([
      'step_start',
      'tool_call',
      'tool_result',
      'step_start',
      'text',
      'done',
    ]);
  });

  it('流式接口同样校验空 input', () => {
    const { runtime } = makeRuntime([answerTurn('x')]);
    const controller = new AgentController(new AgentService(runtime));

    expect(() => controller.stream('  ')).toThrow(HttpException);
  });
});
