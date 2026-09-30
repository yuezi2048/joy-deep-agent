import { LoopController } from './loop-controller.js'
import { runSafeLoop } from './safe-agent-loop.js'
async function main() {
  console.log('===== 正常任务，第 3 步完成 =====\n')
  const ctrl = new LoopController({ maxSteps: 10 })
  const result = await runSafeLoop(async (step) => {
    console.log(`  执行第 ${step + 1} 步`)
    return { action: `step-${step}`, state: { progress: step }, done: step >= 2, result: '任务成功完成' }
  }, ctrl)
  console.log(`\n  停止原因：${result.stopReason}`)
  console.log(`  执行步数：${result.steps}`)
  console.log(`  是否完成：${result.finished}`)
  console.log(`  结果：${result.finalResult}`)
}
main().catch(console.error)
