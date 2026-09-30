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
