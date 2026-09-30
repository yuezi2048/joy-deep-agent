import type { ToolDefinition, ToolResult } from '../../core/types.js';
import { toErrorResult } from '../../core/types.js';
import { errorMessage } from '../../core/errors.js';
import { isRecord } from '../../core/record.js';
import type { McpCallResult, McpConnection, McpContentBlock, McpToolDescriptor } from './mcp-connection.js';
import { jsonSchemaToZod, modelParameters } from './schema-bridge.js';

/**
 * MCP → 工具来源（ADR-0005）。
 *
 * 适配器把远端 MCP server 的每个 tool 变成本地的 `ToolDefinition`，注册进同一个 `ToolRegistry`。
 * 于是远端工具和内置工具在中间件（重试 / 超时 / 熔断 / 去重 / 预算）、HITL 确认、前置依赖上完全同权——
 * 主循环压根不知道它是远的。
 */
export interface McpToolOptions {
  /** 工具名前缀，默认 `mcp__<serverName>__`。多个 server 共用一个注册表时靠它避免撞名。 */
  prefix?: string;
  /** 是否要求人工确认。默认：远端没明说 `readOnlyHint: true` 就要确认（宁严勿松）。 */
  confirmPolicy?: (tool: McpToolDescriptor) => boolean;
  /** 过滤远端工具，例如只放行只读工具。 */
  toolFilter?: (tool: McpToolDescriptor) => boolean;
}

/** MCP 未显式声明只读 → 视为可能有副作用，要求人工确认。 */
export function defaultConfirmPolicy(tool: McpToolDescriptor): boolean {
  return tool.annotations?.readOnlyHint !== true;
}

export async function createMcpTools(
  connection: McpConnection,
  options: McpToolOptions = {},
): Promise<ToolDefinition[]> {
  const prefix = options.prefix ?? `mcp__${connection.serverName}__`;
  const confirmPolicy = options.confirmPolicy ?? defaultConfirmPolicy;
  const descriptors = await connection.listTools();

  return descriptors
    .filter((descriptor) => descriptor && typeof descriptor.name === 'string' && descriptor.name.length > 0)
    .filter((descriptor) => (options.toolFilter ? options.toolFilter(descriptor) : true))
    .map((descriptor) => buildTool(connection, prefix, confirmPolicy, descriptor));
}

function buildTool(
  connection: McpConnection,
  prefix: string,
  confirmPolicy: (tool: McpToolDescriptor) => boolean,
  descriptor: McpToolDescriptor,
): ToolDefinition {
  const name = `${prefix}${descriptor.name}`;
  // 先算确认结论再写描述：自定义 confirmPolicy 时，描述不能还按注解另猜一遍
  const requiresConfirmation = confirmPolicy(descriptor);
  const definition: ToolDefinition = {
    name,
    description: describeTool(connection, descriptor, name, requiresConfirmation),
    schema: jsonSchemaToZod(descriptor.inputSchema),
    handler: async (args: Record<string, unknown>, ctx) =>
      callRemote(connection, descriptor.name, name, args, ctx.signal),
    requiresConfirmation,
  };

  // 远端本来就有权威 JSON Schema：能直通就直通，模型看到的信息比 zod 往返更完整
  const parameters = modelParameters(descriptor.inputSchema);
  if (parameters) definition.parameters = parameters;

  return definition;
}

function describeTool(
  connection: McpConnection,
  descriptor: McpToolDescriptor,
  name: string,
  requiresConfirmation: boolean,
): string {
  const parts = [`[MCP ${connection.serverName}] ${descriptor.description?.trim() || '（远端未提供描述）'}`];
  if (descriptor.annotations?.title) parts.push(`标题：${descriptor.annotations.title}`);
  parts.push(`需人工确认：${requiresConfirmation ? '是' : '否'}`);
  return `${parts.join('；')}（远端工具名：${descriptor.name}，本地名：${name}）`;
}

async function callRemote(
  connection: McpConnection,
  remoteName: string,
  localName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  let result: McpCallResult;
  try {
    result = await connection.callTool(remoteName, args ?? {}, signal);
  } catch (error) {
    // 远端不可用是可预期的外部故障：给可读反馈让模型换路，而不是抛异常把整轮任务带崩
    return toErrorResult(
      `调用远端 MCP 工具 "${localName}" 失败：${errorMessage(error)}。可以稍后重试，或改用其他工具。`,
    );
  }

  return {
    content: renderResult(connection, localName, result),
    isError: result?.isError === true,
  };
}

/** 把 MCP 的 content blocks 拍平成一段文本。不认识的类型如实占位，不猜、不丢。 */
export function renderResult(connection: McpConnection, localName: string, result: McpCallResult): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const rendered = blocks.map(renderBlock).filter((line) => line.length > 0);

  if (rendered.length === 0) {
    if (result?.structuredContent !== undefined) {
      return `（远端工具 "${localName}" 返回结构化内容）\n${safeStringify(result.structuredContent)}`;
    }
    return `（远端工具 "${localName}" 没有返回任何内容）`;
  }

  const text = rendered.join('\n');
  const header = result?.isError === true ? `远端工具 "${localName}" 报错：\n` : '';
  return `${header}${text}`;
}

function renderBlock(block: McpContentBlock): string {
  const type = typeof block.type === 'string' ? block.type : '(无类型)';

  switch (type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
      // 图片二进制塞进上下文又贵又没用，只留一条可追溯的占位
      return `[图片 ${mimeOf(block)}，${byteLength(block.data)} 字节，未内联]`;
    case 'audio':
      return `[音频 ${mimeOf(block)}，${byteLength(block.data)} 字节，未内联]`;
    case 'resource_link':
      return `[资源链接 ${stringOf(block.uri) ?? '(无 uri)'}${stringOf(block.name) ? `（${stringOf(block.name)}）` : ''}]`;
    case 'resource': {
      const resource = isRecord(block.resource) ? block.resource : undefined;
      if (!resource) return '[资源（结构无法解析）]';
      if (typeof resource.text === 'string') return resource.text;
      if (typeof resource.blob === 'string') {
        return `[二进制资源 ${stringOf(resource.uri) ?? '(无 uri)'}，${byteLength(resource.blob)} 字节，未内联]`;
      }
      return `[资源 ${stringOf(resource.uri) ?? '(无 uri)'}]`;
    }
    default:
      return `[不支持的 MCP 内容类型 "${type}"：${safeStringify(block)}]`;
  }
}

function mimeOf(block: McpContentBlock): string {
  return stringOf(block.mimeType) ?? '未知类型';
}

function byteLength(value: unknown): number {
  if (typeof value !== 'string') return 0;
  // base64 长度换算成字节数，只为给个量级，不追求精确
  return Math.floor((value.length * 3) / 4);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
