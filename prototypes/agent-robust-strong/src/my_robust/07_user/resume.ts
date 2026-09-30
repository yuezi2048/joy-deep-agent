/**
 * 中断后的恢复
 * 基于保存的检查点，决定怎么继续
 */

import { TaskCheckpoint, CheckpointManager } from './checkpoint.js'

export type ResumeChoice = 'continue' | 'adjust' | 'cancel'

export interface ResumeDecision {
  choice: ResumeChoice
  // adjust 时的新指令
  newInstruction?: string
}

/**
 * 根据用户选择，决定怎么处理中断的任务
 */
export function handleResume(
  checkpoint: TaskCheckpoint,
  decision: ResumeDecision,
): { action: string; manager?: CheckpointManager } {
  switch (decision.choice) {
    case 'continue': {
      // 从检查点继续：恢复进度，从中断的下一步接着做
      const manager = new CheckpointManager(checkpoint.taskId)
      manager.restore(checkpoint)
      return {
        action: `从第 ${checkpoint.currentStep + 1} 步继续执行`,
        manager,
      }
    }

    case 'adjust': {
      // 调整方向：保留已完成的，但后续按新指令做
      const manager = new CheckpointManager(checkpoint.taskId)
      manager.restore(checkpoint)
      return {
        action: `保留已完成的 ${checkpoint.completedSteps.length} 步，后续按新指令"${decision.newInstruction}"调整`,
        manager,
      }
    }

    case 'cancel':
    default:
      // 彻底取消：丢弃进度
      return {
        action: '任务已彻底取消，进度已丢弃',
      }
  }
}