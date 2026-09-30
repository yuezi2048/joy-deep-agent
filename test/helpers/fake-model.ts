import type {
  ChatModel,
  ChatRequest,
  ChatResponse,
  StreamChunk,
} from '../../src/providers/chat-model.js';

/** 按剧本回放的假模型：不联网、不烧 key，用来验证循环逻辑本身。 */
export class FakeChatModel implements ChatModel {
  readonly name = 'fake';
  readonly model = 'fake-1';
  readonly supportsTools = true;
  readonly calls: ChatRequest[] = [];

  private readonly script: ChatResponse[];

  constructor(script: ChatResponse[]) {
    this.script = [...script];
  }

  get remaining(): number {
    return this.script.length;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    return this.next();
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.calls.push(request);
    const response = this.next();
    if (response.content) yield { type: 'text', delta: response.content };
    yield {
      type: 'done',
      finishReason: response.finishReason,
      toolCalls: response.toolCalls,
      usage: response.usage,
    };
  }

  private next(): ChatResponse {
    const response = this.script.shift();
    if (!response) throw new Error('FakeChatModel 剧本已耗尽');
    return response;
  }
}

export function toolTurn(name: string, args: Record<string, unknown>, id = 'call_1'): ChatResponse {
  return {
    content: '',
    toolCalls: [{ id, name, arguments: args, rawArguments: JSON.stringify(args) }],
    finishReason: 'tool_calls',
  };
}

export function answerTurn(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

/** 一轮里同时发起多个工具调用，用来验证「一组调用执行到一半被打断」这类场景。 */
export function multiToolTurn(
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  idPrefix = 'call',
): ChatResponse {
  return {
    content: '',
    toolCalls: calls.map((item, index) => ({
      id: `${idPrefix}_${index}`,
      name: item.name,
      arguments: item.args,
      rawArguments: JSON.stringify(item.args),
    })),
    finishReason: 'tool_calls',
  };
}

/** 可编程的假模型：行为随时可换，顺便数调用次数。用于「按需失败 / 卡住」这类场景。 */
export class StubChatModel implements ChatModel {
  readonly supportsTools = true;
  readonly model = 'stub-1';
  calls = 0;
  behavior: (request: ChatRequest) => Promise<ChatResponse>;
  streamBehavior?: (request: ChatRequest) => AsyncIterable<StreamChunk>;

  constructor(
    readonly name: string,
    behavior: (request: ChatRequest) => Promise<ChatResponse>,
    streamBehavior?: (request: ChatRequest) => AsyncIterable<StreamChunk>,
  ) {
    this.behavior = behavior;
    this.streamBehavior = streamBehavior;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    return this.behavior(request);
  }

  chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.calls++;
    return this.streamBehavior ? this.streamBehavior(request) : toStream(this.behavior(request));
  }
}

export async function* toStream(response: Promise<ChatResponse>): AsyncIterable<StreamChunk> {
  const value = await response;
  if (value.content) yield { type: 'text', delta: value.content };
  yield {
    type: 'done',
    finishReason: value.finishReason,
    toolCalls: value.toolCalls,
    usage: value.usage,
  };
}
