import { CancelledError, errorMessage } from '../core/errors.js';
import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from '../robust/circuit-breaker.js';
import type { ChatModel, ChatRequest, ChatResponse, StreamChunk } from './chat-model.js';

/** 参与故障转移的一个供应商。`key` 与 ProviderConfig.key 一致，便于日志与状态查询。 */
export interface ProviderMember {
  key: string;
  model: ChatModel;
  /** 展示名，默认取 model.name */
  label?: string;
}

/** 一次转移过程里，某个供应商的最终去向。 */
export interface FailoverAttempt {
  provider: string;
  outcome: 'failed' | 'circuit-open';
  reason: string;
}

export type FailoverEvent =
  | { type: 'attempt'; provider: string; attempt: number }
  | { type: 'failed'; provider: string; reason: string }
  | { type: 'skipped'; provider: string; reason: string }
  | { type: 'switched'; from: string; to: string; reason: string }
  /** `attempts` 是本次调用真正发出去的请求次数，用于观察「换了几家才成」 */
  | { type: 'succeeded'; provider: string; attempts: number }
  | { type: 'exhausted'; attempts: readonly FailoverAttempt[] };

/** 所有供应商都不可用。带可读的逐条原因，便于直接回给用户或写进日志。 */
export class AllProvidersFailedError extends Error {
  constructor(
    public readonly attempts: readonly FailoverAttempt[],
    labels: ReadonlyMap<string, string> = new Map(),
  ) {
    const lines = attempts.map(
      (attempt) =>
        `- ${labels.get(attempt.provider) ?? attempt.provider}：${attempt.reason}`,
    );
    super(
      `所有模型供应商都不可用（共 ${attempts.length} 个）：\n${lines.join('\n')}\n` +
        '请检查 API Key / 网络 / 配额，或稍后再试。',
    );
    this.name = 'AllProvidersFailedError';
  }
}

/** 流式输出已经开始，半路失败不能换供应商重来（用户会看到两遍）。 */
export class StreamInterruptedError extends Error {
  constructor(
    public readonly provider: string,
    public readonly reason: string,
  ) {
    super(`供应商 ${provider} 在流式输出中途失败，已产出的内容无法回滚：${reason}`);
    this.name = 'StreamInterruptedError';
  }
}

/**
 * 事件的一句话文案，给日志用；没有可说的时候返回 null。
 * 正常一次成功（attempts === 1）不产生噪音。
 */
export function formatFailoverEvent(event: FailoverEvent): string | null {
  switch (event.type) {
    case 'failed':
      return `供应商 ${event.provider} 调用失败：${event.reason}`;
    case 'skipped':
      return `供应商 ${event.provider} 熔断中，本次跳过`;
    case 'switched':
      return `${event.from} 不可用，切换到 ${event.to}（原因：${event.reason}）`;
    case 'succeeded':
      return event.attempts > 1 ? `第 ${event.attempts} 次尝试成功（${event.provider}）` : null;
    case 'exhausted':
      return `所有模型供应商都不可用（共 ${event.attempts.length} 个）`;
    case 'attempt':
      return null;
  }
}

export interface FailoverChatModelOptions {
  /** 每个供应商一个独立熔断器，参数一致 */
  circuit?: CircuitBreakerOptions;
  /** 转移过程上报：日志、SSE 提示、评测统计都从这里取 */
  onEvent?: (event: FailoverEvent) => void;
}

interface Member {
  key: string;
  label: string;
  model: ChatModel;
  breaker: CircuitBreaker;
}

export interface ProviderState {
  key: string;
  label: string;
  state: CircuitState;
  failureCount: number;
  /** 只读判断，查询不会触发 half-open 探路 */
  available: boolean;
}

/**
 * 供应商故障转移：主供应商失败（或被熔断短路）后，按优先级自动落到下一个可用供应商。
 *
 * 对 `AgentLoop` 完全透明——它拿到的仍然是一个 `ChatModel`，看到的仍然只是「一次模型调用」。
 * 每个供应商各自一个熔断器，连续失败到阈值就短路，冷却后再放一个探路请求。
 *
 * 唯一的例外是流式：如果**已经吐出增量**才失败，就不换供应商，直接抛 `StreamInterruptedError`。
 * 换一家重来会把前半段输出重放一遍，宁可失败也不能给用户双份内容。
 * 用户主动中断（AbortSignal / CancelledError）同样不转移，不再消耗其他供应商。
 */
