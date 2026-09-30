/**
 * 翻译服务
 * 封装大模型翻译逻辑
 */

import { Injectable } from '@nestjs/common'
import { OpenAI } from 'openai'

@Injectable()
export class TranslateService {
  private llm: OpenAI

  constructor() {
    this.llm = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseURL: 'https://api.deepseek.com/v1',
    })
  }

  async translate(text: string): Promise<string> {
    const response = await this.llm.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: '你是专业翻译，按用户要求翻译文本，只返回翻译结果，不要解释。',
        },
        { role: 'user', content: text },
      ],
    })
    return response.choices[0].message.content ?? ''
  }
}
