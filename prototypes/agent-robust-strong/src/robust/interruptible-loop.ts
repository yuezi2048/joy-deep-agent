// 第7节：可中断的 agent loop
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
export async function runInterruptibleLoop(
  taskId: string,
  stepFn: (step: number, signal: AbortSignal) => Promise<InterruptibleStep>,
  interrupt: InterruptController,
  maxSteps = 20,
): Promise<LoopOutcome> {
  const checkpoint = new CheckpointManager(taskId)
  try {
    for (let step = 1; step <= maxSteps; step++) {
      interrupt.throwIfInterrupted()
      const result = await stepFn(step, interrupt.signal)
      interrupt.throwIfInterrupted()
      checkpoint.recordStep(step, result.action, result.result)
      if (result.state) {
        for (const [k, v] of Object.entries(result.state)) checkpoint.setState(k, v)
      }
      if (result.done) {
        return { status: 'completed', steps: step, summary: '任务正常完成', checkpoint: checkpoint.getCheckpoint() }
      }
    }
    return { status: 'completed', steps: maxSteps, summary: '达到最大步数', checkpoint: checkpoint.getCheckpoint() }
  } catch (error) {
    if (error instanceof InterruptedError) {
      console.log(`[Loop] ${error.message}`)
      await interrupt.cleanup()
      return { status: 'interrupted', steps: checkpoint.getCheckpoint().currentStep, summary: checkpoint.getSummary(), checkpoint: checkpoint.getCheckpoint() }
    }
    throw error
  }
}