export class FailoverChatModel implements ChatModel {
  readonly name: string;
  readonly model: string;
  readonly supportsTools: boolean;

  private readonly members: Member[];
  private readonly onEvent?: (event: FailoverEvent) => void;

  constructor(members: readonly ProviderMember[], options: FailoverChatModelOptions = {}) {
    if (members.length === 0) throw new Error('故障转移至少需要一个供应商');
    this.members = members.map((member) => ({
      key: member.key,
      label: member.label ?? member.model.name,
      model: member.model,
      breaker: new CircuitBreaker(options.circuit),
    }));
    this.onEvent = options.onEvent;
    this.name = `failover(${this.members.map((member) => member.label).join(' → ')})`;
    this.model = this.members[0]!.model.model;
    this.supportsTools = this.members.every((member) => member.model.supportsTools);
  }

  /** 运行时查询：每个供应商当前的熔断状态。 */
  states(): ProviderState[] {
    return this.members.map((member) => {
      const snapshot = member.breaker.snapshot();
      return {
        key: member.key,
        label: member.label,
        state: snapshot.state,
        failureCount: snapshot.failureCount,
        available: member.breaker.isAvailable(),
      };
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.attemptAll((member) => member.model.chat(request), request.signal);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const attempts: FailoverAttempt[] = [];
    let attempted = 0;

    for (let index = 0; index < this.members.length; index++) {
      const member = this.members[index]!;
      if (!this.admit(member, attempts)) continue;

      attempted++;
      this.emit({ type: 'attempt', provider: member.key, attempt: attempted });

      let emitted = false;
      try {
        for await (const chunk of member.model.chatStream(request)) {
          emitted = true;
          yield chunk;
        }
        member.breaker.recordSuccess();
        this.emit({ type: 'succeeded', provider: member.key, attempts: attempted });
        return;
      } catch (error) {
        member.breaker.recordFailure();
        const reason = errorMessage(error);
        attempts.push({ provider: member.key, outcome: 'failed', reason });
        this.emit({ type: 'failed', provider: member.key, reason });

        if (emitted) throw new StreamInterruptedError(member.label, reason);
        if (isCancelled(error, request.signal)) throw error;
        this.announceSwitch(index, reason);
      }
    }

    this.emit({ type: 'exhausted', attempts });
    throw new AllProvidersFailedError(attempts, this.labels());
  }

  private async attemptAll<T>(
    invoke: (member: Member) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const attempts: FailoverAttempt[] = [];
    let attempted = 0;

    for (let index = 0; index < this.members.length; index++) {
      const member = this.members[index]!;
      if (!this.admit(member, attempts)) continue;

      attempted++;
      this.emit({ type: 'attempt', provider: member.key, attempt: attempted });

      try {
        const value = await invoke(member);
        member.breaker.recordSuccess();
        this.emit({ type: 'succeeded', provider: member.key, attempts: attempted });
        return value;
      } catch (error) {
        member.breaker.recordFailure();
        const reason = errorMessage(error);
        attempts.push({ provider: member.key, outcome: 'failed', reason });
        this.emit({ type: 'failed', provider: member.key, reason });

        if (isCancelled(error, signal)) throw error;
        this.announceSwitch(index, reason);
      }
    }

    this.emit({ type: 'exhausted', attempts });
    throw new AllProvidersFailedError(attempts, this.labels());
  }

  private admit(member: Member, attempts: FailoverAttempt[]): boolean {
    if (member.breaker.canRequest()) return true;
    const reason = `熔断中（连续失败 ${member.breaker.snapshot().failureCount} 次），本次不再尝试`;
    attempts.push({ provider: member.key, outcome: 'circuit-open', reason });
    this.emit({ type: 'skipped', provider: member.key, reason });
    return false;
  }

  private announceSwitch(fromIndex: number, reason: string): void {
    const next = this.members[fromIndex + 1];
    if (!next) return;
    this.emit({
      type: 'switched',
      from: this.members[fromIndex]!.key,
      to: next.key,
      reason,
    });
  }

  private labels(): Map<string, string> {
    return new Map(this.members.map((member) => [member.key, member.label]));
  }

  private emit(event: FailoverEvent): void {
    this.onEvent?.(event);
  }
}

/** 用户主动中断不算供应商故障：不再往下换，也不该再烧别的供应商的额度。 */
function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof CancelledError) return true;
  return (error as { name?: string })?.name === 'AbortError';
}
