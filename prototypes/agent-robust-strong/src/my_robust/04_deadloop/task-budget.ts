/**
 * 任务级预算
 * 控制整个任务的 token 消耗和时间
 */

export interface TaskBudgetConfig {
  maxTokens?: number;
  maxDurationMs?: number;
}

export class TaskBudget {
  private usedTokens = 0;
  private startTime = Date.now();
  private config: Required<TaskBudgetConfig>;

  constructor(config: TaskBudgetConfig = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 100000,
      maxDurationMs: config.maxDurationMs ?? 5 * 60 * 1000,
    };
  }

  /**
   * 检查预算，返回 null 可继续，返回字符串是停止原因
   */
  check(): string | null {
    if (this.usedTokens >= this.config.maxTokens) {
      return `已达到 token 预算上限（${this.config.maxTokens}），停止任务`;
    }
    if (Date.now() - this.startTime >= this.config.maxDurationMs) {
      return `已达到时间预算上限，停止任务`;
    }
    return null;
  }

  /**
   * 累加消耗的 token（从 API 返回的 usage 里拿）
   */
  addTokens(tokens: number): void {
    this.usedTokens += tokens;
  }

  getUsage() {
    return {
      tokens: this.usedTokens,
      elapsedMs: Date.now() - this.startTime,
    };
  }
}
