/**
 * A2A 调用方
 * 发现远程翻译 Agent，委派翻译任务
 * 运行前确保 NestJS 翻译 Agent 在 8888 端口运行
 */

import { randomUUID } from 'crypto'

async function main() {
  const targetUrl = 'http://localhost:8888'

  // 第一步：发现 —— 读取目标 Agent 的名片
  console.log('正在发现远程 Agent...')
  const cardRes = await fetch(`${targetUrl}/.well-known/agent-card.json`)
  const card: any = await cardRes.json()

  console.log(`发现 Agent：${card.name}`)
  console.log(`它的技能：${card.skills.map((s: any) => s.name).join(', ')}`)

  // 第二步：委派任务 —— 按 A2A 格式发送
  console.log('\n发送翻译任务...')
  const taskPayload = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [
          { kind: 'text', text: '把这句话翻译成英文：今天天气很好，适合写代码' },
        ],
        messageId: randomUUID(),
      },
    },
  }

  const res = await fetch(`${targetUrl}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskPayload),
  })

  const data: any = await res.json()

  // 第三步：拿到结果
  const reply = data?.result?.message?.parts?.[0]?.text
  console.log(`\n翻译 Agent 返回：${reply}`)
}

main().catch(console.error)
