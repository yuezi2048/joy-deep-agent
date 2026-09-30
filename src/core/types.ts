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
  /** 高风险操作，需要 HITL 确认后才执行 */
  requiresConfirmation?: boolean;
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
