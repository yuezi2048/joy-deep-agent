import { isRecord } from '../../core/record.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  McpCallResult,
  McpConnection,
  McpContentBlock,
  McpToolAnnotations,
  McpToolDescriptor,
} from './mcp-connection.js';

/**
 * 官方 MCP SDK 的传输实现（ADR-0006：全仓库只有本文件与 a2a 的 HTTP 客户端允许 import 官方 SDK）。
 *
 * 这里只做一件事：把 SDK 的类型收敛到 `McpConnection` 端口上。
 * 规范与 SDK 迭代时，改动面就锁在这一层，适配器与主循环不受影响。
 */
/** 连一个任意 transport（stdio / in-memory），返回端口。 */
export async function connectMcp(serverName: string, transport: Transport): Promise<McpConnection> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  return wrapMcpClient(serverName, client);
}

/**
 * 以子进程方式拉起 MCP server（stdio 传输）。
 * 子进程 stderr 直接透传：MCP 约定 server 日志走 stderr，stdout 归 JSON-RPC 独占。
 */
export async function createStdioMcpConnection(
  serverName: string,
  params: StdioServerParameters,
): Promise<McpConnection> {
  return connectMcp(serverName, new StdioClientTransport({ stderr: 'inherit', ...params }));
}

/** 握手时自报的身份，会出现在远端 server 的日志里。 */
const CLIENT_INFO = { name: 'joy-deep-agent', version: '0.1.0' } as const;

/** 把已连上的 SDK Client 包成端口。单独暴露是为了测试能注入 in-memory transport。 */
export function wrapMcpClient(serverName: string, client: Client): McpConnection {
  return {
    serverName,
    async listTools(): Promise<McpToolDescriptor[]> {
      const result = await client.listTools();
      return (result.tools ?? []).map(toDescriptor);
    },
    async callTool(name, args, signal): Promise<McpCallResult> {
      const result = await client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
      return toCallResult(result);
    },
    close: () => client.close(),
  };
}

function toDescriptor(raw: unknown): McpToolDescriptor {
  const record = isRecord(raw) ? raw : {};
  const descriptor: McpToolDescriptor = {
    name: typeof record.name === 'string' ? record.name : '',
  };
  if (typeof record.description === 'string') descriptor.description = record.description;
  if (isRecord(record.inputSchema)) descriptor.inputSchema = record.inputSchema;

  const annotations = toAnnotations(record.annotations);
  if (annotations) descriptor.annotations = annotations;

  return descriptor;
}

function toAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const annotations: McpToolAnnotations = {};
  if (typeof raw.title === 'string') annotations.title = raw.title;
  if (typeof raw.readOnlyHint === 'boolean') annotations.readOnlyHint = raw.readOnlyHint;
  if (typeof raw.destructiveHint === 'boolean') annotations.destructiveHint = raw.destructiveHint;
  if (typeof raw.idempotentHint === 'boolean') annotations.idempotentHint = raw.idempotentHint;
  if (typeof raw.openWorldHint === 'boolean') annotations.openWorldHint = raw.openWorldHint;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function toCallResult(raw: unknown): McpCallResult {
  const record = isRecord(raw) ? raw : {};
  const content: McpContentBlock[] = Array.isArray(record.content)
    ? record.content.filter(isRecord)
    : [];

  const result: McpCallResult = { content };
  if (record.isError === true) result.isError = true;
  if (record.structuredContent !== undefined) result.structuredContent = record.structuredContent;
  return result;
}
