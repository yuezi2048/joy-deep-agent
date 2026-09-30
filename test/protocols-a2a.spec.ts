import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import {
  HttpA2AAgentClient,
  createDelegateTool,
  extractMessageText,
  messageSendResult,
  parseMessageSend,
  type A2AAgentClient,
} from '../src/protocols/a2a/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

/**
 * 沙箱里 `listen` 会 EPERM，CI 也不该依赖端口，所以 HTTP 层用注入的 stub fetch 验证**线上格式**：
 * 客户端这一侧断言请求 URL / 方法 / JSON-RPC 信封，服务端那一侧由 nest 的 A2A 控制器单测收口。
 * 两边拼起来就是完整契约。
 */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const record = { url, init: init ?? {} };
    calls.push(record);
    return handler(url, record.init);
  }) as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cardResponse(overrides: Record<string, unknown> = {}): Response {
  return json({
    name: '翻译 Agent',
    description: '专业的多语言翻译 Agent',
    url: 'http://remote/a2a',
    version: '1.0.0',
    skills: [{ id: 'translate', name: '文本翻译', tags: ['translation'], examples: ['翻译成英文'] }],
    ...overrides,
  });
}

function sendResponse(text: string): Response {
  return json({ jsonrpc: '2.0', id: 'x', result: { message: { role: 'agent', parts: [{ kind: 'text', text }] } } });
}

describe('A2A 客户端（发现 + 委派）', () => {
  it('先读 Agent Card 发现能力，再按卡片声明的 url 发 message/send', async () => {
    const { impl, calls } = stubFetch((url) => (url.endsWith('/.well-known/agent-card.json') ? cardResponse() : sendResponse('Hello world')));
    const client = new HttpA2AAgentClient('translator', { url: 'http://remote/', fetchImpl: impl });

    const card = await client.card();
    expect(card.name).toBe('翻译 Agent');
    expect(card.skills?.[0]?.tags).toEqual(['translation']);

    const reply = await client.send('把这句话翻译成英文：你好');
    expect(reply).toBe('Hello world');

    expect(calls[0]?.url).toBe('http://remote/.well-known/agent-card.json');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[1]?.url).toBe('http://remote/a2a');
    expect(calls[1]?.init.method).toBe('POST');

    const body = JSON.parse(String(calls[1]?.init.body)) as Record<string, any>;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('message/send');
    expect(body.params.message.role).toBe('user');
    expect(body.params.message.parts[0]).toEqual({ kind: 'text', text: '把这句话翻译成英文：你好' });
    expect(typeof body.params.message.messageId).toBe('string');
  });

  it('卡片没声明 url 时退回配置的基地址', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.endsWith('/.well-known/agent-card.json') ? cardResponse({ url: undefined }) : sendResponse('ok'),
    );
    const client = new HttpA2AAgentClient('translator', { url: 'http://remote', fetchImpl: impl });

    await client.send('hi');
    expect(calls[1]?.url).toBe('http://remote');
  });

  it('HTTP 非 2xx / 非 JSON / JSON-RPC error / 缺文本 都给可读错误', async () => {
    const http500 = new HttpA2AAgentClient('x', {
      url: 'http://remote',
      fetchImpl: stubFetch(() => new Response('boom', { status: 500 })).impl,
    });
    await expect(http500.card()).rejects.toThrow(/HTTP 500/);

    const notJson = new HttpA2AAgentClient('x', {
      url: 'http://remote',
      fetchImpl: stubFetch((url) => (url.endsWith('agent-card.json') ? cardResponse() : new Response('<html>'))).impl,
    });
    await expect(notJson.send('hi')).rejects.toThrow(/不是合法 JSON/);

    const rpcError = new HttpA2AAgentClient('x', {
      url: 'http://remote',
      fetchImpl: stubFetch((url) =>
        url.endsWith('agent-card.json') ? cardResponse() : json({ jsonrpc: '2.0', error: { message: '内部错误' } }),
      ).impl,
    });
    await expect(rpcError.send('hi')).rejects.toThrow(/内部错误/);

    const noText = new HttpA2AAgentClient('x', {
      url: 'http://remote',
      fetchImpl: stubFetch((url) =>
        url.endsWith('agent-card.json') ? cardResponse() : json({ jsonrpc: '2.0', result: { message: { parts: [] } } }),
      ).impl,
    });
    await expect(noText.send('hi')).rejects.toThrow(/parts\[0\]\.text/);
  });

  it('extractMessageText 拼接多段文本，结构不对返回 undefined', () => {
    expect(
      extractMessageText({ message: { parts: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }] } }),
    ).toBe('a\nb');
    expect(extractMessageText({ message: {} })).toBeUndefined();
    expect(extractMessageText(null)).toBeUndefined();
  });
});

