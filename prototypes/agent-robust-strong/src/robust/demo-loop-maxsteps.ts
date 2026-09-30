import { LoopController } from './loop-controller.js'
import { runSafeLoop } from './safe-agent-loop.js'
async function main() {
  console.log('===== 永不完成的任务，靠步数上限兜底 =====\n')
  const ctrl = new LoopController({ maxSteps: 5 })
  const result = await runSafeLoop(async (step) => {
    console.log(`  执行第 ${step + 1} 步`)
    return { action: `step-${step}`, state: { random: Math.random() }, done: false }
  }, ctrl)
  console.log(`\n  停止原因：${result.stopReason}`)
  console.log(`  执行步数：${result.steps}`)
  console.log(`  是否完成：${result.finished}`)
}
main().catch(console.error)
