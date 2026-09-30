import { describe, expect, it } from 'vitest';
import type { A2AAgentClient, McpConnection, ProtocolTools } from '../src/protocols/index.js';
import {
  A2A_AGENTS_ENV,
  MCP_SERVERS_ENV,
  createProtocolTools,
  parseA2AAgents,
  parseMcpServers,
} from '../src/protocols/index.js';
import { ToolRegistry } from '../src/tools/registry.js';

function fakeServer(serverName: string, toolNames: string[], log?: { closed: string[] }): McpConnection {
  return {
    serverName,
    listTools: async () => toolNames.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close: async () => {
      log?.closed.push(serverName);
    },
  };
}

const failingClient: A2AAgentClient = {
  name: 'translator',
  card: async () => ({ name: '翻译 Agent' }),
  send: async () => 'translated',
};

describe('协议层装配', () => {
  it('不配任何环境变量 → 一个工具都不加，close 无副作用', async () => {
    const protocol: ProtocolTools = await createProtocolTools({ env: {} });
    expect(protocol.tools).toEqual([]);
    await expect(protocol.close()).resolves.toBeUndefined();
  });

  it('MCP 工具与 delegate 一起进同一个注册表', async () => {
    const closed: string[] = [];
    const protocol = await createProtocolTools({
      env: {
        [MCP_SERVERS_ENV]: JSON.stringify({ orders: { command: 'npx', args: ['tsx', 'server.ts'] } }),
        [A2A_AGENTS_ENV]: JSON.stringify({ translator: { url: 'http://remote' } }),
      },
      connectMcpServer: async (name) => fakeServer(name, ['query_order'], { closed }),
      createA2AClient: () => failingClient,
    });

    const registry = new ToolRegistry().registerAll(protocol.tools);
    expect(registry.names()).toEqual(['mcp__orders__query_order', 'delegate']);

    await protocol.close();
    expect(closed).toEqual(['orders']);
  });

  it('MCP server 连不上 → 启动即失败，且已建好的连接先收干净', async () => {
    const closed: string[] = [];
    await expect(
      createProtocolTools({
        env: {
          [MCP_SERVERS_ENV]: JSON.stringify({ ok: { command: 'npx' }, broken: { command: 'nope' } }),
        },
        connectMcpServer: async (name) => {
          if (name === 'broken') throw new Error('ENOENT: 找不到可执行文件');
          return fakeServer(name, ['ping'], { closed });
        },
      }),
    ).rejects.toThrow(/broken.*ENOENT/);

    expect(closed).toEqual(['ok']);
  });

  it('列出工具失败时也回滚已建立的连接', async () => {
    const closed: string[] = [];
    await expect(
      createProtocolTools({
        env: { [MCP_SERVERS_ENV]: JSON.stringify({ bad: { command: 'npx' } }) },
        connectMcpServer: async (name) => ({
          ...fakeServer(name, [], { closed }),
          listTools: async () => {
            throw new Error('协议握手失败');
          },
        }),
      }),
    ).rejects.toThrow(/协议握手失败/);

    expect(closed).toEqual(['bad']);
  });

  it('配置不是合法 JSON / 缺必填字段 → 报错说清是哪个变量哪一项', async () => {
    await expect(createProtocolTools({ env: { [MCP_SERVERS_ENV]: '{oops' } })).rejects.toThrow(
      new RegExp(`${MCP_SERVERS_ENV} 不是合法 JSON`),
    );
    await expect(createProtocolTools({ env: { [MCP_SERVERS_ENV]: '"a string"' } })).rejects.toThrow(/必须是一个 JSON 对象/);
    await expect(
      createProtocolTools({ env: { [MCP_SERVERS_ENV]: JSON.stringify({ orders: { args: ['x'] } }) } }),
    ).rejects.toThrow(/orders\.command 必须是非空字符串/);
    await expect(
      createProtocolTools({ env: { [MCP_SERVERS_ENV]: JSON.stringify({ orders: { command: 'npx', args: [1] } }) } }),
    ).rejects.toThrow(/args 必须是字符串数组/);
    await expect(
      createProtocolTools({ env: { [A2A_AGENTS_ENV]: JSON.stringify({ t: { url: '' } }) } }),
    ).rejects.toThrow(/t\.url 必须是非空字符串/);
    await expect(
      createProtocolTools({ env: { [A2A_AGENTS_ENV]: JSON.stringify({ t: { url: 'http://x', timeoutMs: -1 } }) } }),
    ).rejects.toThrow(/timeoutMs 必须是正数/);
  });

  it('对外入口能干净加载，协议层符号没被 export * 的歧义吃掉', async () => {
    const facade = await import('../src/index.js');
    // ESM 的 export * 遇到重名会静默丢弃该名字，所以逐个点名断言，而不是只看模块能加载
    for (const name of [
      'createProtocolTools',
      'parseMcpServers',
      'parseA2AAgents',
      'createMcpTools',
      'defaultConfirmPolicy',
      'jsonSchemaToZod',
      'modelParameters',
      'connectMcp',
      'createStdioMcpConnection',
      'createDelegateTool',
      'extractMessageText',
      'HttpA2AAgentClient',
      'A2A_METHOD_SEND',
      'AGENT_CARD_PATH',
      // 顺带确认老符号还在，没被协议层挤掉
      'ToolRegistry',
      'AgentLoop',
      'InMemoryCheckpointStore',
    ]) {
      expect(facade, `缺少导出 ${name}`).toHaveProperty(name);
    }
  });

  it('解析函数把可选字段带出来，空串当没配', () => {
    expect(parseMcpServers('  ')).toEqual({});
    expect(parseA2AAgents(undefined)).toEqual({});
    expect(
      parseMcpServers(JSON.stringify({ a: { command: 'npx', args: ['-y'], env: { K: 'v' }, prefix: 'p__' } })),
    ).toEqual({ a: { command: 'npx', args: ['-y'], env: { K: 'v' }, prefix: 'p__' } });
    expect(parseA2AAgents(JSON.stringify({ t: { url: 'http://x', timeoutMs: 100 } }))).toEqual({
      t: { url: 'http://x', timeoutMs: 100 },
    });
  });
});
