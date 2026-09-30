/**
 * 工具调用预算
 * 限制单个任务里的工具调用总次数和单工具次数，防止滥用
 */

export interface BudgetConfig {
  // 单任务总调用上限
  maxTotalCalls?: number
  // 单个工具调用上限
  maxPerTool?: number
}

export class ToolBudget {
  private totalCalls = 0
  private perToolCalls: Map<string, number> = new Map()
  private config: Required<BudgetConfig>

  constructor(config: BudgetConfig = {}) {
    this.config = {
      maxTotalCalls: config.maxTotalCalls ?? 20,
      maxPerTool: config.maxPerTool ?? 8,
    }
  }

  /**
   * 检查是否还能调用某工具
   * 返回 null 表示可以，返回字符串表示拒绝原因
   */
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

  /**
   * 消耗一次预算
   */
  consume(toolName: string): void {
    this.totalCalls++
    this.perToolCalls.set(toolName, (this.perToolCalls.get(toolName) ?? 0) + 1)
  }

  getUsage() {
    return {
      total: this.totalCalls,
      perTool: Object.fromEntries(this.perToolCalls),
    }
  }

  reset(): void {
    this.totalCalls = 0
    this.perToolCalls.clear()
  }
}