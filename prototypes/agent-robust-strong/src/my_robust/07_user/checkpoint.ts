/**
 * 进度检查点
 * 保存任务执行进度，支持中断后恢复
 */

export interface TaskCheckpoint {
  taskId: string
  // 当前到第几步
  currentStep: number
  // 已完成的步骤记录
  completedSteps: Array<{ step: number; action: string; result: string }>
  // 中间状态（任务相关的数据）
  state: Record<string, any>
  // 保存时间
  savedAt: number
}

export class CheckpointManager {
  private checkpoint: TaskCheckpoint

  constructor(taskId: string) {
    this.checkpoint = {
      taskId,
      currentStep: 0,
      completedSteps: [],
      state: {},
      savedAt: Date.now(),
    }
  }

  /**
   * 记录完成一步
   */
  recordStep(step: number, action: string, result: string): void {
    this.checkpoint.currentStep = step
    this.checkpoint.completedSteps.push({ step, action, result })
    this.checkpoint.savedAt = Date.now()
  }

  /**
   * 更新中间状态
   */
  setState(key: string, value: any): void {
    this.checkpoint.state[key] = value
    this.checkpoint.savedAt = Date.now()
  }

  /**
   * 获取当前检查点（中断时拿来保存或展示）
   */
  getCheckpoint(): TaskCheckpoint {
    return { ...this.checkpoint }
  }

  /**
   * 生成给用户看的进度摘要
   */
  getSummary(): string {
    const { currentStep, completedSteps } = this.checkpoint
    if (completedSteps.length === 0) {
      return '任务刚开始，还没有完成的步骤'
    }
    const done = completedSteps.map((s) => `第${s.step}步：${s.action}`).join('；')
    return `已完成 ${completedSteps.length} 步（${done}），中断在第 ${currentStep} 步`
  }

  /**
   * 从已有检查点恢复（继续任务用）
   */
  restore(checkpoint: TaskCheckpoint): void {
    this.checkpoint = { ...checkpoint }
  }
}