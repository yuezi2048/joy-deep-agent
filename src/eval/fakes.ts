import { NonRetryableError } from '../core/errors.js';
import type { ChatModel, ChatRequest, ChatResponse, StreamChunk } from '../providers/chat-model.js';
import type { ChatMessage, ToolCall, Usage } from '../core/types.js';
import { estimateMessageTokens, estimateTokens } from '../robust/token-counter.js';

/**
 * 评测用的确定性假供应商：行为由纯函数决定，不联网、不烧 key、重复跑结果一致。
 * 放在 src 而不是 test：场景库（#8）与服务化评测都要用它。
 */

export interface ScriptedModelOptions {
  /** 模拟真实供应商的上下文上限：提示超过它就像真模型一样报错 */
  contextLimitTokens?: number;
  /**
   * 是否回报 token（按本项目口径估算，确定性）。
   * 默认开：token 是报告的「代价列」，假供应商不回填会让这一列永远是 0。
   */
  reportUsage?: boolean;
}

export class ScriptedModel implements ChatModel {
  readonly supportsTools = true;
  readonly model: string;
  calls = 0;
  /** 收到的请求，供断言与调试 */
  readonly requests: ChatRequest[] = [];
  behavior: (request: ChatRequest) => Promise<ChatResponse>;

  constructor(
    readonly name: string,
    behavior: (request: ChatRequest) => Promise<ChatResponse> | ChatResponse,
    private readonly options: ScriptedModelOptions = {},
  ) {
    this.model = `${name}-1`;
    this.behavior = async (request) => behavior(request);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    this.requests.push(request);
    this.assertWithinContext(request);
    return this.withUsage(request, await this.behavior(request));
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.calls++;
    this.requests.push(request);
    this.assertWithinContext(request);
    const response = this.withUsage(request, await this.behavior(request));
    if (response.content) yield { type: 'text', delta: response.content };
    yield {
      type: 'done',
      finishReason: response.finishReason,
      toolCalls: response.toolCalls,
      usage: response.usage,
    };
  }

  /** 供应商没回 token 时按本项目口径估算补上，保证同一场景重复跑数字一致。 */
  private withUsage(request: ChatRequest, response: ChatResponse): ChatResponse {
    if (response.usage || this.options.reportUsage === false) return response;
    return { ...response, usage: estimateUsage(request, response) };
  }

  private assertWithinContext(request: ChatRequest): void {
    const limit = this.options.contextLimitTokens;
    if (limit === undefined) return;
    const tokens = request.messages.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    );
    if (tokens > limit) {
      throw new NonRetryableError(
        `context_length_exceeded: 提示约 ${tokens} token，超过上限 ${limit}`,
      );
    }
  }
}

/** 按字符权重估算一次调用的 token，口径见 `robust/token-counter.ts`。 */
export function estimateUsage(request: ChatRequest, response: ChatResponse): Usage {
  const promptTokens = request.messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
  const completionTokens = estimateTokens(response.content);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** 假供应商返回的文本回答。 */
export function fakeAnswer(content: string, usage?: Usage): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop', ...(usage ? { usage } : {}) };
}

/** 假供应商发起的一次工具调用。 */
export function fakeToolCall(
  name: string,
  args: Record<string, unknown>,
  id = `call_${name}`,
): ChatResponse {
  const call: ToolCall = { id, name, arguments: args, rawArguments: JSON.stringify(args) };
  return { content: '', toolCalls: [call], finishReason: 'tool_calls' };
}

/** 请求里已经拿到的工具结果。 */
export function observations(request: ChatRequest): ChatMessage[] {
  return request.messages.filter((message) => message.role === 'tool');
}
