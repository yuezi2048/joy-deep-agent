import { withRetry } from './retry.js'
import { RetryableError, NonRetryableError } from './errors.js'

async function main() {
  console.log('===== 场景1：前两次失败，第三次成功 =====\n')
  let count1 = 0
  const result = await withRetry(
    async () => {
      count1++
      console.log(`  [尝试 ${count1}] 正在执行...`)
      if (count1 < 3) throw new RetryableError(`第 ${count1} 次模拟失败`, 503)
      return '成功拿到结果'
    },
    { maxRetries: 3, initialDelay: 500, onRetry: (err, attempt, delay) => console.log(`  [重试 ${attempt}] 等待 ${delay}ms 后重试，原因：${err.message}`) },
  )
  console.log(`\n  最终结果：${result}`)
  console.log(`  总共调用了 ${count1} 次\n`)

  console.log('===== 场景2：一直失败，重试耗尽 =====\n')
  let count2 = 0
  try {
    await withRetry(
      async () => { count2++; console.log(`  [尝试 ${count2}] 正在执行...`); throw new RetryableError('永远失败', 500) },
      { maxRetries: 3, initialDelay: 300, onRetry: (err, attempt, delay) => console.log(`  [重试 ${attempt}] 等待 ${delay}ms`) },
    )
  } catch (err: any) {
    console.log(`\n  重试耗尽，最终抛出：${err.message}`)
    console.log(`  总共尝试了 ${count2} 次（1 次初始 + 3 次重试）\n`)
  }

  console.log('===== 场景3：不可重试错误，立即放弃 =====\n')
  let count3 = 0
  try {
    await withRetry(async () => { count3++; console.log(`  [尝试 ${count3}] 正在执行...`); throw new NonRetryableError('API Key 无效', 401) })
  } catch (err: any) {
    console.log(`\n  立即放弃，没有重试。原因：${err.message}`)
    console.log(`  总共只调用了 ${count3} 次\n`)
  }
}
main().catch(console.error)
