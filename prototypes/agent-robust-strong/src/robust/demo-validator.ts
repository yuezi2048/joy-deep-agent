import { z } from 'zod'
import { ToolValidator } from './tool-validator.js'
async function main() {
  const validator = new ToolValidator([
    { name: 'query_order', description: '查订单', schema: z.object({ orderId: z.string().regex(/^ORD-\d+$/, '订单号格式应为 ORD-数字') }) },
    { name: 'request_refund', description: '申请退款', schema: z.object({ orderId: z.string().regex(/^ORD-\d+$/), reason: z.string().min(1, '退款原因不能为空') }) },
  ])
  console.log('Agent 实际拥有的工具：', validator.getToolNames(), '\n')
  console.log('===== 场景1：调用不存在的工具（幻觉工具）=====')
  const r1 = validator.validate('send_email', { to: 'a@b.com' })
  console.log(`  通过：${r1.valid}`); console.log(`  反馈：${r1.feedback}\n`)
  console.log('===== 场景2：订单号格式错误（幻觉参数）=====')
  const r2 = validator.validate('query_order', { orderId: '我随便编的订单号' })
  console.log(`  通过：${r2.valid}`); console.log(`  反馈：${r2.feedback}\n`)
  console.log('===== 场景3：缺少必填参数 =====')
  const r3 = validator.validate('request_refund', { orderId: 'ORD-12345' })
  console.log(`  通过：${r3.valid}`); console.log(`  反馈：${r3.feedback}\n`)
  console.log('===== 场景4：完全正确的调用 =====')
  const r4 = validator.validate('query_order', { orderId: 'ORD-12345' })
  console.log(`  通过：${r4.valid}`); console.log(`  清洗后参数：${JSON.stringify(r4.cleanArgs)}\n`)
}
main().catch(console.error)
