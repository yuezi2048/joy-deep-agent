// 第3节：带误用防护的工具执行器
import { ToolTracker } from './tool-tracker.js'
import { ToolBudget } from './tool-budget.js'
import { DependencyChecker } from './tool-dependency.js'
export interface GuardedExecutorConfig {
  budget?: ToolBudget
  dependencyChecker?: DependencyChecker
}
export class GuardedExecutor {
  private tracker = new ToolTracker()
  private budget: ToolBudget
  private depChecker?: DependencyChecker
  constructor(config: GuardedExecutorConfig = {}) {
    this.budget = config.budget ?? new ToolBudget()
    this.depChecker = config.dependencyChecker
  }
  async execute(
    toolName: string, args: any,
    realExecutor: (name: string, args: any) => Promise<string>,
  ): Promise<string> {
    const budgetError = this.budget.checkBudget(toolName)
    if (budgetError) { console.warn(`[误用防护] ${budgetError}`); return budgetError }
    if (this.depChecker) {
      const depError = this.depChecker.checkDependency(toolName, this.tracker)
      if (depError) { console.warn(`[误用防护] ${depError}`); return depError }
    }
    if (this.tracker.isStuckOnTool(toolName)) {
      const msg = `检测到反复调用 "${toolName}"，可能陷入无效循环。请换个思路或停止。`
      console.warn(`[误用防护] ${msg}`); return msg
    }
    const duplicate = this.tracker.checkDuplicate(toolName, args)
    if (duplicate !== null) {
      console.warn(`[误用防护] "${toolName}" 用相同参数已调用过，直接返回上次结果`)
      return `（这是之前相同调用的缓存结果）${duplicate}`
    }
    const start = Date.now()
    const result = await realExecutor(toolName, args)
    const durationMs = Date.now() - start
    this.budget.consume(toolName)
    this.tracker.record({ toolName, args, result, timestamp: Date.now(), durationMs })
    return result
  }
  getStats() {
    return { budget: this.budget.getUsage(), callCount: this.tracker.countCalls(), records: this.tracker.getRecords() }
  }
  reset() {
    this.tracker.reset()
    this.budget.reset()
  }
}
