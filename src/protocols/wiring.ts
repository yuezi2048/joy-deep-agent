import type { ToolDefinition } from '../core/types.js';
import { errorMessage } from '../core/errors.js';
import { HttpA2AAgentClient, createDelegateTool, type A2AAgentClient } from './a2a/index.js';
import { createMcpTools, createStdioMcpConnection, type McpConnection } from './mcp/index.js';
import {
  parseA2AAgents,
  parseMcpServers,
  type A2AAgentConfig,
  type McpServerConfig,
} from './wiring-config.js';

/**
 * 把环境变量里声明的远端，装配成本地工具（ADR-0006）。
 *
 * MCP server 的每个 tool 与 A2A 的 `delegate` 都进同一个 `ToolRegistry`，
 * 与内置工具共享中间件 / HITL / 依赖序。两个变量都留空时不加任何工具，
 * 行为与没接协议时完全一致。
 */
export interface ProtocolWiringOptions {
  env?: NodeJS.ProcessEnv;
  /** 注入用：建 MCP 连接（默认 stdio 拉起子进程） */
  connectMcpServer?: (name: string, config: McpServerConfig) => Promise<McpConnection>;
  /** 注入用：建 A2A 客户端 */
  createA2AClient?: (name: string, config: A2AAgentConfig) => A2AAgentClient;
}

export interface ProtocolTools {
  tools: ToolDefinition[];
  /** 关掉所有 MCP 子进程 / 连接。 */
  close(): Promise<void>;
}

export async function createProtocolTools(options: ProtocolWiringOptions = {}): Promise<ProtocolTools> {
  const env = options.env ?? process.env;
  const servers = parseMcpServers(env.MCP_SERVERS);
  const agents = parseA2AAgents(env.A2A_AGENTS);

  const connect = options.connectMcpServer ?? defaultConnect;
  const buildClient = options.createA2AClient ?? defaultClient;

  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  try {
    for (const [name, config] of Object.entries(servers)) {
      const connection = await openServer(name, config, connect);
      connections.push(connection);
      tools.push(...(await createMcpTools(connection, config.prefix ? { prefix: config.prefix } : {})));
    }

    if (Object.keys(agents).length > 0) {
      const clients = Object.entries(agents).map(([name, config]) => buildClient(name, config));
      tools.push(await createDelegateTool(clients));
    }
  } catch (error) {
    // 半装起来的运行时不如不装：把已经拉起来的子进程收干净再上抛
    await closeAll(connections);
    throw error;
  }

  return { tools, close: () => closeAll(connections) };
}

async function openServer(
  name: string,
  config: McpServerConfig,
  connect: (name: string, config: McpServerConfig) => Promise<McpConnection>,
): Promise<McpConnection> {
  try {
    return await connect(name, config);
  } catch (error) {
    throw new Error(
      `连接 MCP server "${name}" 失败：${errorMessage(error)}。检查 MCP_SERVERS 里这一项的 command/args 是否正确、服务是否可拉起。`,
    );
  }
}

async function closeAll(connections: readonly McpConnection[]): Promise<void> {
  const results = await Promise.allSettled(connections.map((connection) => connection.close()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    console.error(
      `关闭 MCP 连接时有 ${failures.length} 个失败：`,
      failures.map((item) => errorMessage(item.reason)).join('；'),
    );
  }
}

function defaultConnect(name: string, config: McpServerConfig): Promise<McpConnection> {
  return createStdioMcpConnection(name, {
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
  });
}

function defaultClient(name: string, config: A2AAgentConfig): A2AAgentClient {
  return new HttpA2AAgentClient(name, config);
}
