/**
 * 带死循环防护的 Agent Loop
 * 演示控制器怎么接进主循环
 */

import { LoopController } from './loop-controller.js'

export interface LoopStep {
  // 这一步做了什么
  action: string
  // 这一步后的状态（用于进展检测）
  state: any
  // 任务是否完成
  done: boolean
  // 结果
  result?: string
}

export interface LoopResult {
  finished: boolean
  steps: number
  stopReason: string
  finalResult: string
}

/**
 * 运行一个带防护的 agent loop
 * @param stepFn 执行一步的函数，返回这一步的结果和状态
 */
export async function runSafeLoop(
  stepFn: (step: number) => Promise<LoopStep>,
  controller: LoopController,
): Promise<LoopResult> {
  let lastResult = ''

  while (true) {
    // 先拿到当前要执行的步骤
    const currentStep = await stepFn(controller.getStep())
    lastResult = currentStep.result ?? lastResult

    // 任务完成，正常退出
    if (currentStep.done) {
      return {
        finished: true,
        steps: controller.getStep(),
        stopReason: LoopController.explainStop('completed'),
        finalResult: lastResult,
      }
    }

    // 检查是否应该被强制停止
    const stopReason = controller.shouldContinue(currentStep.state)
    if (stopReason) {
      return {
        finished: false,
        steps: controller.getStep(),
        stopReason: LoopController.explainStop(stopReason),
        finalResult: lastResult || '（任务未完成，返回当前进度）',
      }
    }
  }
}