describe('message/send 的解析与回包（协议层自己的知识）', () => {
  it('解析信封 / 方法 / 文本 / contextId，逐类错误给出原因', () => {
    expect(
      parseMessageSend({
        jsonrpc: '2.0',
        id: 'r1',
        method: 'message/send',
        params: { message: { parts: [{ text: '干活' }] } },
      }),
    ).toEqual({ ok: true, id: 'r1', task: '干活' });

    expect(
      parseMessageSend({
        jsonrpc: '2.0',
        id: 'r2',
        method: 'message/send',
        params: { contextId: 'c', message: { parts: [{ text: 'x' }] } },
      }),
    ).toEqual({ ok: true, id: 'r2', task: 'x', contextId: 'c' });

    expect(parseMessageSend(null)).toMatchObject({ ok: false, id: null, reason: 'invalid-request' });
    expect(parseMessageSend({ jsonrpc: '2.0', id: 3, method: 'tasks/get' })).toMatchObject({
      ok: false,
      id: 3,
      reason: 'method-not-found',
    });
    expect(parseMessageSend({ jsonrpc: '2.0', id: 4, method: 'message/send', params: {} })).toMatchObject({
      ok: false,
      id: 4,
      reason: 'invalid-params',
    });
  });

  it('回包结构符合 A2A：result.message.parts[0].text', () => {
    expect(messageSendResult('r1', '结果')).toEqual({
      jsonrpc: '2.0',
      id: 'r1',
      result: { message: { role: 'agent', parts: [{ kind: 'text', text: '结果' }] } },
    });
  });
});

describe('delegate 工具', () => {
  it('接进 AgentLoop：模型委派 → 远端回复回灌 → 收敛出答案', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.endsWith('agent-card.json') ? cardResponse() : sendResponse('Hello world'),
    );
    const client = new HttpA2AAgentClient('translator', { url: 'http://remote', fetchImpl: impl });
    const registry = new ToolRegistry().register(await createDelegateTool([client]));

    const model = new FakeChatModel([
      toolTurn('delegate', { task: '把「你好」翻译成英文' }),
      answerTurn('英文是 Hello world'),
    ]);
    const result = await new AgentLoop({ model, tools: registry }).run('帮我把「你好」翻成英文');

    expect(result.stopReason).toBe('completed');
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('translator');
    expect(toolMessage?.content).toContain('Hello world');
    expect(calls.some((call) => call.init.method === 'POST')).toBe(true);
  });

  it('多 agent 时 description 列出候选，编造的 agent 名被本地校验打回且不发请求', async () => {
    const { impl, calls } = stubFetch((url) => (url.endsWith('agent-card.json') ? cardResponse() : sendResponse('x')));
    const translator = new HttpA2AAgentClient('translator', { url: 'http://remote', fetchImpl: impl });
    const searcher = new HttpA2AAgentClient('searcher', {
      url: 'http://remote2',
      fetchImpl: stubFetch((url) => (url.endsWith('agent-card.json') ? cardResponse({ name: '检索 Agent' }) : sendResponse('y'))).impl,
    });

    const tool = await createDelegateTool([translator, searcher]);
    expect(tool.description).toContain('translator');
    expect(tool.description).toContain('searcher');

    const registry = new ToolRegistry().register(tool);
    const postsBefore = calls.filter((call) => call.init.method === 'POST').length;
    const result = await registry.execute({
      id: 'c1',
      name: 'delegate',
      arguments: { agent: 'nonexistent', task: '干点什么' },
      rawArguments: '{}',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('agent');
    expect(calls.filter((call) => call.init.method === 'POST').length).toBe(postsBefore);
  });

  it('单 agent 时不必点名', async () => {
    const { impl } = stubFetch((url) => (url.endsWith('agent-card.json') ? cardResponse() : sendResponse('done')));
    const client = new HttpA2AAgentClient('translator', { url: 'http://remote', fetchImpl: impl });
    const registry = new ToolRegistry().register(await createDelegateTool([client]));

    const result = await registry.execute({
      id: 'c1',
      name: 'delegate',
      arguments: { task: '翻译' },
      rawArguments: '{}',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('done');
  });

  it('远端 5xx → 可读 isError，不抛异常', async () => {
    const failing = new HttpA2AAgentClient('broken', {
      url: 'http://remote',
      fetchImpl: stubFetch((url) =>
        url.endsWith('agent-card.json') ? cardResponse() : new Response('nope', { status: 503 }),
      ).impl,
    });
    const registry = new ToolRegistry().register(await createDelegateTool([failing]));

    const result = await registry.execute({
      id: 'c1',
      name: 'delegate',
      arguments: { task: '翻译' },
      rawArguments: '{}',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('broken');
    expect(result.content).toContain('HTTP 503');
  });

  it('发现阶段掉线不阻塞注册，描述里如实写明，调用时给可读错误', async () => {
    const down: A2AAgentClient = {
      name: 'down',
      card: async () => {
        throw new Error('ECONNREFUSED');
      },
      send: async () => {
        throw new Error('ECONNREFUSED');
      },
    };

    const tool = await createDelegateTool([down]);
    expect(tool.description).toContain('发现失败');
    expect(tool.description).toContain('ECONNREFUSED');

    const result = await new ToolRegistry().register(tool).execute({
      id: 'c1',
      name: 'delegate',
      arguments: { task: '翻译' },
      rawArguments: '{}',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ECONNREFUSED');
  });

  it('空任务描述被挡下；agent 名重复直接报错', async () => {
    const fake: A2AAgentClient = { name: 'a', card: async () => ({ name: 'a' }), send: async () => 'x' };
    const registry = new ToolRegistry().register(await createDelegateTool([fake]));

    const empty = await registry.execute({ id: 'c1', name: 'delegate', arguments: { task: '   ' }, rawArguments: '{}' });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain('空的');

    await expect(createDelegateTool([fake, { ...fake }])).rejects.toThrow(/唯一/);
    await expect(createDelegateTool([])).rejects.toThrow(/至少一个/);
  });
});
