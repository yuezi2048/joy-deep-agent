import 'dotenv/config'
import { estimateTokens, estimateMessagesTokens, Message } from './token-counter.js'
import { applySlidingWindow } from './sliding-window.js'
import { truncateResult } from './result-truncate.js'
async function main() {
  console.log('=== 演示一：token 估算 ===\n')
  console.log(`"你好世界" 约 ${estimateTokens('你好世界')} token`)
  console.log(`"hello world" 约 ${estimateTokens('hello world')} token`)
  console.log(`600 字中文约 ${estimateTokens('通用型智能体'.repeat(100))} token\n`)

  console.log('=== 演示二：滑动窗口裁剪 ===\n')
  const messages: Message[] = [{ role: 'system', content: '你是助手' }]
  for (let i = 1; i <= 20; i++) {
    messages.push({ role: 'user', content: `这是第 ${i} 轮用户消息，`.repeat(50) })
    messages.push({ role: 'assistant', content: `这是第 ${i} 轮回复，`.repeat(50) })
  }
  console.log(`原始消息数：${messages.length}，约 ${estimateMessagesTokens(messages)} token`)
  const windowed = applySlidingWindow(messages, { maxTokens: 5000, minRecentMessages: 4 })
  console.log(`裁剪后消息数：${windowed.length}，约 ${estimateMessagesTokens(windowed)} token`)
  console.log(`保留了：系统提示 + 最近的几轮（早期被丢弃）\n`)

  console.log('=== 演示三：工具结果截断 ===\n')
  const bigResult = '数据行\n'.repeat(2000)
  console.log(`原始结果约 ${estimateTokens(bigResult)} token`)
  const truncated = truncateResult(bigResult, { maxTokens: 500 })
  console.log(`截断后约 ${estimateTokens(truncated)} token`)
  console.log(`截断标记：${truncated.includes('已截断') ? '有' : '无'}`)
}
main().catch(console.error)
