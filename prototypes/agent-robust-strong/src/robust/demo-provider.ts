import 'dotenv/config'
import { MultiProvider } from './multi-provider.js'
import { CircuitBreaker } from './circuit-breaker.js'
async function main() {
  console.log('=== 演示一：熔断器状态变化 ===\n')
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 2000 })
  console.log(`初始状态：${breaker.getState()}，可请求：${breaker.canRequest()}`)
  for (let i = 1; i <= 3; i++) {
    breaker.recordFailure()
    console.log(`第 ${i} 次失败后：${breaker.getState()}，可请求：${breaker.canRequest()}`)
  }
  console.log('（连续失败 3 次，已熔断，请求被拒绝）\n')
  console.log('等待 2 秒冷却...')
  await new Promise((r) => setTimeout(r, 2100))
  console.log(`冷却后：可请求：${breaker.canRequest()}，状态：${breaker.getState()}`)
  breaker.recordSuccess()
  console.log(`试探成功后：${breaker.getState()}（恢复正常）\n`)

  console.log('=== 演示二：多供应商故障转移 ===\n')
  const multi = new MultiProvider([
    { name: '故障供应商（错误key）', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-错误的key', model: 'deepseek-chat', priority: 1 },
    { name: 'DeepSeek（正常）', baseURL: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY!, model: 'deepseek-chat', priority: 2 },
  ])
  const reply = await multi.chat([{ role: 'user', content: '用一句话解释什么是故障转移' }])
  console.log(`\n最终回复：${reply}`)
  console.log(`\n各供应商状态：`, JSON.stringify(multi.getStatus(), null, 2))
}
main().catch(console.error)
