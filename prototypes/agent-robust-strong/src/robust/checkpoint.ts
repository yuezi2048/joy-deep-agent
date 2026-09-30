// 第7节：进度检查点
export interface TaskCheckpoint {
  taskId: string
  currentStep: number
  completedSteps: Array<{ step: number; action: string; result: string }>
  state: Record<string, any>
  savedAt: number
}
export class CheckpointManager {
  private checkpoint: TaskCheckpoint
  constructor(taskId: string) {
    this.checkpoint = { taskId, currentStep: 0, completedSteps: [], state: {}, savedAt: Date.now() }
  }
  recordStep(step: number, action: string, result: string): void {
    this.checkpoint.currentStep = step
    this.checkpoint.completedSteps.push({ step, action, result })
    this.checkpoint.savedAt = Date.now()
  }
  setState(key: string, value: any): void {
    this.checkpoint.state[key] = value
    this.checkpoint.savedAt = Date.now()
  }
  getCheckpoint(): TaskCheckpoint { return { ...this.checkpoint } }
  getSummary(): string {
    const { currentStep, completedSteps } = this.checkpoint
    if (completedSteps.length === 0) return '任务刚开始，还没有完成的步骤'
    const done = completedSteps.map((s) => `第${s.step}步：${s.action}`).join('；')
    return `已完成 ${completedSteps.length} 步（${done}），中断在第 ${currentStep} 步`
  }
  restore(checkpoint: TaskCheckpoint): void { this.checkpoint = { ...checkpoint } }
}
