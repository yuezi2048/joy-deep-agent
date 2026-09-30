import type { ZodType } from 'zod';

/** 对话消息角色。`tool` 是工具结果回灌给模型的角色。 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 模型请求的一次工具调用。`arguments` 是解析后的对象，`rawArguments` 保留原始字符串以便排错。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

/** 统一的消息结构，与具体供应商无关。 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** assistant 发起工具调用时携带 */
  toolCalls?: ToolCall[];
  /** role === 'tool' 时，指回对应的 ToolCall.id */
  toolCallId?: string;
  /** role === 'tool' 时，工具名 */
  name?: string;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 工具执行结果。`isError` 为真时，内容会作为「可读的失败反馈」回灌给模型，而不是抛异常中断循环。 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** 传给模型的工具声明（JSON Schema）。 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  callId: string;
  signal?: AbortSignal;
}

export type ToolOutcome = ToolResult | string;

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ZodType;
  handler: (args: any, ctx: ToolContext) => Promise<ToolOutcome>;
  /**
   * 直接交给模型的参数 schema，覆盖由 `schema` 推导出的那份。
   * 远端工具（MCP）本来就有权威 JSON Schema，经 zod 往返会丢信息；本地校验仍走 `schema`。
   */
  parameters?: Record<string, unknown>;
  /** 高风险操作，需要 HITL 确认后才执行 */
  requiresConfirmation?: boolean;
  /**
   * 前置工具：必须先成功执行过它们，本工具才会被调用（例如「先查订单再改订单」）。
   * 未满足时返回可读反馈，工具本体不会被触达；成环在注册阶段就会报错。
   */
  requires?: readonly string[];
}

/** 工具链上的一环。中间件包住 `next`，返回一个新的处理器。 */
export type ToolHandler = (call: ToolCall) => Promise<ToolResult>;
export type ToolMiddleware = (next: ToolHandler) => ToolHandler;

export function toToolResult(outcome: ToolOutcome): ToolResult {
  return typeof outcome === 'string' ? { content: outcome } : outcome;
}

export function toErrorResult(content: string): ToolResult {
  return { content, isError: true };
}

/** 把一次调用的 token 账累加进总计。多处要算「一共烧了多少」，口径必须只有一处。 */
export function addUsage(target: Usage, delta?: Usage): void {
  if (!delta) return;
  target.promptTokens = (target.promptTokens ?? 0) + (delta.promptTokens ?? 0);
  target.completionTokens = (target.completionTokens ?? 0) + (delta.completionTokens ?? 0);
  target.totalTokens = (target.totalTokens ?? 0) + (delta.totalTokens ?? 0);
}
