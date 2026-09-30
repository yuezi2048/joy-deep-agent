import type { ChatModel, ChatRequest } from '../providers/chat-model.js';
import type { ToolRegistry } from '../tools/registry.js';
import { AsyncQueue } from './async-queue.js';
import type { ChatMessage, ToolCall, ToolDefinition, ToolResult, Usage } from './types.js';

export type StopReason = 'completed' | 'max_steps' | 'no_progress' | 'cancelled';

export interface AgentRunResult {
  /** 最后一条 assistant 文本 */
  content: string;
  steps: number;
  stopReason: StopReason;
  /** 完整对话轨迹，含工具结果，可直接续跑 */
  messages: readonly ChatMessage[];
  toolCalls: readonly ToolCall[];
  usage: Usage;
}

export type AgentEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; result: ToolResult }
  | { type: 'done'; result: AgentRunResult };

export interface AgentLoopOptions {
  systemPrompt?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  /** 连续若干步的工具调用签名完全一致，判定为原地打转 */
  noProgressLimit?: number;
  /**
   * HITL 确认钩子。`requiresConfirmation` 的工具会先走这里；
   * 未提供钩子时默认拒绝——宁可拒绝，也不默认放行高风险操作。
   */
  confirm?: (call: ToolCall, definition: ToolDefinition) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface AgentLoopDeps {
  model: ChatModel;
  tools: ToolRegistry;
  options?: AgentLoopOptions;
}

export const DEFAULT_SYSTEM_PROMPT =
  '你是一个可以使用工具的助手。需要外部信息或执行动作时，调用合适的工具；不要编造工具名与参数。';

const DEFAULTS = {
  maxSteps: 8,
  temperature: 0.3,
  maxTokens: 4096,
  noProgressLimit: 3,
} as const;

/**
 * 自研 ReAct 循环：模型思考 → 工具调用 → 观察回灌 → 再思考，直到不再请求工具或命中终止条件。
 *
 * 本类只做编排，不掺防护逻辑：重试、熔断、预算、去重都在 ToolRegistry 的中间件链上（见 ADR-0002）。
 * 终止条件四选一：模型不再请求工具（completed）、步数用尽（max_steps）、
 * 原地打转（no_progress）、外部取消（cancelled）。
 */
export class AgentLoop {
  private readonly model: ChatModel;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly noProgressLimit: number;
  private readonly systemPrompt: string;
  private readonly confirm?: AgentLoopOptions['confirm'];
  private readonly signal?: AbortSignal;
  private readonly messages: ChatMessage[] = [];

  constructor(deps: AgentLoopDeps) {
    this.model = deps.model;
    this.tools = deps.tools;
    this.systemPrompt = deps.options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = deps.options?.maxSteps ?? DEFAULTS.maxSteps;
    this.temperature = deps.options?.temperature ?? DEFAULTS.temperature;
    this.maxTokens = deps.options?.maxTokens ?? DEFAULTS.maxTokens;
    this.noProgressLimit = deps.options?.noProgressLimit ?? DEFAULTS.noProgressLimit;
    this.confirm = deps.options?.confirm;
    this.signal = deps.options?.signal;
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  reset(): void {
    this.messages.length = 0;
  }

  /** 一次性执行（非流式）。 */
  async run(input: string): Promise<AgentRunResult> {
    return this.drive(input, null);
  }

  /**
   * 流式执行：文本增量实时吐出，工具调用与结果以事件形式给出。
   * 依次 yield 的 `done` 事件携带与 `run()` 完全一致的最终结果。
   */
  async *runStream(input: string): AsyncGenerator<AgentEvent, AgentRunResult> {
    const queue = new AsyncQueue<AgentEvent>();
    let result: AgentRunResult | null = null;
    const task = this.drive(input, (event) => queue.push(event)).then(
      (value) => {
        result = value;
        queue.close();
      },
      (error: unknown) => {
        queue.fail(error);
      },
    );

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      await task;
    }

    if (!result) throw new Error('AgentLoop 未产生执行结果');
    yield { type: 'done', result };
    return result;
  }

