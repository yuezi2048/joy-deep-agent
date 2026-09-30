/**
 * 工具依赖约束
 * 用前置条件控制工具调用顺序
 */

import { ToolTracker } from './tool-tracker.js'

export interface ToolDependency {
  toolName: string
  // 调用这个工具前，必须先成功调用过这些工具
  requires?: string[]
}

export class DependencyChecker {
  private deps: Map<string, string[]> = new Map()

  constructor(dependencies: ToolDependency[]) {
    for (const d of dependencies) {
      this.deps.set(d.toolName, d.requires ?? [])
    }
  }

  /**
   * 检查调用某工具前，前置工具是否都调用过
   * @param toolName 想调用的工具
   * @param tracker 调用历史
   */
  checkDependency(toolName: string, tracker: ToolTracker): string | null {
    const required = this.deps.get(toolName)
    if (!required || required.length === 0) return null

    const calledTools = new Set(
      tracker.getRecords().map((r) => r.toolName),
    )

    const missing = required.filter((req) => !calledTools.has(req))
    if (missing.length > 0) {
      return `调用 "${toolName}" 前，需要先调用：${missing.join(', ')}。请先完成前置步骤。`
    }
    return null
  }
}