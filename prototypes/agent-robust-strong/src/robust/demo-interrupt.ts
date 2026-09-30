import { InterruptController } from './interrupt-controller.js'
import { runInterruptibleLoop } from './interruptible-loop.js'
import { handleResume } from './resume.js'
async function main() {
  console.log('=== 演示一：任务执行中途被用户中断 ===\n')
  const interrupt = new InterruptController()
  interrupt.onCleanup(() => console.log('  [清理] 关闭了打开的文件句柄'))
  interrupt.onCleanup(() => console.log('  [清理] 取消了进行中的网络请求'))
  setTimeout(() => {
    console.log('\n  >>> 用户按下了中断键 <<<\n')
    interrupt.interrupt('用户觉得方向不对，叫停')
  }, 3000)
  const outcome = await runInterruptibleLoop('task-001', async (step) => {
    console.log(`  执行第 ${step} 步...`)
    await new Promise((r) => setTimeout(r, 1000))
    return { action: `处理数据块 ${step}`, result: `第 ${step} 步结果`, done: step >= 10 }
  }, interrupt)
  console.log(`\n  任务状态：${outcome.status}`)
  console.log(`  进度摘要：${outcome.summary}`)
  console.log(`  已完成步数：${outcome.steps}\n`)

  console.log('=== 演示二：中断后选择"继续" ===\n')
  console.log(`  ${handleResume(outcome.checkpoint, { choice: 'continue' }).action}\n`)
  console.log('=== 演示三：中断后选择"调整方向" ===\n')
  console.log(`  ${handleResume(outcome.checkpoint, { choice: 'adjust', newInstruction: '改成只处理前 5 个数据块' }).action}\n`)
  console.log('=== 演示四：中断后选择"取消" ===\n')
  console.log(`  ${handleResume(outcome.checkpoint, { choice: 'cancel' }).action}`)
}
main().catch(console.error)
