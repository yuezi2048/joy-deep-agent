/**
 * 翻译 Agent 的 A2A 控制器
 * 提供两个端点：
 *   1. Agent Card（名片）—— 标准路径 /.well-known/agent-card.json
 *   2. 任务端点 —— POST / 接收别的 Agent 发来的任务
 */

import { Controller, Get, Post, Body } from '@nestjs/common'
import { TranslateService } from './translate.service'

@Controller()
export class TranslateController {
  constructor(private readonly translateService: TranslateService) {}

  // ── Agent Card（名片）──
  // A2A 最核心的设计：发布在标准路径，任何客户端来这里读名片
  // NestJS 里路径用 .well-known/agent-card.json（不带开头斜杠）
  @Get('.well-known/agent-card.json')
  getAgentCard() {
    return {
      name: '翻译 Agent',
      description: '专业的多语言翻译 Agent',
      url: 'http://localhost:8888/',
      version: '1.0.0',
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      capabilities: { streaming: false },
      // skills 声明这个 Agent 会什么，别的 Agent 靠这个判断要不要委派任务
      skills: [
        {
          id: 'translate',
          name: '文本翻译',
          description: '把文本翻译成指定语言',
          tags: ['translation', 'language'],
          examples: ['把这段话翻译成英文', '翻译成日语'],
        },
      ],
    }
  }

  // ── A2A 任务端点 ──
  // 别的 Agent 通过 POST / 发任务过来
  @Post()
  async handleTask(@Body() body: any) {
    // 从 A2A 消息结构里取出要翻译的内容
    const userText = body?.params?.message?.parts?.[0]?.text ?? ''
    console.log(`[翻译 Agent] 收到任务：${userText}`)

    const result = await this.translateService.translate(userText)

    // 按 A2A 的 JSON-RPC 2.0 格式返回
    return {
      jsonrpc: '2.0',
      id: body?.id,
      result: {
        message: {
          role: 'agent',
          parts: [{ kind: 'text', text: result }],
        },
      },
    }
  }
}
