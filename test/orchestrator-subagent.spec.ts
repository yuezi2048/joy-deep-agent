import { afterEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { createAgentRuntime } from '../src/runtime.js';
import { createSubAgent } from '../src/orchestrator/sub-agent.js';
import { BUILTIN_ROLES, type AgentRole } from '../src/orchestrator/role.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

const writing = BUILTIN_ROLES.find((role) => role.name === 'writing')!;

describe('SubAgent', () => {
  it('每次 run 都是独立上下文：第二次看不到第一次的消息', async () => {
    const model = new FakeChatModel([answerTurn('第一份'), answerTurn('第二份')]);
    const agent = createSubAgent({ role: writing, model, tools: new ToolRegistry() });

    await agent.run('任务 A');
    await agent.run('任务 B');

    const first = model.calls[0]?.messages ?? [];
    const second = model.calls[1]?.messages ?? [];
    expect(first.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['任务 A']);
    expect(second.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['任务 B']);
  });

  it('带上角色的系统提示，且不额外赠送工具', async () => {
    const model = new FakeChatModel([answerTurn('好')]);
    await createSubAgent({ role: writing, model, tools: new ToolRegistry() }).run('写一段');

    const request = model.calls[0];
    expect(request?.messages[0]?.role).toBe('system');
    expect(request?.messages[0]?.content).toBe(writing.systemPrompt);
    // 没有工具时不带 tools 字段，免得模型对着空工具表发呆
    expect(request?.tools).toBeUndefined();
  });

  it('角色没有的工具在注册表里就不存在，模型调它会拿到可读反馈', async () => {
    const model = new FakeChatModel([toolTurn('read_file', { path: 'x' }), answerTurn('读不到')]);
    const registry = new ToolRegistry().register({
      name: 'calculator',
      description: '算数',
      schema: (await import('zod')).z.object({ expression: (await import('zod')).z.string() }),
      handler: async () => '4',
    });

    const result = await createSubAgent({ role: writing, model, tools: registry }).run('读个文件');

    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('不存在');
    expect(result.stopReason).toBe('completed');
  });

  it('透传 maxSteps，中止原因可区分', async () => {
    const model = new FakeChatModel([toolTurn('noop', {}), toolTurn('noop', {}), answerTurn('never')]);
    const registry = new ToolRegistry().register({
      name: 'noop',
      description: 'noop',
      schema: (await import('zod')).z.object({}),
      handler: async () => 'ok',
    });

    const result = await createSubAgent({ role: writing, model, tools: registry, maxSteps: 2 }).run('干活');

    expect(result.stopReason).toBe('max_steps');
  });
});

describe('AgentRuntime.forkTools', () => {
  const original = process.env.DEEPSEEK_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  });

  async function runtime() {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-used';
    return createAgentRuntime({ logFailover: false, workspaceRoot: process.cwd() });
  }

  it('不传白名单就是全量；传了就只留白名单里的', async () => {
    const rt = await runtime();
    expect(rt.tools.names()).toContain('calculator');
    expect(rt.forkTools!(['calculator']).names()).toEqual(['calculator']);
    expect(rt.forkTools!().names()).toEqual(rt.tools.names());
  });

  it('白名单里写了不存在的工具 → 立刻报错并列出可用项', async () => {
    const rt = await runtime();
    expect(() => rt.forkTools!(['calculatr'])).toThrow(/calculatr.*可用/s);
  });

  it('fork 出来的注册表各持中间件状态：A 的缓存不会漏给 B', async () => {
    const rt = await runtime();
    const a = rt.forkTools!(['calculator']);
    const b = rt.forkTools!(['calculator']);
    const call = {
      id: 'c1',
      name: 'calculator',
      arguments: { expression: '1+1' },
      rawArguments: '{"expression":"1+1"}',
    };

    const firstA = await a.execute(call);
    const secondA = await a.execute(call);
    const firstB = await b.execute(call);

    expect(secondA.content).toContain('复用结果');
    expect(firstB.content).not.toContain('复用结果');
    expect(firstA.content).toBe(firstB.content);
  });

  it('fork 出来的注册表能真跑一轮 AgentLoop', async () => {
    const rt = await runtime();
    const model = new FakeChatModel([toolTurn('calculator', { expression: '(2+3)*4' }), answerTurn('20')]);
    const result = await new AgentLoop({ model, tools: rt.forkTools!(['calculator']) }).run('算 (2+3)*4');

    expect(result.content).toBe('20');
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('20');
  });
});
