import type { AgentEvent, AgentRunResult } from '../core/agent-loop.js';
import type { FailoverEvent } from '../providers/failover-model.js';
import type { RetryOptions } from '../robust/retry.js';
import {
  FAULT_CATEGORIES,
  type EvalVariant,
  type FaultCategory,
  type FaultObservation,
  type RunObservation,
} from './metrics.js';

/**
 * 把一次真实运行里的故障与恢复记下来，攒成 `RunObservation`。
 *
 * 采集点都是现成的，不需要给主循环打洞：
 * - 注入时刻：场景自己调 `injectFault()`（它才知道注入了什么）
 * - 供应商故障：接 `FailoverChatModel` 的 `onEvent`
 * - 失败调用：接重试中间件的 `onRetry`，以及 `AgentEvent.tool_result` 的错误结果
 * - token：`AgentRunResult.usage`
 */

export interface RunRecorderOptions {
  scenario: string;
  variant: EvalVariant;
  /** 时间源，测试可注入假时钟 */
  now?: () => number;
  /** 判定这次运行算不算完成；缺省只看 `stopReason === 'completed'` */
  judge?: (result: AgentRunResult) => boolean;
}

export class RunRecorder {
  private readonly scenario: string;
  private readonly variant: EvalVariant;
  private readonly now: () => number;
  private readonly judge: (result: AgentRunResult) => boolean;
  /** 还没恢复的故障，按注入顺序 */
  private readonly open: FaultObservation[] = [];
  /** 已经结束（恢复或放弃）的故障 */
  private readonly closed: FaultObservation[] = [];
  /** 每类故障累计的重试次数，恢复时换算成「尝试次数」 */
  private readonly retries = new Map<string, number>();

  constructor(options: RunRecorderOptions) {
    this.scenario = options.scenario;
    this.variant = options.variant;
    this.now = options.now ?? Date.now;
    this.judge = options.judge ?? ((result) => result.stopReason === 'completed');
  }

  /** 场景注入故障时调用。同一类故障已经在开放中就不重复记。 */
  injectFault(category: FaultCategory | string, at?: number): void {
    if (this.open.some((fault) => fault.category === category)) return;
    this.open.push({ category, injectedAt: at ?? this.now(), absorbed: false });
  }

  /**
   * 标记某一类故障已经恢复。
   * `attempts` 缺省用累计的重试次数 + 1（含最后成功的那次）。
   */
  recoverFault(category: FaultCategory | string, at?: number, attempts?: number): boolean {
    const index = this.open.findIndex((fault) => fault.category === category);
    if (index === -1) return false;

    const fault = this.open[index] as FaultObservation;
    this.open.splice(index, 1);
    const spent = attempts ?? (this.retries.get(category) ?? 0) + 1;
    this.retries.set(category, 0);
    this.closed.push({ ...fault, recoveredAt: at ?? this.now(), attempts: spent, absorbed: true });
    return true;
  }

  /** `FailoverChatModel` 的事件适配器：直接传给 `onEvent`。 */
  readonly onFailoverEvent = (event: FailoverEvent): void => {
    if (event.type === 'failed') this.injectFault(FAULT_CATEGORIES.providerFailure);
    if (event.type === 'succeeded') {
      this.recoverFault(FAULT_CATEGORIES.providerFailure, undefined, event.attempts);
    }
  };

  /** 重试中间件的事件适配器：直接传给 `RetryOptions.onRetry`。 */
  readonly onRetry: NonNullable<RetryOptions['onRetry']> = (): void => {
    const category = FAULT_CATEGORIES.failedCall;
    this.injectFault(category);
    this.retries.set(category, (this.retries.get(category) ?? 0) + 1);
  };

  /** AgentEvent 适配器：工具结果的成功 / 失败也能反映「失败调用」的恢复。 */
  readonly onAgentEvent = (event: AgentEvent): void => {
    if (event.type !== 'tool_result') return;
    const category = FAULT_CATEGORIES.failedCall;
    if (event.result.isError) {
      this.injectFault(category);
      return;
    }
    this.recoverFault(category);
  };

  /** 中途快照（不结束本次运行），便于边跑边看。 */
  snapshot(stopReason?: AgentRunResult['stopReason']): RunObservation {
    return {
      scenario: this.scenario,
      variant: this.variant,
      passed: false,
      ...(stopReason ? { stopReason } : {}),
      faults: this.allFaults(false),
    };
  }

  /** 运行抛异常退出：没有交付物，四个指标里凡是「测不出来」的一律留空。 */
  finishErrored(message: string): RunObservation {
    return {
      scenario: this.scenario,
      variant: this.variant,
      passed: false,
      errored: message,
      faults: this.allFaults(false),
    };
  }

  finish(result: AgentRunResult): RunObservation {
    const passed = this.judge(result);
    return {
      scenario: this.scenario,
      variant: this.variant,
      passed,
      stopReason: result.stopReason,
      usage: result.usage,
      faults: this.allFaults(passed),
    };
  }

  /**
   * 没有被显式标记恢复的故障，按「任务最终有没有达成」判定是否被吸收。
   *
   * 为什么不只看 `stopReason === 'completed'`：循环「正常结束」不等于任务成功。
   * 模型完全可以带着失败的观测给一句「我拿不到数据」然后正常收尾——故障并没有被吸收，
   * 它正是任务失败的原因。所以这里用场景断言（`passed`）做判据（口径见 docs/eval/metrics.md）。
   */
  private allFaults(taskSucceeded: boolean): FaultObservation[] {
    const stillOpen = this.open.map((fault) => ({ ...fault, absorbed: taskSucceeded }));
    return [...this.closed, ...stillOpen];
  }
}
