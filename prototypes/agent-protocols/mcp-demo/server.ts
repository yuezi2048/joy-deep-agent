/**
 * MCP Server —— 工具方
 * 暴露订单系统的两个工具：查订单、申请退款
 *
 * 注意：本文件的日志必须用 console.error
 * 因为 stdout 被 MCP 协议占用，用 console.log 会污染 JSON-RPC 消息
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// 创建 MCP Server 实例，这就是「工具方」
const server = new McpServer({
  name: 'order-server',
  version: '1.0.0',
})

// 工具一：查订单
server.registerTool(
  'query_order',
  {
    description: '根据订单号查询订单详情',
    inputSchema: {
      orderId: z.string().describe('订单号'),
    },
  },
  async ({ orderId }) => {
    // 查询订单的逻辑，这里直接返回一个假数据； 实际应用中会查询数据库或调用其他服务 // ajax接口
    // aixos.get(`/api/orders/${orderId}`)
    const fakeOrder = {
      orderId,
      product: 'iPhone 16 Pro',
      amount: 8999,
      status: '已发货',
      shippedAt: '2026-01-15',
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify(fakeOrder, null, 2) },
      ],
    }
  },
)

// 工具二：申请退款
server.registerTool(
  'request_refund',
  {
    description: '为指定订单申请退款',
    inputSchema: {
      orderId: z.string().describe('订单号'),
      reason: z.string().describe('退款原因'),
    },
  },
  async ({ orderId, reason }) => {
    return {
      content: [
        {
          type: 'text',
          text: `订单 ${orderId} 退款申请已提交，原因：${reason}，预计 3-5 个工作日到账`,
        },
      ],
    }
  },
)

// 用 stdio 传输启动 Server
const transport = new StdioServerTransport()
await server.connect(transport)

// 日志用 console.error，不能用 console.log
console.error('订单 MCP Server 已启动')
