import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { AgentEvent } from '../src/core/agent-loop.js';
import type { ToolDefinition } from '../src/core/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

function addTool(handler = vi.fn(async ({ a, b }: { a: number; b: number }) => String(a + b))) {
  const definition: ToolDefinition = {
    name: 'add',
    description: '两数相加',
    schema: z.object({ a: z.number(), b: z.number() }),
    handler,
  };
  return { definition, handler };
}

describe('AgentLoop（自研 ReAct 循环）', () => {
  it('模型请求工具 → 执行 → 观察回灌 → 再思考出最终答案', async () => {
    const { definition, handler } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([toolTurn('add', { a: 2, b: 3 }), answerTurn('答案是 5')]);

    const loop = new AgentLoop({ model, tools });
    const result = await loop.run('2 + 3 等于几？');

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('答案是 5');
    expect(result.steps).toBe(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
  });

  it('把工具结果以 tool 角色回灌，toolCallId 与 assistant 声明的调用一一对应', async () => {
    const { definition } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([
      toolTurn('add', { a: 2, b: 3 }, 'call_abc'),
      answerTurn('5'),
    ]);

    await new AgentLoop({ model, tools }).run('算一下');

    const secondRequest = model.calls[1];
    // assistant 发起的调用也要留在轨迹里，否则后续请求结构非法
    const assistantMessage = secondRequest?.messages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.toolCalls).toHaveLength(1);

    const toolMessage = secondRequest?.messages.find((m) => m.role === 'tool');
    const declaredId = assistantMessage?.toolCalls?.[0]?.id;
    expect(toolMessage).toMatchObject({
      role: 'tool',
      toolCallId: declaredId,
      name: 'add',
      content: '5',
    });
  });

  it('调用 id 由工具名与参数确定性推导，不随模型给的随机 id 变化', async () => {
    const { definition } = addTool();
    const tools = new ToolRegistry().register(definition);

    const idsOf = async (modelId: string) => {
      const model = new FakeChatModel([toolTurn('add', { a: 2, b: 3 }, modelId), answerTurn('5')]);
      const result = await new AgentLoop({ model, tools }).run('算一下');
      return result.toolCalls.map((call) => call.id);
    };

    const first = await idsOf('call_random_a');
    const second = await idsOf('call_random_b');

    expect(first).toEqual(second);
    expect(first[0]).toContain('add');
  });

  it('每次请求都带上 system prompt 与工具声明', async () => {
    const { definition } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([answerTurn('好的')]);

    await new AgentLoop({ model, tools, options: { systemPrompt: '你是测试助手' } }).run('你好');

    const request = model.calls[0];
    expect(request?.messages[0]).toEqual({ role: 'system', content: '你是测试助手' });
    expect(request?.tools?.[0]?.name).toBe('add');
  });

  it('走到步数上限时停止，并如实报告 max_steps', async () => {
    const { definition } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([
      toolTurn('add', { a: 1, b: 1 }, 'c1'),
      toolTurn('add', { a: 2, b: 2 }, 'c2'),
      toolTurn('add', { a: 3, b: 3 }, 'c3'),
    ]);

    const result = await new AgentLoop({ model, tools, options: { maxSteps: 2 } }).run('一直算');

    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(2);
  });

  it('原地打转（调用签名连续相同）时提前停止，而不是烧完预算', async () => {
    const { definition, handler } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([
      toolTurn('add', { a: 1, b: 1 }, 'c1'),
      toolTurn('add', { a: 1, b: 1 }, 'c2'),
      toolTurn('add', { a: 1, b: 1 }, 'c3'),
    ]);

    const result = await new AgentLoop({
      model,
      tools,
      options: { maxSteps: 8, noProgressLimit: 2 },
    }).run('卡住');

    expect(result.stopReason).toBe('no_progress');
    expect(result.steps).toBe(2);
    // 卡死那轮仍执行完，保证轨迹里 tool 结果不缺
    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('未知工具不中断循环，而是把错误当观测回灌', async () => {
    const tools = new ToolRegistry();
    const model = new FakeChatModel([
      toolTurn('nonexistent', { x: 1 }),
      answerTurn('我换个办法'),
    ]);

    const result = await new AgentLoop({ model, tools }).run('调用不存在的工具');

    expect(result.stopReason).toBe('completed');
    const toolMessage = model.calls[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('不存在');
  });

  it('参数不合法时把校验反馈回灌给模型，让它自我修正', async () => {
    const { definition, handler } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([
      toolTurn('add', { a: '一百', b: 3 }),
      answerTurn('我重新算'),
    ]);

    await new AgentLoop({ model, tools }).run('算一下');

    expect(handler).not.toHaveBeenCalled();
    const toolMessage = model.calls[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('参数');
  });

  it('累计各轮 usage', async () => {
    const { definition } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([
      { ...toolTurn('add', { a: 1, b: 1 }), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      { ...answerTurn('2'), usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 } },
    ]);

    const result = await new AgentLoop({ model, tools }).run('算');

    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 8, totalTokens: 38 });
  });

  it('trace 可复看：完成后 history 里有完整的一轮往返', async () => {
    const { definition } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([toolTurn('add', { a: 2, b: 2 }), answerTurn('4')]);

    const loop = new AgentLoop({ model, tools });
    await loop.run('2+2');

    expect(loop.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
});

describe('AgentLoop · HITL 高风险操作确认', () => {
  it('需要确认却没有确认钩子时，默认拒绝执行', async () => {
    const handler = vi.fn(async () => '已删除');
    const tools = new ToolRegistry().register({
      name: 'delete_all',
      description: '删除所有数据',
      schema: z.object({}),
      handler,
      requiresConfirmation: true,
    } satisfies ToolDefinition);
    const model = new FakeChatModel([toolTurn('delete_all', {}), answerTurn('我先不删了')]);

    await new AgentLoop({ model, tools }).run('清空数据');

    expect(handler).not.toHaveBeenCalled();
    const toolMessage = model.calls[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('需要人工确认');
  });

  it('确认钩子返回 true 才真正执行', async () => {
    const handler = vi.fn(async () => '已删除');
    const tools = new ToolRegistry().register({
      name: 'delete_all',
      description: '删除所有数据',
      schema: z.object({}),
      handler,
      requiresConfirmation: true,
    } satisfies ToolDefinition);
    const model = new FakeChatModel([toolTurn('delete_all', {}), answerTurn('删掉了')]);
    const confirm = vi.fn(async () => true);

    await new AgentLoop({ model, tools, options: { confirm } }).run('清空数据');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('确认钩子抛异常时按拒绝处理，不把异常放行成执行', async () => {
    const handler = vi.fn(async () => '已删除');
    const tools = new ToolRegistry().register({
      name: 'delete_all',
      description: '删除所有数据',
      schema: z.object({}),
      handler,
      requiresConfirmation: true,
    } satisfies ToolDefinition);
    const model = new FakeChatModel([toolTurn('delete_all', {}), answerTurn('算了')]);

    await new AgentLoop({
      model,
      tools,
      options: {
        confirm: async () => {
          throw new Error('终端断开');
        },
      },
    }).run('清空数据');

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('AgentLoop · 流式执行', () => {
  it('逐步吐出文本增量，并以 done 事件给出与 run() 一致的结果', async () => {
    const { definition } = addTool();
    const tools = new ToolRegistry().register(definition);
    const model = new FakeChatModel([toolTurn('add', { a: 2, b: 3 }), answerTurn('答案是 5')]);

    const events: AgentEvent[] = [];
    const loop = new AgentLoop({ model, tools });
    for await (const event of loop.runStream('2+3')) events.push(event);

    expect(events.map((e) => e.type)).toEqual([
      'step_start',
      'tool_call',
      'tool_result',
      'step_start',
      'text',
      'done',
    ]);

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.result.content).toBe('答案是 5');
      expect(done.result.stopReason).toBe('completed');
    }
  });

  it('文本在真正产出时立刻可见，而不是结束后一次性返回', async () => {
    const tools = new ToolRegistry();
    const model = new FakeChatModel([answerTurn('分段输出')]);

    const seen: string[] = [];
    for await (const event of new AgentLoop({ model, tools }).runStream('你好')) {
      if (event.type === 'text') seen.push(event.delta);
    }

    expect(seen).toEqual(['分段输出']);
  });
});
