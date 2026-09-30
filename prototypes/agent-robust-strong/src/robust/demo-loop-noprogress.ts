import { LoopController } from './loop-controller.js'
import { runSafeLoop } from './safe-agent-loop.js'
async function main() {
  console.log('===== 状态一直不变，触发无进展检测 =====\n')
  const ctrl = new LoopController({ maxSteps: 50, noProgressThreshold: 3 })
  const result = await runSafeLoop(async (step) => {
    console.log(`  执行第 ${step + 1} 步（状态始终是 stuck-value）`)
    return { action: 'stuck', state: { value: 'stuck-value' }, done: false }
  }, ctrl)
  console.log(`\n  停止原因：${result.stopReason}`)
  console.log(`  执行步数：${result.steps}（远没到 50 步上限就停了）`)
}
main().catch(console.error)
