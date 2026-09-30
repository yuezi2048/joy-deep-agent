import type { ChatMessage, ToolCall, ToolSchema, Usage } from '../core/types.js';

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: Usage;
}

/**
 * 流式输出的增量事件。
 * 工具调用无法边生成边执行，所以在 `done` 里一次性给出，由 AgentLoop 决定要不要执行。
 */
export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'done'; finishReason: FinishReason; toolCalls: ToolCall[]; usage?: Usage };

/**
 * 模型调用抽象。供应商差异由配置承载（见 ADR-0003），不下渗到 AgentLoop。
 * 新增非 OpenAI 兼容供应商时实现本接口即可，调用方零改动。
 */
export interface ChatModel {
  readonly name: string;
  readonly model: string;
  readonly supportsTools: boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;
}
