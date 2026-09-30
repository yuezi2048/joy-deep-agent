import { LoopController } from './loop-controller.js'
import { runSafeLoop } from './safe-agent-loop.js'
async function main() {
  console.log('===== A-B-A-B 横跳，触发循环检测 =====\n')
  const ctrl = new LoopController({ maxSteps: 50 })
  let toggle = false
  const result = await runSafeLoop(async (step) => {
    toggle = !toggle
    const mode = toggle ? 'A' : 'B'
    console.log(`  执行第 ${step + 1} 步，状态：${mode}`)
    return { action: mode, state: { mode }, done: false }
  }, ctrl)
  console.log(`\n  停止原因：${result.stopReason}`)
  console.log(`  执行步数：${result.steps}`)
}
main().catch(console.error)
