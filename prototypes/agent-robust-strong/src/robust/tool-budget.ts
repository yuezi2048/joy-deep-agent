// 第3节：工具调用预算（防滥用）
export interface BudgetConfig {
  maxTotalCalls?: number
  maxPerTool?: number
}
export class ToolBudget {
  private totalCalls = 0
  private perToolCalls: Map<string, number> = new Map()
  private config: Required<BudgetConfig>
  constructor(config: BudgetConfig = {}) {
    this.config = { maxTotalCalls: config.maxTotalCalls ?? 20, maxPerTool: config.maxPerTool ?? 8 }
  }
  checkBudget(toolName: string): string | null {
    if (this.totalCalls >= this.config.maxTotalCalls) {
      return `已达到单任务工具调用上限（${this.config.maxTotalCalls} 次），停止调用。`
    }
    const toolCount = this.perToolCalls.get(toolName) ?? 0
    if (toolCount >= this.config.maxPerTool) {
      return `工具 "${toolName}" 已达到调用上限（${this.config.maxPerTool} 次），停止调用。`
    }
    return null
  }
  consume(toolName: string): void {
    this.totalCalls++
    this.perToolCalls.set(toolName, (this.perToolCalls.get(toolName) ?? 0) + 1)
  }
  getUsage() {
    return { total: this.totalCalls, perTool: Object.fromEntries(this.perToolCalls) }
  }
  reset(): void {
    this.totalCalls = 0
    this.perToolCalls.clear()
  }
}
