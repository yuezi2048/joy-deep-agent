import { estimateTokens, estimateMessagesTokens } from './token-counter.js'
async function main() {
  console.log('===== 不同内容的 token 估算 =====\n')
  const cases = ['你好', '你好世界，这是一段中文测试', 'hello world', 'The quick brown fox jumps over the lazy dog', 'function add(a, b) { return a + b }']
  for (const text of cases) {
    console.log(`"${text}"`)
    console.log(`  字符数：${text.length}，估算 token：${estimateTokens(text)}\n`)
  }
  console.log('===== 消息组的 token 估算 =====\n')
  const messages = [
    { role: 'system' as const, content: '你是一个专业的前端助手' },
    { role: 'user' as const, content: '帮我写一个 Vue 组件' },
    { role: 'assistant' as const, content: '好的，这是一个 Vue 组件...' },
  ]
  console.log(`3 条消息总 token 估算：${estimateMessagesTokens(messages)}`)
}
main().catch(console.error)
