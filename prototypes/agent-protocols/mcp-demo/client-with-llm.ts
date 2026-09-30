/**
 * MCP Client + 大模型
 * 不再手动 callTool，而是让大模型自己判断调哪个工具
 * 完整闭环：用户提问 → 大模型决策 → MCP 执行 → 返回结果
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { OpenAI } from 'openai'
import 'dotenv/config'

const llm = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  baseURL: 'https://api.deepseek.com/v1',
})

async function main() {
  // 连接 MCP Server
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'server.ts'],
  })
  const client = new Client(
    { name: 'order-client', version: '1.0.0' },
    { capabilities: {} },
  )
  await client.connect(transport)

  // 把 MCP 工具转成大模型的 function calling 格式
  // 大模型靠工具的 name 和 description 判断调哪个
  const mcpTools = await client.listTools()

  const llmTools = mcpTools.tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))

  // 用户的自然语言请求
  const userMessage = '帮我查一下订单 ORD-12345 的情况'
  console.log(`用户：${userMessage}\n`)

  // 把工具列表给大模型，让它判断
  const response = await llm.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: userMessage }],
    tools: llmTools,
  })

  const toolCall = response.choices[0].message.tool_calls?.[0]
  if (toolCall) {
    console.log(`大模型决定调用：${toolCall.function.name}`)
    console.log(`参数：${toolCall.function.arguments}`)

    // 大模型说要调哪个，我们就通过 MCP 去调
    const args = JSON.parse(toolCall.function.arguments)
    const result = await client.callTool({
      name: toolCall.function.name,
      arguments: args,
    })
    console.log(`\n工具返回：\n${(result.content as any)[0].text}`)
  } else {
    console.log('大模型没有调用工具，直接回复：')
    console.log(response.choices[0].message.content)
  }

  await client.close()
}

main().catch(console.error)
