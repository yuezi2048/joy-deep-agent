/**
 * 失败调用处理演示
 * 运行：pnpm exec tsx src/my_robust/01_failed_call/demo-failed-call.ts
 */

import 'dotenv/config'
import { SafeLLM } from './safe-llm.js'
import { withRetry } from './retry.js'
import { RetryableError, NonRetryableError } from './errors.js'
import { safeParseJSON } from './safe-json.js'

async function main() {
  // ── 演示一：正常的安全调用 ──
  console.log('=== 演示一：安全的模型调用 ===')
  const llm = new SafeLLM({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    timeoutMs: 30000,
    maxRetries: 3,
  })

  const reply = await llm.chat([
    { role: 'user', content: '用一句话解释什么是重试机制' },
  ])
  console.log('回复：', reply)

  // ── 演示二：模拟可重试错误，看重试过程 ──
  console.log('\n=== 演示二：模拟失败重试 ===')
  let callCount = 0
  try {
    const result = await withRetry(
      async () => {
        callCount++
        console.log(`第 ${callCount} 次尝试...`)
        // 前两次故意失败，第三次成功
        if (callCount < 3) {
          throw new RetryableError('模拟的临时故障', 503)
        }
        return '终于成功了！'
      },
      {
        maxRetries: 3,
        initialDelay: 500,
        onRetry: (err, attempt, delay) => {
          console.log(`  → 第 ${attempt} 次重试，等待 ${delay}ms`)
        },
      },
    )
    console.log('结果：', result)
  } catch (error: any) {
    console.error('最终失败：', error.message)
  }

  // ── 演示三：不可重试错误，直接放弃 ──
  console.log('\n=== 演示三：不可重试错误 ===')
  try {
    await withRetry(async () => {
      console.log('尝试调用...')
      throw new NonRetryableError('API Key 无效', 401)
    })
  } catch (error: any) {
    console.log(`直接放弃（没有重试），原因：${error.message}`)
  }

  // ── 演示四：容错解析模型返回的 JSON ──
  console.log('\n=== 演示四：容错 JSON 解析 ===')
  // 模拟模型返回的脏 JSON（带 markdown 代码块和解释）
  const dirtyJSON = '好的，这是结果：\n```json\n{"name": "大伟", "skill": "AI"}\n```'
  const parsed = safeParseJSON(dirtyJSON)
  console.log('从脏数据中解析出：', parsed)
}

main().catch(console.error)