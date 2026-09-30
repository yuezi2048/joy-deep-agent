import { describe, expect, it } from 'vitest';
import { A2AController } from '../src/nest/a2a.controller.js';
import { AgentService } from '../src/nest/agent.service.js';
import type { AgentRuntime } from '../src/runtime.js';
import type { ChatResponse } from '../src/providers/chat-model.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, StubChatModel, answerTurn } from './helpers/fake-model.js';

function makeController(script: ChatResponse[]) {
  const model = new FakeChatModel(script);
  const runtime = { model, tools: new ToolRegistry() } satisfies AgentRuntime;
  const service = new AgentService(runtime);
  return { controller: new A2AController(service, { publicUrl: 'http://harness.test/' }), model, service };
}

function sendRequest(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'message/send',
    params: {
      message: { role: 'user', parts: [{ kind: 'text', text }], messageId: 'm-1' },
      ...extra,
    },
  };
}

describe('A2A 服务端（Harness 作为被调用方）', () => {
  it('名片发布在标准路径，任务端点指向自己', () => {
    const { controller } = makeController([answerTurn('x')]);
    const card = controller.agentCard();

    expect(card.name).toBe('Joy-Deep-Agent');
    expect(card.url).toBe('http://harness.test/a2a');
    expect(card.capabilities).toEqual({ streaming: false });
    expect(card.defaultInputModes).toEqual(['text']);
    const skills = card.skills as Array<Record<string, unknown>>;
    expect(skills[0]?.id).toBe('task-execution');
  });

  it('合法 message/send → 跑主循环，按 A2A 格式回包', async () => {
    const { controller } = makeController([answerTurn('结果是 20')]);
    const response = await controller.handleTask(sendRequest('算一下 (2+3)*4'));

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('req-1');
    expect(response.error).toBeUndefined();
    const message = (response.result as any).message;
    expect(message.role).toBe('agent');
    expect(message.parts[0]).toEqual({ kind: 'text', text: '结果是 20' });
  });

  it('同一个 contextId 复用会话，不同 contextId 互不串味', async () => {
    const { controller, model } = makeController([answerTurn('一'), answerTurn('二'), answerTurn('三')]);

    await controller.handleTask(sendRequest('第一句', { contextId: 'ctx-a' }));
    await controller.handleTask(sendRequest('第二句', { contextId: 'ctx-a' }));
    await controller.handleTask(sendRequest('第三句', { contextId: 'ctx-b' }));

    const usersOfSecondCall = (model.calls[1]?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content);
    expect(usersOfSecondCall).toEqual(['第一句', '第二句']);

    const usersOfThirdCall = (model.calls[2]?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content);
    expect(usersOfThirdCall).toEqual(['第三句']);
  });

  it('协议错误一律回 JSON-RPC 错误信封，不回 HTTP 500', async () => {
    const { controller } = makeController([answerTurn('x')]);

    const empty = await controller.handleTask(sendRequest('   '));
    expect(empty.error).toMatchObject({ code: -32602 });

    const badMethod = await controller.handleTask({ jsonrpc: '2.0', id: 7, method: 'tasks/get' });
    expect(badMethod.error).toMatchObject({ code: -32601 });
    expect(badMethod.id).toBe(7);

    const malformed = await controller.handleTask({ id: 9, method: 'message/send' });
    expect(malformed.error).toMatchObject({ code: -32600 });

    const noParts = await controller.handleTask({ jsonrpc: '2.0', id: 10, method: 'message/send', params: {} });
    expect(noParts.error).toMatchObject({ code: -32602 });
  });

  it('主循环抛错时回可读的 JSON-RPC 错误，而不是把异常漏给调用方', async () => {
    const model = new StubChatModel('boom', async () => {
      throw new Error('所有供应商都不可用');
    });
    const runtime = { model, tools: new ToolRegistry() } satisfies AgentRuntime;
    const controller = new A2AController(new AgentService(runtime), { publicUrl: 'http://harness.test' });

    const response = await controller.handleTask(sendRequest('随便做点什么'));

    expect(response.error).toMatchObject({ code: -32000 });
    expect(String((response.error as any).message)).toContain('所有供应商都不可用');
  });

  it('不注入选项时用本地默认地址', () => {
    const model = new FakeChatModel([answerTurn('x')]);
    const runtime = { model, tools: new ToolRegistry() } satisfies AgentRuntime;
    const controller = new A2AController(new AgentService(runtime));
    expect(String(controller.agentCard().url)).toMatch(/^http:\/\/localhost:\d+\/a2a$/);
  });
});
