/**
 * 用户中断演示
 * 运行：pnpm exec tsx src/my_robust/07_user/demo-interrupt.ts
 */

import { InterruptController } from './interrupt-controller.js'
import { runInterruptibleLoop } from './interruptible-loop.js'
import { handleResume } from './resume.js'

async function main() {
  // ── 演示一：执行中途被中断 ──
  console.log('=== 演示一：任务执行中途被用户中断 ===\n')

  const interrupt = new InterruptController()

  // 注册一个清理函数，模拟清理资源
  interrupt.onCleanup(() => {
    console.log('  [清理] 关闭了打开的文件句柄')
  })
  interrupt.onCleanup(() => {
    console.log('  [清理] 取消了进行中的网络请求')
  })

  // 模拟 3 秒后用户中断
  setTimeout(() => {
    console.log('\n  >>> 用户按下了中断键 <<<\n')
    interrupt.interrupt('用户觉得方向不对，叫停')
  }, 3000)

  // 跑一个每步 1 秒的长任务
  const outcome = await runInterruptibleLoop(
    'task-001',
    async (step, signal) => {
      console.log(`  执行第 ${step} 步...`)
      // 模拟耗时 1 秒
      await new Promise((r) => setTimeout(r, 1000))
      return {
        action: `处理数据块 ${step}`,
        result: `第 ${step} 步结果`,
        done: step >= 10, // 要 10 步才完成
      }
    },
    interrupt,
  )

  console.log(`\n  任务状态：${outcome.status}`)
  console.log(`  进度摘要：${outcome.summary}`)
  console.log(`  已完成步数：${outcome.steps}\n`)

  // ── 演示二：中断后用户选择继续 ──
  console.log('=== 演示二：中断后选择"继续" ===\n')
  const resumeResult = handleResume(outcome.checkpoint, { choice: 'continue' })
  console.log(`  ${resumeResult.action}\n`)

  // ── 演示三：中断后用户选择调整 ──
  console.log('=== 演示三：中断后选择"调整方向" ===\n')
  const adjustResult = handleResume(outcome.checkpoint, {
    choice: 'adjust',
    newInstruction: '改成只处理前 5 个数据块',
  })
  console.log(`  ${adjustResult.action}\n`)

  // ── 演示四：中断后用户选择取消 ──
  console.log('=== 演示四：中断后选择"取消" ===\n')
  const cancelResult = handleResume(outcome.checkpoint, { choice: 'cancel' })
  console.log(`  ${cancelResult.action}`)
}

main().catch(console.error)