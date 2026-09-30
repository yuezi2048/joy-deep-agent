/**
 * 工具调用追踪器
 * 记录调用历史，检测重复调用，统计调用次数
 */

export interface ToolCallRecord {
  toolName: string
  args: any
  result: string
  timestamp: number
  durationMs: number
}

export class ToolTracker {
  private records: ToolCallRecord[] = []

  /**
   * 检查是否是重复调用（同工具同参数）
   * 返回上次的结果，如果重复的话
   */
  checkDuplicate(toolName: string, args: any): string | null {
    const argsKey = JSON.stringify(args)
    // 从最近的记录往前找
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]
      if (r.toolName === toolName && JSON.stringify(r.args) === argsKey) {
        return r.result
      }
    }
    return null
  }

  /**
   * 记录一次调用
   */
  record(record: ToolCallRecord): void {
    this.records.push(record)
  }

  /**
   * 统计某个工具被调用了几次
   */
  countCalls(toolName?: string): number {
    if (!toolName) return this.records.length
    return this.records.filter((r) => r.toolName === toolName).length
  }

  /**
   * 检测"反复调同一个工具但没进展"的模式
   * 如果最近 n 次都是调同一个工具，可能陷入了无效循环
   */
  isStuckOnTool(toolName: string, threshold = 3): boolean {
    if (this.records.length < threshold) return false
    const recent = this.records.slice(-threshold)
    return recent.every((r) => r.toolName === toolName)
  }

  getRecords(): ToolCallRecord[] {
    return this.records
  }

  reset(): void {
    this.records = []
  }
}