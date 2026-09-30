/**
 * MCP Client —— 调用方
 * 连接 server.ts，发现工具并手动调用
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

async function main() {
  // 创建传输，指向 server.ts
  // stdio 方式会把 server 当子进程拉起来
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'server.ts'],
  })

  // 创建 Client 并连接
  // 记住：Client 和 Server 是一对一的关系
  const client = new Client(
    { name: 'order-client', version: '1.0.0' },
    { capabilities: {} },
  )
  await client.connect(transport)
  console.log('已连接 MCP Server')

  // 能力发现：Client 问 Server「你有什么工具」
  const tools = await client.listTools()
  console.log('\nServer 提供的工具：')
  tools.tools.forEach((t) => {
    console.log(`  - ${t.name}: ${t.description}`)
  })

  // 调用工具一：查订单
  console.log('\n调用 query_order：')
  const result = await client.callTool({
    name: 'query_order',
    arguments: { orderId: 'ORD-12345' },
  })
  console.log((result.content as any)[0].text)

  // 调用工具二：申请退款
  console.log('\n调用 request_refund：')
  const refund = await client.callTool({
    name: 'request_refund',
    arguments: { orderId: 'ORD-12345', reason: '商品有质量问题' },
  })
  console.log((refund.content as any)[0].text)

  await client.close()
}

main().catch(console.error)
