/**
 * 主 Agent —— 同时用 MCP 和 A2A
 *
 * 场景：英文用户咨询订单
 *   第一步：用 MCP 查订单系统（纵向，连工具）
 *   第二步：大模型组织中文回复
 *   第三步：用 A2A 调翻译 Agent 翻成英文（横向，连 Agent）
 *
 * 运行前提：
 *   1. a2a-nestjs 的翻译 Agent 在 8888 端口运行
 *   2. 订单 MCP Server 会被本文件自动以子进程拉起
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { OpenAI } from 'openai'
import { randomUUID } from 'crypto'
import 'dotenv/config'

const llm = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  baseURL: 'https://api.deepseek.com/v1',
})

// ── MCP 部分：连订单系统查数据（纵向）──
async function queryOrderViaMCP(orderId: string): Promise<string> {
  const transport = new StdioClientTransport({
    command: 'npx',
    // 复用 mcp-demo 的订单 Server
    args: ['tsx', '../mcp-demo/server.ts'],
  })
  const client = new Client(
    { name: 'main-agent', version: '1.0.0' },
    { capabilities: {} },
  )
  await client.connect(transport)

  const result = await client.callTool({
    name: 'query_order',
    arguments: { orderId },
  })
  await client.close()

  return (result.content as any)[0].text as string
}

// ── A2A 部分：调翻译 Agent（横向）──
async function translateViaA2A(text: string): Promise<string> {
  const targetUrl = 'http://localhost:8888'

  // 发现远程 Agent
  const cardRes = await fetch(`${targetUrl}/.well-known/agent-card.json`)
  const card: any = await cardRes.json()
  console.log(`[A2A] 发现并调用：${card.name}`)

  // 委派翻译任务
  const res = await fetch(`${targetUrl}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: `翻译成英文：${text}` }],
          messageId: randomUUID(),
        },
      },
    }),
  })
  const data: any = await res.json()
  return data?.result?.message?.parts?.[0]?.text
}

// ── 主 Agent 编排 ──
async function main() {
  const orderId = 'ORD-12345'

  console.log('=== 收到英文用户咨询订单 ===\n')

  // 第一步：MCP 查订单（纵向，连工具）
  console.log('[Step 1] 通过 MCP 查询订单系统...')
  const orderData = await queryOrderViaMCP(orderId)
  console.log(`订单数据：${orderData}\n`)

  // 第二步：大模型用中文组织回复
  console.log('[Step 2] 大模型组织回复...')
  const draftRes = await llm.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是客服，根据订单数据给用户一句简洁的中文回复。' },
      { role: 'user', content: `订单数据：${orderData}` },
    ],
  })
  const chineseReply = draftRes.choices[0].message.content!
  console.log(`中文回复：${chineseReply}\n`)

  // 第三步：A2A 调翻译 Agent 翻成英文（横向，连 Agent）
  console.log('[Step 3] 通过 A2A 调翻译 Agent...')
  const englishReply = await translateViaA2A(chineseReply)

  // 最终回复用户
  console.log(`\n=== 最终回复用户（英文）===`)
  console.log(englishReply)
}

main().catch(console.error)
