import { withTimeout } from './timeout.js'
import { TimeoutError } from './errors.js'
function slowOperation(ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve('操作完成'), ms))
}
async function main() {
  console.log('===== 场景1：操作很快，没超时 =====\n')
  try {
    const result = await withTimeout(slowOperation(500), 2000, '快速操作')
    console.log(`  结果：${result}（在超时前完成）\n`)
  } catch (err: any) { console.log(`  出错：${err.message}\n`) }

  console.log('===== 场景2：操作太慢，触发超时 =====\n')
  try {
    console.log('  开始执行一个 3 秒的操作，但超时设了 1 秒...')
    const result = await withTimeout(slowOperation(3000), 1000, '慢速操作')
    console.log(`  结果：${result}\n`)
  } catch (err: any) {
    if (err instanceof TimeoutError) {
      console.log(`  ✓ 成功触发超时保护：${err.message}`)
      console.log(`  （操作本来要 3 秒，但 1 秒就被中断了）\n`)
    } else console.log(`  其他错误：${err.message}\n`)
  }
}
main().catch(console.error)