  private async drive(
    input: string,
    emit: ((event: AgentEvent) => void) | null,
  ): Promise<AgentRunResult> {
    this.tools.resetState();
    this.messages.push({ role: 'user', content: input });

    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const executed: ToolCall[] = [];
    const fingerprints: string[] = [];
    let lastContent = '';
    let steps = 0;

    for (let step = 0; step < this.maxSteps; step++) {
      steps = step + 1;
      if (emit) emit({ type: 'step_start', step: steps });

      if (this.signal?.aborted) {
        return this.finish(lastContent, steps, 'cancelled', executed, usage);
      }

      const turn = emit ? await this.turnStreaming(emit) : await this.turnPlain();
      accumulateUsage(usage, turn.usage);
      lastContent = turn.content;
      this.messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

      if (turn.toolCalls.length === 0) {
        return this.finish(lastContent, steps, 'completed', executed, usage);
      }

      executed.push(...turn.toolCalls);
      fingerprints.push(fingerprint(turn.toolCalls));
      const stuck = isStuck(fingerprints, this.noProgressLimit);

      // 即使判定卡死也把这一轮工具跑完：轨迹里缺 tool 结果会让后续请求结构非法
      for (const call of turn.toolCalls) {
        await this.executeCall(call, emit);
      }

      if (stuck) return this.finish(lastContent, steps, 'no_progress', executed, usage);
    }

    return this.finish(lastContent, steps, 'max_steps', executed, usage);
  }

  private async turnPlain(): Promise<TurnOutcome> {
    const response = await this.model.chat(this.buildRequest());
    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage };
  }

  private async turnStreaming(emit: (event: AgentEvent) => void): Promise<TurnOutcome> {
    let content = '';
    let toolCalls: ToolCall[] = [];
    let usage: Usage | undefined;

    for await (const chunk of this.model.chatStream(this.buildRequest())) {
      if (chunk.type === 'text') {
        content += chunk.delta;
        emit({ type: 'text', delta: chunk.delta });
      } else {
        toolCalls = chunk.toolCalls;
        usage = chunk.usage;
      }
    }

    return { content, toolCalls, usage };
  }

  private async executeCall(
    call: ToolCall,
    emit: ((event: AgentEvent) => void) | null,
  ): Promise<void> {
    emit?.({ type: 'tool_call', call });

    const definition = this.tools.get(call.name);
    const needsApproval = definition?.requiresConfirmation === true;
    let result: ToolResult;

    if (needsApproval && definition && !(await this.approve(call, definition))) {
      result = {
        content: `操作 "${call.name}" 需要人工确认，但未获确认（或已拒绝）。请改用其他方式，或向用户说明需要授权。`,
        isError: true,
      };
    } else {
      result = await this.tools.execute(call, this.signal);
    }

    this.messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: result.content,
    });
    emit?.({ type: 'tool_result', call, result });
  }

  private async approve(call: ToolCall, definition: ToolDefinition): Promise<boolean> {
    if (!this.confirm) return false;
    try {
      return await this.confirm(call, definition);
    } catch {
      return false;
    }
  }

  private buildRequest(): ChatRequest {
    const request: ChatRequest = {
      messages: [{ role: 'system', content: this.systemPrompt }, ...this.messages],
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    };
    const schemas = this.tools.schemas();
    if (schemas.length > 0) request.tools = schemas;
    if (this.signal) request.signal = this.signal;
    return request;
  }

  private finish(
    content: string,
    steps: number,
    stopReason: StopReason,
    toolCalls: ToolCall[],
    usage: Usage,
  ): AgentRunResult {
    return {
      content,
      steps,
      stopReason,
      messages: [...this.messages],
      toolCalls: [...toolCalls],
      usage,
    };
  }
}

interface TurnOutcome {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
}

function accumulateUsage(target: Usage, delta?: Usage): void {
  if (!delta) return;
  target.promptTokens = (target.promptTokens ?? 0) + (delta.promptTokens ?? 0);
  target.completionTokens = (target.completionTokens ?? 0) + (delta.completionTokens ?? 0);
  target.totalTokens = (target.totalTokens ?? 0) + (delta.totalTokens ?? 0);
}

function fingerprint(calls: readonly ToolCall[]): string {
  return calls.map((call) => `${call.name}:${call.rawArguments}`).join('|');
}

function isStuck(fingerprints: readonly string[], limit: number): boolean {
  if (limit <= 0 || fingerprints.length < limit) return false;
  const recent = fingerprints.slice(-limit);
  const first = recent[0];
  return first !== undefined && recent.every((item) => item === first);
}
