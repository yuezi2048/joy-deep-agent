// 第4节：任务级预算（token 和时间）
export interface TaskBudgetConfig {
  maxTokens?: number
  maxDurationMs?: number
}
export class TaskBudget {
  private usedTokens = 0
  private startTime = Date.now()
  private config: Required<TaskBudgetConfig>
  constructor(config: TaskBudgetConfig = {}) {
    this.config = { maxTokens: config.maxTokens ?? 100000, maxDurationMs: config.maxDurationMs ?? 5 * 60 * 1000 }
  }
  check(): string | null {
    if (this.usedTokens >= this.config.maxTokens) return `已达到 token 预算上限（${this.config.maxTokens}），停止任务`
    if (Date.now() - this.startTime >= this.config.maxDurationMs) return `已达到时间预算上限，停止任务`
    return null
  }
  addTokens(tokens: number): void { this.usedTokens += tokens }
  getUsage() { return { tokens: this.usedTokens, elapsedMs: Date.now() - this.startTime } }
}
