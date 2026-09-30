import OpenAI from 'openai';
import { NonRetryableError } from '../core/errors.js';
import type { ChatMessage, ToolCall, Usage } from '../core/types.js';
import { parseToolArguments } from '../tools/arguments.js';
import type { ChatModel, ChatRequest, ChatResponse, FinishReason, StreamChunk } from './chat-model.js';
import type { ProviderConfig } from './provider-config.js';

export interface OpenAIChatModelOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * OpenAI 兼容实现。DeepSeek / OpenAI / 通义千问 / Ollama 都走这条路径，
 * 差异只在 ProviderConfig 的 baseURL 与 model。
 *
 * 本类只负责「一次调用」，不含重试与熔断——那是鲁棒性层的事，
 * 保持单一职责才能让每类故障独立测试。
 */
export class OpenAIChatModel implements ChatModel {
  readonly name: string;
  readonly model: string;
  readonly supportsTools = true;

  private readonly client: OpenAI;
  private readonly defaults: OpenAIChatModelOptions;

  constructor(
    private readonly config: ProviderConfig,
    options: OpenAIChatModelOptions = {},
  ) {
    this.name = config.name;
    this.model = config.model;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.defaults = options;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      ...this.buildPayload(request),
      stream: false,
    });
    return parseResponse(response);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const stream = await this.client.chat.completions.create({
      ...this.buildPayload(request),
      stream: true,
    });

    const accumulators = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: FinishReason = null;
    let usage: Usage | undefined;

    for await (const chunk of stream as unknown as AsyncIterable<any>) {
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;

      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', delta: delta.content };
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = typeof part?.index === 'number' ? part.index : 0;
          const acc = accumulators.get(index) ?? { id: '', name: '', arguments: '' };
          if (part?.id) acc.id = part.id;
          if (part?.function?.name) acc.name += part.function.name;
          if (part?.function?.arguments) acc.arguments += part.function.arguments;
          accumulators.set(index, acc);
        }
      }

      if (choice?.finish_reason) finishReason = normalizeFinishReason(choice.finish_reason);
      if (chunk?.usage) usage = parseUsage(chunk.usage);
    }

    const toolCalls: ToolCall[] = [...accumulators.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, acc]) => acc.name !== '')
      .map(([, acc], index) => ({
        id: acc.id || `call_${index}`,
        name: acc.name,
        arguments: parseToolArguments(acc.arguments).value,
        rawArguments: acc.arguments,
      }));

    yield { type: 'done', finishReason, toolCalls, usage };
  }

  private buildPayload(request: ChatRequest): any {
    const payload: any = {
      model: this.model,
      messages: request.messages.map(toOpenAIMessage),
      temperature: request.temperature ?? this.defaults.temperature,
      max_tokens: request.maxTokens ?? this.defaults.maxTokens,
    };
    if (request.signal) payload.signal = request.signal;
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    return payload;
  }
}

function toOpenAIMessage(message: ChatMessage): any {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.rawArguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function parseResponse(response: any): ChatResponse {
  const choice = response?.choices?.[0];
  if (!choice) {
    throw new NonRetryableError('模型未返回任何 choice，响应结构异常');
  }
  const message = choice.message ?? {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: parseToolCalls(message.tool_calls),
    finishReason: normalizeFinishReason(choice.finish_reason),
    usage: parseUsage(response.usage),
  };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw as any[]) {
    const fn = item?.function;
    if (!fn?.name) continue;
    const rawArguments = typeof fn.arguments === 'string' ? fn.arguments : '';
    calls.push({
      id: typeof item?.id === 'string' && item.id ? item.id : `call_${calls.length}`,
      name: fn.name,
      arguments: parseToolArguments(rawArguments).value,
      rawArguments,
    });
  }
  return calls;
}

function normalizeFinishReason(reason: unknown): FinishReason {
  if (reason === 'stop' || reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') {
    return reason;
  }
  return null;
}

function parseUsage(raw: any): Usage | undefined {
  if (!raw) return undefined;
  return {
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens,
  };
}
