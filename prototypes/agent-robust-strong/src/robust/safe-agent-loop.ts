// 第4节：带死循环防护的 Agent Loop
import { LoopController } from './loop-controller.js'
export interface LoopStep {
  action: string
  state: any
  done: boolean
  result?: string
}
export interface LoopResult {
  finished: boolean
  steps: number
  stopReason: string
  finalResult: string
}
export async function runSafeLoop(
  stepFn: (step: number) => Promise<LoopStep>,
  controller: LoopController,
): Promise<LoopResult> {
  let lastResult = ''
  while (true) {
    const currentStep = await stepFn(controller.getStep())
    lastResult = currentStep.result ?? lastResult
    if (currentStep.done) {
      return { finished: true, steps: controller.getStep(), stopReason: LoopController.explainStop('completed'), finalResult: lastResult }
    }
    const stopReason = controller.shouldContinue(currentStep.state)
    if (stopReason) {
      return { finished: false, steps: controller.getStep(), stopReason: LoopController.explainStop(stopReason), finalResult: lastResult || '（任务未完成，返回当前进度）' }
    }
  }
}
