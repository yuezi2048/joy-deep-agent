import type { CheckpointStore } from '../memory/checkpoint-store.js';
import type { ChatModel, ChatRequest } from '../providers/chat-model.js';
import type { ToolRegistry } from '../tools/registry.js';
import { AsyncQueue } from './async-queue.js';
import { deterministicToolCallId } from './stable-key.js';
import { CITATION_INSTRUCTION, checkCitations } from '../robust/citation-guard.js';
import { SelfChecker } from '../robust/self-check.js';
import { addUsage, type ChatMessage, type ToolCall, type ToolDefinition, type ToolResult, type Usage } from './types.js';

export type StopReason =
  | 'completed'
  | 'max_steps'
  | 'no_progress'
  | 'loop_detected'
  | 'timeout'
  | 'cancelled';

/** 交付前核查这一版的结论。未开启核查时结果里没有这个字段。 */
export interface VerificationReport {
  /** 交付前一共修正了几轮 */
  rounds: number;
  /** 最终交付的这一版是否通过核查 */
  passed: boolean;
  issues: string[];
  /** 核查器本身没跑成（输出没法解析 / 调用失败）时置位——这一版可能并没有真被检查过 */
  degraded: boolean;
  degradedReason?: string;
}

export interface AgentRunResult {
  /** 最后一条 assistant 文本 */
  content: string;
  steps: number;
  stopReason: StopReason;
  /** 停下来的具体理由（横跳周期、超时耗时等），排查时不用再猜 */
  stopDetail?: string;
  /** 交付前核查记录；两层都关时为空 */
  verification?: VerificationReport;
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

/** 来源约束：要求关键结论标注真正得到过的工具结果（见 `robust/citation-guard.ts`）。 */
export interface SourceConstraintOptions {
  enabled?: boolean;
  /** 用过工具却一个标注都没有时是否算问题（默认 true） */
  requireCitation?: boolean;
}

/** 自我核查：交付前让核查模型挑出没有依据的断言（见 `robust/self-check.ts`）。 */
export interface SelfCheckOptions {
  enabled?: boolean;
  /** 最多修正几轮，超过就带着问题交付并如实记录 */
  maxRounds?: number;
  /** 用另一个（更便宜的）模型做核查；默认复用主模型 */
  model?: ChatModel;
}

/** 检查点配置：`store` 决定存哪儿，`id` 标识任务——只有同一个 id 才能续跑。 */
export interface CheckpointOptions {
  store: CheckpointStore;
  id: string;
}

/**
 * 中断时落盘的进度快照。
 * `messages` 里既有 assistant 声明过的调用，也有已拿到的工具结果，
 * 因此「已经做了什么、拿到哪些结果」都能还原；`executed` 用于如实报告本轮的调用清单。
 */
export interface AgentCheckpointState {
  input: string;
  messages: ChatMessage[];
  /** 已完成的步数；续跑从下一步接着走 */
  steps: number;
  lastContent: string;
  fingerprints: string[];
  usage: Usage;
  executed: ToolCall[];
  /** 已成功执行过的工具名：续跑时回填给工具注册表，前置依赖才不会被误判为未满足 */
  completedTools?: string[];
}

/** 单次执行的可变状态。消息存在实例的 `messages` 上，核查轮数只属于本次执行，不落盘。 */
interface RunState {
  input: string;
  steps: number;
  lastContent: string;
  fingerprints: string[];
  usage: Usage;
  executed: ToolCall[];
  /** 本次执行已经用掉的核查修正轮数 */
  revisions: number;
  /** 最近一次交付前核查的结果 */
  verification?: VerificationReport;
}

export interface AgentLoopOptions {
  systemPrompt?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  /** 连续若干步的工具调用签名完全一致，判定为原地打转 */
  noProgressLimit?: number;
  /** 横跳检测：末尾出现「周期 2..maxCyclePeriod 的序列重复 cycleRepeats 次」即判定为绕圈 */
  maxCyclePeriod?: number;
  cycleRepeats?: number;
  /** 单次任务的墙钟上限（毫秒），0 表示不限。到点会掐断在飞的模型 / 工具调用 */
  maxDurationMs?: number;
  /** 时间源，测试可注入假时钟 */
  now?: () => number;
  /** 来源约束：要求关键结论标注真正得到的工具结果 */
  sourceConstraint?: SourceConstraintOptions;
  /** 自我核查：交付前跑一次来源核查，不通过就把问题回灌给模型修正 */
  selfCheck?: SelfCheckOptions;
  /**
   * HITL 确认钩子。`requiresConfirmation` 的工具会先走这里；
   * 未提供钩子时默认拒绝——宁可拒绝，也不默认放行高风险操作。
   */
  confirm?: (call: ToolCall, definition: ToolDefinition) => Promise<boolean>;
  signal?: AbortSignal;
  /** 提供后每个步边界与每次工具调用都会落盘，支持中断续跑（见 ADR-0004） */
  checkpoint?: CheckpointOptions;
  /**
   * 初始上下文：构造时预置进消息轨迹，用来把上一个进程留下的会话接回来（见 AgentService）。
   * 预置的消息不占步数，只是开场白；`reset()` 会连它一起清掉。
   */
  initialMessages?: readonly ChatMessage[];
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
  maxCyclePeriod: 3,
  cycleRepeats: 2,
  maxDurationMs: 300_000,
  selfCheckRounds: 2,
} as const;

/**
 * 自研 ReAct 循环：模型思考 → 工具调用 → 观察回灌 → 再思考，直到不再请求工具或命中终止条件。
 *
 * 工具调用链上的防护（重试、熔断、预算、去重）都在 ToolRegistry 的中间件链上（见 ADR-0002）；
 * 本类只额外持有「交付前核查」——它看的是最终答案，挂不到工具调用链上。
 * 终止条件：模型不再请求工具（completed）、步数用尽（max_steps）、原地打转（no_progress）、
 * 两个工具之间来回横跳（loop_detected）、墙钟超限（timeout）、外部取消（cancelled）。
 *
 * 传入 `options.checkpoint` 后具备中断续跑能力：`run()` 冷启动，`resume()` 从检查点接着走。
 */
export class AgentLoop {
  private readonly model: ChatModel;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly noProgressLimit: number;
  private readonly maxCyclePeriod: number;
  private readonly cycleRepeats: number;
  private readonly maxDurationMs: number;
  private readonly now: () => number;
  private readonly systemPrompt: string;
  private readonly sourceConstraint?: AgentLoopOptions['sourceConstraint'];
  private readonly selfCheck?: AgentLoopOptions['selfCheck'];
  private readonly checker?: SelfChecker;
  private readonly confirm?: AgentLoopOptions['confirm'];
  private readonly signal?: AbortSignal;
  private readonly checkpoint?: CheckpointOptions;
  private readonly messages: ChatMessage[] = [];
  /** 本次执行的有效信号：调用方信号 + 墙钟到点后的内部掐断。工具与模型都看它。 */
  private runSignal?: AbortSignal;
  private timedOut = false;

