import { applySlidingWindow } from './sliding-window.js'
import { estimateMessagesTokens, Message } from './token-counter.js'
async function main() {
  const messages: Message[] = [{ role: 'system', content: '你是助手，这是系统提示，必须保留' }]
  for (let i = 1; i <= 20; i++) {
    messages.push({ role: 'user', content: `第 ${i} 轮用户消息内容，`.repeat(30) })
    messages.push({ role: 'assistant', content: `第 ${i} 轮助手回复内容，`.repeat(30) })
  }
  console.log('===== 裁剪前 =====')
  console.log(`消息总数：${messages.length}`)
  console.log(`总 token：约 ${estimateMessagesTokens(messages)}\n`)
  const windowed = applySlidingWindow(messages, { maxTokens: 3000, minRecentMessages: 4 })
  console.log('===== 裁剪后 =====')
  console.log(`消息总数：${windowed.length}`)
  console.log(`总 token：约 ${estimateMessagesTokens(windowed)}`)
  console.log(`\n保留的消息：`)
  windowed.forEach((m) => console.log(`  [${m.role}] ${m.content.slice(0, 20)}...`))
  console.log(`\n注意：系统提示保留了，早期的轮次被丢弃，只留了最近几轮`)
}
main().catch(console.error)
