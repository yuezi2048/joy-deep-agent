// 第3节：工具调用追踪器（去重、计数、卡死检测）
export interface ToolCallRecord {
  toolName: string
  args: any
  result: string
  timestamp: number
  durationMs: number
}
export class ToolTracker {
  private records: ToolCallRecord[] = []
  checkDuplicate(toolName: string, args: any): string | null {
    const argsKey = JSON.stringify(args)
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]
      if (r.toolName === toolName && JSON.stringify(r.args) === argsKey) return r.result
    }
    return null
  }
  record(record: ToolCallRecord): void {
    this.records.push(record)
  }
  countCalls(toolName?: string): number {
    if (!toolName) return this.records.length
    return this.records.filter((r) => r.toolName === toolName).length
  }
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
