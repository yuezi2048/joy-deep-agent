/**
 * 死循环防护演示
 * 运行：pnpm exec tsx src/my_robust/04_deadloop/demo-deadloop.ts
 */

import { LoopController } from './loop-controller.js'
import { runSafeLoop } from './safe-agent-loop.js'

async function main() {
  // ── 演示一：正常完成的任务 ──
  console.log('=== 演示一：正常完成 ===\n')
  const ctrl1 = new LoopController({ maxSteps: 10 })
  const r1 = await runSafeLoop(async (step) => {
    console.log(`  执行第 ${step + 1} 步`)
    // 第 3 步完成
    return {
      action: `step-${step}`,
      state: { progress: step },
      done: step >= 2,
      result: '任务结果',
    }
  }, ctrl1)
  console.log(`  结果：${r1.stopReason}，用了 ${r1.steps} 步\n`)

  // ── 演示二：达到步数上限 ──
  console.log('=== 演示二：步数上限强制停止 ===\n')
  const ctrl2 = new LoopController({ maxSteps: 5 })
  const r2 = await runSafeLoop(async (step) => {
    console.log(`  执行第 ${step + 1} 步`)
    // 永远不完成，但状态一直变（避免触发无进展），专门测步数上限
    return {
      action: `step-${step}`,
      state: { progress: Math.random() },
      done: false,
    }
  }, ctrl2)
  console.log(`  结果：${r2.stopReason}，用了 ${r2.steps} 步\n`)

  // ── 演示三：无进展检测 ──
  console.log('=== 演示三：无进展检测 ===\n')
  const ctrl3 = new LoopController({ maxSteps: 20, noProgressThreshold: 3 })
  const r3 = await runSafeLoop(async (step) => {
    console.log(`  执行第 ${step + 1} 步（状态一直不变）`)
    // 状态永远一样，触发无进展
    return {
      action: 'stuck',
      state: { value: 'always-same' },
      done: false,
    }
  }, ctrl3)
  console.log(`  结果：${r3.stopReason}，用了 ${r3.steps} 步\n`)

  // ── 演示四：横跳循环检测 ──
  console.log('=== 演示四：A-B-A-B 横跳检测 ===\n')
  const ctrl4 = new LoopController({ maxSteps: 20 })
  let toggle = false
  const r4 = await runSafeLoop(async (step) => {
    toggle = !toggle
    const state = toggle ? { mode: 'A' } : { mode: 'B' }
    console.log(`  执行第 ${step + 1} 步，状态：${state.mode}`)
    return { action: state.mode, state, done: false }
  }, ctrl4)
  console.log(`  结果：${r4.stopReason}，用了 ${r4.steps} 步`)
}

main().catch(console.error)