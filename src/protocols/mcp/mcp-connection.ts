/**
 * MCP 客户端的**端口**（ADR-0005 / ADR-0006）。
 *
 * 官方 SDK 是传输实现，不是接口本身：适配器只认这个端口，
 * 于是单测可以注入假连接，不必起子进程、不必联网（见 `sdk-connection.ts`）。
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** 远端声明的入参 JSON Schema（MCP 规定是 object） */
  inputSchema?: Record<string, unknown>;
  /**
   * MCP 的 tool annotations。规范原文强调这**只是提示**，
   * 但「提示说只读」仍是我们判断要不要人工确认的默认依据（见 CONTEXT.md 远端工具确认策略）。
   */
  annotations?: McpToolAnnotations;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** MCP 的 content block。字段随 type 变，适配器只按 type 做保守渲染，不认识就不猜。 */
export type McpContentBlock = Record<string, unknown>;

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** 一个已连接的 MCP server。`serverName` 用于日志、工具名前缀与错误信息。 */
export interface McpConnection {
  readonly serverName: string;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}
