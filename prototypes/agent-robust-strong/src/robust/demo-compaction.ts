import 'dotenv/config'
import { compactMessages } from './compaction.js'
import { estimateMessagesTokens, Message } from './token-counter.js'
import { SafeLLM } from './safe-llm.js'
async function main() {
  const llm = new SafeLLM({ apiKey: process.env.DEEPSEEK_API_KEY! })
  const messages: Message[] = [
    { role: 'system', content: '你是项目助手' },
    { role: 'user', content: '我要做一个电商网站，先确定技术栈' },
    { role: 'assistant', content: '建议用 Vue3 + TypeScript 前端，NestJS 后端，PostgreSQL 数据库' },
    { role: 'user', content: '好，先做用户登录模块' },
    { role: 'assistant', content: '登录模块完成了，用了 JWT 鉴权，密码用 bcrypt 加密' },
    { role: 'user', content: '再做商品列表' },
    { role: 'assistant', content: '商品列表完成了，支持分页和筛选' },
    { role: 'user', content: '现在做购物车' },
    { role: 'assistant', content: '购物车完成了，用 Redis 存临时购物车数据' },
  ]
  messages.forEach((m) => { if (m.role === 'assistant') m.content = m.content.repeat(20) })
  console.log('===== 压缩前 =====')
  console.log(`消息数：${messages.length}`)
  console.log(`约 ${estimateMessagesTokens(messages)} token\n`)
  const compacted = await compactMessages(messages, llm, { triggerTokens: 1000, keepRecent: 2 })
  console.log('\n===== 压缩后 =====')
  console.log(`消息数：${compacted.length}`)
  console.log(`约 ${estimateMessagesTokens(compacted)} token\n`)
  const summary = compacted.find((m) => m.content.includes('早期对话摘要'))
  if (summary) {
    console.log('压缩后的摘要内容：')
    console.log('---'); console.log(summary.content); console.log('---')
    console.log('\n注意：早期的多轮对话被压成了一段摘要，但关键信息保留了')
  }
}
main().catch(console.error)
