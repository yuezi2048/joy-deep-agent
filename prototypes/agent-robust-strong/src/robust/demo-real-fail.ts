import 'dotenv/config'
import { SafeLLM } from './safe-llm.js'
async function main() {
  console.log('===== 场景1：正常调用 =====\n')
  const llm = new SafeLLM({ apiKey: process.env.DEEPSEEK_API_KEY!, timeoutMs: 30000, maxRetries: 3 })
  const reply = await llm.chat([{ role: 'user', content: '用一句话解释什么是指数退避' }])
  console.log('回复：', reply, '\n')

  console.log('===== 场景2：错误的 key，看兜底 =====\n')
  const badLlm = new SafeLLM({ apiKey: 'sk-这是一个错误的key', timeoutMs: 10000, maxRetries: 2 })
  const badReply = await badLlm.chat([{ role: 'user', content: '你好' }])
  console.log('返回：', badReply)
  console.log('（注意：程序没有崩溃，而是返回了友好提示）\n')
}
main().catch(console.error)