  constructor(deps: AgentLoopDeps) {
    this.model = deps.model;
    this.tools = deps.tools;
    this.sourceConstraint = deps.options?.sourceConstraint;
    this.selfCheck = deps.options?.selfCheck;
    this.checker =
      deps.options?.selfCheck?.enabled
        ? new SelfChecker(deps.options.selfCheck.model ?? deps.model)
        : undefined;
    const basePrompt = deps.options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    // 要查标注，就得先告诉模型标注怎么写，否则等于用没约定过的格式去判它违规
    this.systemPrompt =
      this.sourceConstraint?.enabled === true
        ? `${basePrompt}\n\n${CITATION_INSTRUCTION}`
        : basePrompt;
    this.maxSteps = deps.options?.maxSteps ?? DEFAULTS.maxSteps;
    this.temperature = deps.options?.temperature ?? DEFAULTS.temperature;
    this.maxTokens = deps.options?.maxTokens ?? DEFAULTS.maxTokens;
    this.noProgressLimit = deps.options?.noProgressLimit ?? DEFAULTS.noProgressLimit;
    this.maxCyclePeriod = deps.options?.maxCyclePeriod ?? DEFAULTS.maxCyclePeriod;
    this.cycleRepeats = deps.options?.cycleRepeats ?? DEFAULTS.cycleRepeats;
    this.maxDurationMs = deps.options?.maxDurationMs ?? DEFAULTS.maxDurationMs;
    this.now = deps.options?.now ?? Date.now;
    this.confirm = deps.options?.confirm;
    this.signal = deps.options?.signal;
    this.checkpoint = deps.options?.checkpoint;
    if (deps.options?.initialMessages?.length) {
      this.messages.push(...deps.options.initialMessages.map((message) => ({ ...message })));
    }
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  reset(): void {
    this.messages.length = 0;
  }

  /** 一次性执行（非流式）。冷启动：同一个 id 上的旧进度会被丢弃。 */
  async run(input: string): Promise<AgentRunResult> {
    await this.clearCheckpoint();
    return this.drive(input, null, null);
  }

  /**
   * 从检查点续跑（非流式）。
   * 没有检查点时按冷启动处理，此时必须提供 `input`，否则报错——不会静默什么都不做。
   */
  async resume(input?: string): Promise<AgentRunResult> {
    const restored = await this.loadCheckpoint();
    return this.drive(...this.startFrom(restored, input), null);
  }

  /**
   * 流式执行：文本增量实时吐出，工具调用与结果以事件形式给出。
   * 依次 yield 的 `done` 事件携带与 `run()` 完全一致的最终结果。
   */
  runStream(input: string): AsyncGenerator<AgentEvent, AgentRunResult> {
    return this.streamFrom(async (emit) => {
      await this.clearCheckpoint();
      return this.drive(input, null, emit);
    });
  }

  /** 流式续跑，语义同 `resume()`。 */
  resumeStream(input?: string): AsyncGenerator<AgentEvent, AgentRunResult> {
    return this.streamFrom(async (emit) => {
      const restored = await this.loadCheckpoint();
      const [resumeInput, state] = this.startFrom(restored, input);
      return this.drive(resumeInput, state, emit);
    });
  }

  /** 丢弃当前 id 上的检查点（`run()` 冷启动时也会调）。 */
  async clearCheckpoint(): Promise<void> {
    if (!this.checkpoint) return;
    await this.checkpoint.store.delete(this.checkpoint.id);
  }

  private startFrom(
    restored: AgentCheckpointState | null,
    input: string | undefined,
  ): [string, AgentCheckpointState | null] {
    if (restored) return [input ?? restored.input, restored];
    if (input === undefined) {
      throw new Error(
        `没有 id 为 "${this.checkpoint?.id ?? '(未配置)'}" 的检查点，也没有提供 input：无法启动任务`,
      );
    }
    return [input, null];
  }

  private async *streamFrom(
    start: (emit: (event: AgentEvent) => void) => Promise<AgentRunResult>,
  ): AsyncGenerator<AgentEvent, AgentRunResult> {
    const queue = new AsyncQueue<AgentEvent>();
    let result: AgentRunResult | null = null;
    const task = start((event) => queue.push(event)).then(
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

  /**
   * 执行的外壳：装上墙钟上限（到点掐断在飞的模型 / 工具调用），跑完再把信号卸掉。
   * 计时从本次 drive 开始算——续跑是新的一次执行，重新计时。
   */
  private async drive(
    input: string,
    restored: AgentCheckpointState | null,
    emit: ((event: AgentEvent) => void) | null,
  ): Promise<AgentRunResult> {
    const deadlineSignal = new AbortController();
    this.timedOut = false;
    const timer =
      this.maxDurationMs > 0
        ? setTimeout(() => {
            this.timedOut = true;
            deadlineSignal.abort();
          }, this.maxDurationMs)
        : null;
    timer?.unref?.();

    this.runSignal = this.signal
      ? AbortSignal.any([this.signal, deadlineSignal.signal])
      : deadlineSignal.signal;

    try {
      return await this.driveInternal(input, restored, emit);
    } finally {
      if (timer) clearTimeout(timer);
      this.runSignal = undefined;
    }
  }

  private async driveInternal(
    input: string,
    restored: AgentCheckpointState | null,
    emit: ((event: AgentEvent) => void) | null,
  ): Promise<AgentRunResult> {
    this.tools.resetState();

    const state: RunState = {
      input,
      steps: 0,
      lastContent: '',
      fingerprints: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      executed: [],
      revisions: 0,
    };

    if (restored) {
      this.messages.length = 0;
      this.messages.push(...restored.messages);
      for (const name of restored.completedTools ?? []) this.tools.markCompleted(name);
      state.steps = restored.steps;
      state.lastContent = restored.lastContent;
      state.fingerprints.push(...restored.fingerprints);
      Object.assign(state.usage, restored.usage);
      state.executed.push(...restored.executed);
    } else {
      this.messages.push({ role: 'user', content: input });
    }

    await this.persist(state);
    // 上一次可能停在一组工具执行到一半：先把缺结果的调用补上，轨迹才合法
    if (restored) await this.completePendingGroup(state, emit);

    const deadline =
      this.maxDurationMs > 0 ? this.now() + this.maxDurationMs : Number.POSITIVE_INFINITY;

    for (let step = state.steps; step < this.maxSteps; step++) {
      const current = step + 1;
      emit?.({ type: 'step_start', step: current });

      if (this.signal?.aborted) return this.finish(state, 'cancelled');
      if (this.timedOut || this.now() >= deadline) return this.finishTimeout(state);

      let turn: TurnOutcome;
      try {
        turn = emit ? await this.turnStreaming(emit) : await this.turnPlain();
      } catch (error) {
        // 到点掐断的调用按「超时」处理，其余错误照旧上抛
        if (this.timedOut) return this.finishTimeout(state);
        throw error;
      }
      if (this.timedOut) return this.finishTimeout(state);
      addUsage(state.usage, turn.usage);
      state.lastContent = turn.content;

      // id 用确定性推导，模型给的随机 id 一旦跨进程重启就没法用来判定「这一步跑过没有」
      const toolCalls = turn.toolCalls.map((call, index) => ({
        ...call,
        id: deterministicToolCallId(current, index, call.name, call.arguments),
      }));
      this.messages.push({ role: 'assistant', content: turn.content, toolCalls });
      state.steps = current;
      await this.persist(state);

      if (toolCalls.length === 0) {
        const review = await this.reviewAnswer(state, turn.content);
        if (this.timedOut) return this.finishTimeout(state);
        if (!review.revise) {
          const detail = review.issues.length
            ? `交付前核查未通过：${review.issues.length} 个问题`
            : undefined;
          return this.finish(state, 'completed', detail);
        }
        // 不直接改答案：把具体问题回灌给模型，让它自己修正（生成与判断分离）
        this.messages.push({ role: 'user', content: review.feedback });
        await this.persist(state);
        continue;
      }

      state.executed.push(...toolCalls);
      state.fingerprints.push(fingerprint(toolCalls));
      const stuck = isStuck(state.fingerprints, this.noProgressLimit);
      const cycle = detectCycle(state.fingerprints, this.maxCyclePeriod, this.cycleRepeats);

      // 即使判定卡死也把这一轮工具跑完：轨迹里缺 tool 结果会让后续请求结构非法
      for (const call of toolCalls) {
        if (this.signal?.aborted || this.timedOut) break;
        await this.executeCall(call, emit);
        await this.persist(state);
      }

      // 组没跑完就取消：不留半截轨迹在内存里作数，交给 resume() 接着补
      if (this.signal?.aborted) return this.finish(state, 'cancelled');
      if (this.timedOut) return this.finishTimeout(state);
      if (stuck) {
        return this.finish(state, 'no_progress', `连续 ${this.noProgressLimit} 步调用签名完全相同`);
      }
      if (cycle > 0) {
        return this.finish(
          state,
          'loop_detected',
          `调用序列以周期 ${cycle} 重复了 ${this.cycleRepeats} 次`,
        );
      }
    }

    return this.finish(state, 'max_steps');
  }

  /**
   * 交付前核查：来源约束（确定性） + 自我核查（模型判断）。
   * 两层都关时零开销，直接放行。
   */
  private async reviewAnswer(
    state: RunState,
    answer: string,
  ): Promise<{ revise: boolean; issues: string[]; feedback: string }> {
    const issues: string[] = [];
    let degraded = false;
    let degradedReason: string | undefined;

    if (this.sourceConstraint?.enabled) {
      const report = checkCitations(answer, this.messages, {
        requireCitation: this.sourceConstraint.requireCitation,
      });
      issues.push(...report.findings.map((finding) => finding.detail));
    }

    if (this.checker) {
      const verdict = await this.checker.check(
        { question: state.input, answer, messages: this.messages },
        this.runSignal,
      );
      degraded = verdict.degraded;
      degradedReason = verdict.degradedReason;
      // 核查是加固自身的开销，口径要求算进本次运行的 token 总账
      addUsage(state.usage, verdict.usage);
      if (!verdict.ok) issues.push(...verdict.issues);
    }

    if (this.sourceConstraint?.enabled || this.checker) {
      state.verification = {
        rounds: state.revisions,
        passed: issues.length === 0,
        issues,
        degraded,
        ...(degradedReason ? { degradedReason } : {}),
      };
    }

    const maxRounds = this.selfCheck?.maxRounds ?? DEFAULTS.selfCheckRounds;
    const revise = issues.length > 0 && state.revisions < maxRounds;
    if (revise) state.revisions++;

    return {
      revise,
      issues,
      feedback: [
        '【交付前核查 · 请修正】下面这些问题必须先解决，再重新给出最终答案：',
        ...issues.map((issue) => `- ${issue}`),
        '修正后给出完整答案；确实无法修正时，明确说明缺什么信息，不要编造。',
      ].join('\n'),
    };
  }

  /**
   * 补齐「assistant 已声明、但没有对应 tool 结果」的调用。
   * 只补缺的那些：已经有结果的调用（上一次真跑过、有副作用）绝不重跑。
   */
  private async completePendingGroup(
    state: RunState,
    emit: ((event: AgentEvent) => void) | null,
  ): Promise<void> {
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0);
    const calls = lastAssistant?.toolCalls;
    if (!calls || calls.length === 0) return;

    const answered = new Set(
      this.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
    );
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      await this.executeCall(call, emit);
      await this.persist(state);
    }
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
      result = await this.tools.execute(call, this.runSignal);
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
    if (this.runSignal) request.signal = this.runSignal;
    return request;
  }

  /** 写检查点。没有配置存储时是空操作，所以调用点不需要到处判空。 */
  private async persist(state: RunState): Promise<void> {
    if (!this.checkpoint) return;
    const snapshot: AgentCheckpointState = {
      input: state.input,
      messages: [...this.messages],
      steps: state.steps,
      lastContent: state.lastContent,
      fingerprints: [...state.fingerprints],
      usage: { ...state.usage },
      executed: [...state.executed],
      completedTools: this.tools.completedNames(),
    };
    await this.checkpoint.store.save(this.checkpoint.id, snapshot);
  }

  private async loadCheckpoint(): Promise<AgentCheckpointState | null> {
    if (!this.checkpoint) {
      throw new Error('未配置检查点存储：构造 AgentLoop 时传 options.checkpoint 才能续跑');
    }
    const checkpoint = await this.checkpoint.store.load<AgentCheckpointState>(this.checkpoint.id);
    return checkpoint?.state ?? null;
  }

  private finishTimeout(state: RunState): Promise<AgentRunResult> {
    return this.finish(state, 'timeout', `超过墙钟上限 ${this.maxDurationMs}ms`);
  }

  /** 正常跑完就清掉进度点；其余终止原因保留，供人或程序决定要不要续跑。 */
  private async finish(
    state: RunState,
    stopReason: StopReason,
    stopDetail?: string,
  ): Promise<AgentRunResult> {
    if (stopReason === 'completed') {
      await this.clearCheckpoint();
    } else {
      await this.persist(state);
    }
    return {
      content: state.lastContent,
      steps: state.steps,
      stopReason,
      ...(stopDetail ? { stopDetail } : {}),
      ...(state.verification ? { verification: state.verification } : {}),
      messages: [...this.messages],
      toolCalls: [...state.executed],
      usage: { ...state.usage },
    };
  }
}

interface TurnOutcome {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
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

/**
 * 横跳检测：末尾是否出现了「同一段序列连着重复」。
 *
 * 与 `isStuck` 的分工：`isStuck` 管周期 1（每步调用完全一样）；
 * 这里管周期 2..maxPeriod，典型的是 A/B/A/B 在两个工具之间来回绕。
 * 返回检出的周期（0 表示没检出）。
 */
function detectCycle(fingerprints: readonly string[], maxPeriod: number, repeats: number): number {
  if (maxPeriod < 2 || repeats < 2) return 0;

  for (let period = 2; period <= maxPeriod; period++) {
    const size = period * repeats;
    if (fingerprints.length < size) continue;
    const tail = fingerprints.slice(-size);
    let repeated = true;
    for (let index = 0; index + period < size; index++) {
      if (tail[index] !== tail[index + period]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return period;
  }
  return 0;
}
