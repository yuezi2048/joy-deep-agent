/**
 * 幻觉处理演示
 * 运行：pnpm exec tsx src/my_robust/02_hallucination/demo-hallucination.ts
 */

import 'dotenv/config'
import { z } from 'zod'
import { ToolValidator } from './tool-validator.js'
import { buildGroundedPrompt, hasSourceCitation } from './grounding.js'
import { SafeLLM } from '../01_failed_call/safe-llm.js'

async function main() {
  const llm = new SafeLLM({ apiKey: process.env.DEEPSEEK_API_KEY! })

  // ── 演示一：工具校验拦截幻觉 ──
  console.log('=== 演示一：工具参数校验 ===\n')
  const validator = new ToolValidator([
    {
      name: 'query_order',
      description: '查订单',
      schema: z.object({
        orderId: z.string().regex(/^ORD-\d+$/, '订单号格式应为 ORD-数字'),
      }),
    },
  ])

  // 情况1：调用不存在的工具
  const r1 = validator.validate('send_email', { to: 'x@x.com' })
  console.log('调用不存在的工具 send_email：')
  console.log(`  通过：${r1.valid}，反馈：${r1.feedback}\n`)

  // 情况2：参数格式错误（模型编了个不规范的订单号）
  const r2 = validator.validate('query_order', { orderId: '随便编的' })
  console.log('订单号格式错误：')
  console.log(`  通过：${r2.valid}，反馈：${r2.feedback}\n`)

  // 情况3：参数正确
  const r3 = validator.validate('query_order', { orderId: 'ORD-12345' })
  console.log('正确的调用：')
  console.log(`  通过：${r3.valid}，清洗后参数：${JSON.stringify(r3.cleanArgs)}\n`)

  // ── 演示二：来源约束，对比有约束和无约束 ──
  console.log('=== 演示二：来源约束 ===\n')
  const sources = [
    { id: '1', title: '产品介绍', content: '我们的产品支持 Vue3 和 React。' },
  ]

  // 问一个材料里没有的问题
  const question = '产品支持 Angular 吗？'
  const groundedPrompt = buildGroundedPrompt(question, sources)
  const answer = await llm.chat([{ role: 'user', content: groundedPrompt }])
  console.log(`问题：${question}`)
  console.log(`回答：${answer}`)
  console.log(`是否标注来源：${hasSourceCitation(answer)}`)
  console.log('（资料里只说支持 Vue3/React，没提 Angular，正确的回答应该说"资料中没有"）\n')
}

main().catch(console.error)