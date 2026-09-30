/**
 * 可中断的 agent loop
 * 在每个检查点检查中断信号，中断时优雅保存并清理
 */

import { InterruptController, InterruptedError } from './interrupt-controller.js'
import { CheckpointManager } from './checkpoint.js'

export interface InterruptibleStep {
  action: string
  result: string
  done: boolean
  state?: Record<string, any>
}

export interface LoopOutcome {
  status: 'completed' | 'interrupted'
  steps: number
  summary: string
  checkpoint: any
}

/**
 * 运行可中断的 loop
 */
export async function runInterruptibleLoop(
  taskId: string,
  stepFn: (step: number, signal: AbortSignal) => Promise<InterruptibleStep>,
  interrupt: InterruptController,
  maxSteps = 20,
): Promise<LoopOutcome> {
  const checkpoint = new CheckpointManager(taskId)

  try {
    for (let step = 1; step <= maxSteps; step++) {
      // 检查点1：每一步开始前检查是否被中断
      interrupt.throwIfInterrupted()

      // 执行这一步，把 signal 传进去（支持步骤内部的中断）
      const result = await stepFn(step, interrupt.signal)

      // 检查点2：步骤执行完，记录进度前再检查一次
      interrupt.throwIfInterrupted()

      // 记录这一步（这是个"干净的检查点"，进度已保存）
      checkpoint.recordStep(step, result.action, result.result)
      if (result.state) {
        for (const [k, v] of Object.entries(result.state)) {
          checkpoint.setState(k, v)
        }
      }

      // 任务完成
      if (result.done) {
        return {
          status: 'completed',
          steps: step,
          summary: '任务正常完成',
          checkpoint: checkpoint.getCheckpoint(),
        }
      }
    }

    // 步数用完
    return {
      status: 'completed',
      steps: maxSteps,
      summary: '达到最大步数',
      checkpoint: checkpoint.getCheckpoint(),
    }
  } catch (error) {
    // 捕获中断异常，优雅处理
    if (error instanceof InterruptedError) {
      console.log(`[Loop] ${error.message}`)
      // 执行资源清理
      await interrupt.cleanup()
      // 返回中断结果，带上已保存的进度
      return {
        status: 'interrupted',
        steps: checkpoint.getCheckpoint().currentStep,
        summary: checkpoint.getSummary(),
        checkpoint: checkpoint.getCheckpoint(),
      }
    }
    // 其他错误往上抛
    throw error
  }
}