// 第7节：中断后的恢复
import { TaskCheckpoint, CheckpointManager } from './checkpoint.js'
export type ResumeChoice = 'continue' | 'adjust' | 'cancel'
export interface ResumeDecision {
  choice: ResumeChoice
  newInstruction?: string
}
export function handleResume(checkpoint: TaskCheckpoint, decision: ResumeDecision): { action: string; manager?: CheckpointManager } {
  switch (decision.choice) {
    case 'continue': {
      const manager = new CheckpointManager(checkpoint.taskId)
      manager.restore(checkpoint)
      return { action: `从第 ${checkpoint.currentStep + 1} 步继续执行`, manager }
    }
    case 'adjust': {
      const manager = new CheckpointManager(checkpoint.taskId)
      manager.restore(checkpoint)
      return { action: `保留已完成的 ${checkpoint.completedSteps.length} 步，后续按新指令"${decision.newInstruction}"调整`, manager }
    }
    case 'cancel':
    default:
      return { action: '任务已彻底取消，进度已丢弃' }
  }
}
