import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/core/agent-loop.js';
import {
  connectMcp,
  createMcpTools,
  defaultConfirmPolicy,
  jsonSchemaToZod,
  modelParameters,
  renderResult,
} from '../src/protocols/mcp/index.js';
import type { McpConnection, McpToolDescriptor } from '../src/protocols/mcp/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

/** 起一个真实 MCP server，用官方 in-memory transport 跟它对话：不联网、不起子进程。 */
async function connectOrderServer(): Promise<McpConnection> {
  const server = new McpServer({ name: 'order-server', version: '1.0.0' });
  server.registerTool(
    'query_order',
    {
      description: '根据订单号查询订单详情',
      inputSchema: { orderId: z.string() },
      annotations: { readOnlyHint: true, title: '查订单' },
    },
    async ({ orderId }) => ({
      content: [{ type: 'text', text: JSON.stringify({ orderId, status: '已发货' }) }],
    }),
  );
  server.registerTool(
    'request_refund',
    { description: '为指定订单申请退款', inputSchema: { orderId: z.string(), reason: z.string() } },
    async ({ orderId, reason }) => ({
      content: [{ type: 'text', text: `订单 ${orderId} 退款已受理：${reason}` }],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return connectMcp('orders', clientTransport);
}

function fakeConnection(overrides: Partial<McpConnection> & { tools?: McpToolDescriptor[] }): McpConnection {
  const { tools = [], ...rest } = overrides;
  return {
    serverName: 'fake',
    listTools: async () => tools,
    callTool: async () => ({ content: [] }),
    close: async () => {},
    ...rest,
  };
}

describe('MCP 工具来源适配器', () => {
  it('用官方 SDK 端到端跑通：注册 → 模型看到 schema → 调用 → 结果回灌', async () => {
    const connection = await connectOrderServer();
    const tools = await createMcpTools(connection);
    const registry = new ToolRegistry().registerAll(tools);

    // 工具名带 server 前缀，且远端 JSON Schema 直通给了模型
    expect(registry.names()).toEqual(['mcp__orders__query_order', 'mcp__orders__request_refund']);
    const schema = registry.schemas().find((item) => item.name === 'mcp__orders__query_order');
    expect(schema?.parameters).toMatchObject({
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    });

    const model = new FakeChatModel([
      toolTurn('mcp__orders__query_order', { orderId: 'ORD-12345' }),
      answerTurn('订单已发货'),
    ]);
    const result = await new AgentLoop({ model, tools: registry }).run('查一下订单 ORD-12345');

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('订单已发货');
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('ORD-12345');
    expect(toolMessage?.content).toContain('已发货');

    await connection.close();
  });

  it('远端声明的只读工具免确认，未声明的默认走 HITL（宁严勿松）', async () => {
    const connection = await connectOrderServer();
    const tools = await createMcpTools(connection);
    await connection.close();

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('mcp__orders__query_order')?.requiresConfirmation).toBe(false);
    expect(byName.get('mcp__orders__request_refund')?.requiresConfirmation).toBe(true);
  });

  it('未确认的高风险远端工具不会真的打到远端', async () => {
    let called = 0;
    const connection = fakeConnection({
      tools: [{ name: 'refund', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }],
      callTool: async () => {
        called++;
        return { content: [{ type: 'text', text: '不该走到这里' }] };
      },
    });
    const registry = new ToolRegistry().registerAll(await createMcpTools(connection));
    const model = new FakeChatModel([
      toolTurn('mcp__fake__refund', { id: 'A-1' }),
      answerTurn('需要授权'),
    ]);

    const result = await new AgentLoop({ model, tools: registry }).run('退掉 A-1');

    expect(called).toBe(0);
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('需要人工确认');
  });

  it('远端 callTool 抛错 → 可读 isError，不把循环带崩', async () => {
    const connection = fakeConnection({
      tools: [{ name: 'ping' }],
      callTool: async () => {
        throw new Error('ECONNRESET：对端掉线');
      },
    });
    const [tool] = await createMcpTools(connection);
    const result = await new ToolRegistry().register(tool!).execute({
      id: 'c1',
      name: 'mcp__fake__ping',
      arguments: {},
      rawArguments: '{}',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('ECONNRESET');
    expect(result.content).toContain('mcp__fake__ping');
  });

  it('远端 isError 原样透传，并带上工具名', async () => {
    const connection = fakeConnection({
      tools: [{ name: 'ping' }],
      callTool: async () => ({ content: [{ type: 'text', text: '订单号不存在' }], isError: true }),
    });
    const [tool] = await createMcpTools(connection);
    const result = await new ToolRegistry().register(tool!).execute({
      id: 'c1',
      name: 'mcp__fake__ping',
      arguments: {},
      rawArguments: '{}',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('订单号不存在');
  });

  it('取消信号透传到远端调用：墙钟上限能掐断在飞的 MCP 请求', async () => {
    let seen: AbortSignal | undefined;
    const connection = fakeConnection({
      tools: [{ name: 'slow' }],
      callTool: async (_name, _args, signal) => {
        seen = signal;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const registry = new ToolRegistry().register((await createMcpTools(connection))[0]!);
    const controller = new AbortController();

    await registry.execute({ id: 'c1', name: 'mcp__fake__slow', arguments: {}, rawArguments: '{}' }, controller.signal);

    expect(seen).toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });

  it('参数不合远端 schema → 本地校验打回，可读反馈不触达远端', async () => {
    let called = 0;
    const connection = fakeConnection({
      tools: [
        {
          name: 'query',
          inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'] },
        },
      ],
      callTool: async () => {
        called++;
        return { content: [] };
      },
    });
    const [tool] = await createMcpTools(connection);
    const registry = new ToolRegistry().register(tool!);

    const result = await registry.execute({
      id: 'c1',
      name: 'mcp__fake__query',
      arguments: { limit: '很多' },
      rawArguments: '{"limit":"很多"}',
    });

    expect(called).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('limit');
  });

  it('自定义确认策略时，工具描述跟着策略走，不按远端注解另猜一遍', async () => {
    const strict = await createMcpTools(
      fakeConnection({ tools: [{ name: 'publish', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }),
      { confirmPolicy: () => true },
    );
    const relaxed = await createMcpTools(
      fakeConnection({ tools: [{ name: 'audit', inputSchema: { type: 'object' } }] }),
      { confirmPolicy: () => false },
    );

    // 远端声明只读，但调用方策略要求确认：描述必须说「是」，否则描述与行为不一致
    expect(strict[0]?.requiresConfirmation).toBe(true);
    expect(strict[0]?.description).toContain('需人工确认：是');

    expect(relaxed[0]?.requiresConfirmation).toBe(false);
    expect(relaxed[0]?.description).toContain('需人工确认：否');
  });

  it('默认前缀把不同 server 隔开；前缀被人为设成一样时由注册表直接报错', async () => {
    const a = await createMcpTools(fakeConnection({ serverName: 'a', tools: [{ name: 'ping' }] }));
    const b = await createMcpTools(fakeConnection({ serverName: 'b', tools: [{ name: 'ping' }] }));
    const registry = new ToolRegistry().registerAll(a);

    expect(registry.names()).toEqual(['mcp__a__ping']);
    // 两个 server 默认前缀不同，同名工具互不干扰
    registry.registerAll(b);
    expect(registry.names()).toEqual(['mcp__a__ping', 'mcp__b__ping']);

    // 运维把两个 server 配成同一个前缀时，撞名必须 fail loud，而不是悄悄覆盖
    const clash = await createMcpTools(fakeConnection({ serverName: 'c', tools: [{ name: 'ping' }] }), {
      prefix: 'mcp__a__',
    });
    expect(() => registry.registerAll(clash)).toThrow(/已注册/);
    expect(registry.names()).toEqual(['mcp__a__ping', 'mcp__b__ping']);
  });

  it('非文本 content 降级成占位描述，不认识的内容类型不丢也不猜', () => {
    const connection = fakeConnection({});
    const rendered = renderResult(connection, 'mcp__x__y', {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a.txt', text: '资源正文' } },
        { type: 'resource_link', uri: 'file:///b.txt', name: 'B' },
        { type: '未来类型', note: 'whatever' },
      ],
    });

    expect(rendered).toContain('第一段');
    expect(rendered).toContain('[图片 image/png');
    expect(rendered).toContain('资源正文');
    expect(rendered).toContain('file:///b.txt');
    expect(rendered).toContain('不支持的 MCP 内容类型');
  });

  it('没有 content 但有 structuredContent 时不丢数据', () => {
    const rendered = renderResult(fakeConnection({}), 'mcp__x__y', {
      content: [],
      structuredContent: { total: 3 },
    });
    expect(rendered).toContain('"total":3');
  });
});

describe('JSON Schema → zod 桥', () => {
  it('尊重 required / optional 与 additionalProperties', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });

    expect(schema.safeParse({ id: 'A' }).success).toBe(true);
    expect(schema.safeParse({ id: 'A', note: 'hi' }).success).toBe(true);
    expect(schema.safeParse({ note: 'hi' }).success).toBe(false);
    expect(schema.safeParse({ id: 'A', extra: 1 }).success).toBe(false);
  });

  it('默认宽松：没写 additionalProperties: false 时不拒绝多余字段', () => {
    const schema = jsonSchemaToZod({ type: 'object', properties: { id: { type: 'string' } } });
    expect(schema.safeParse({ id: 'A', extra: 1 }).success).toBe(true);
  });

  it('enum 与 nullable 联合类型都能转', () => {
    const enumSchema = jsonSchemaToZod({ type: 'string', enum: ['a', 'b'] });
    expect(enumSchema.safeParse('a').success).toBe(true);
    expect(enumSchema.safeParse('c').success).toBe(false);

    const nullable = jsonSchemaToZod({ type: ['string', 'null'] });
    expect(nullable.safeParse('x').success).toBe(true);
    expect(nullable.safeParse(null).success).toBe(true);
    expect(nullable.safeParse(1).success).toBe(false);
  });

  it('畸形 schema 一律退化，不抛异常', () => {
    for (const bad of [undefined, null, 42, 'nonsense', { type: '不认识' }, { type: 'array' }]) {
      expect(() => jsonSchemaToZod(bad)).not.toThrow();
    }
    expect(jsonSchemaToZod({ type: '不认识' }).safeParse({ anything: true }).success).toBe(true);
  });

  it('含 $ref 的 schema 不直通给模型，交给 zod 推导版兜底', () => {
    expect(modelParameters({ type: 'object', properties: { a: { $ref: '#/$defs/a' } } })).toBeUndefined();
    expect(modelParameters({ type: 'object', properties: { a: { type: 'string' } }, $schema: 'x' })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
  });

  it('默认确认策略以 readOnlyHint 为准', () => {
    expect(defaultConfirmPolicy({ name: 'q', annotations: { readOnlyHint: true } })).toBe(false);
    expect(defaultConfirmPolicy({ name: 'w', annotations: { readOnlyHint: false } })).toBe(true);
    expect(defaultConfirmPolicy({ name: 'w' })).toBe(true);
  });
});
