/**
 * 工具调用校验
 * 拦截：不存在的工具、参数缺失、参数格式错误
 */

import { z } from 'zod'

// 工具定义：每个工具带一个参数 schema
export interface ToolDefinition {
  name: string
  description: string
  schema: z.ZodSchema
}

export interface ValidationResult {
  valid: boolean
  // 校验失败时，给模型的反馈，让它纠正
  feedback?: string
  // 校验通过后，清洗过的参数
  cleanArgs?: any
}

export class ToolValidator {
  private tools: Map<string, ToolDefinition> = new Map()

  constructor(tools: ToolDefinition[]) {
    for (const t of tools) {
      this.tools.set(t.name, t)
    }
  }

  /**
   * 校验一次工具调用
   * @param toolName 模型想调用的工具名
   * @param args 模型给的参数
   */
  validate(toolName: string, args: any): ValidationResult {
    // 第一关：工具是否存在（拦截幻觉工具）
    const tool = this.tools.get(toolName)
    if (!tool) {
      const available = Array.from(this.tools.keys()).join(', ')
      return {
        valid: false,
        feedback: `工具 "${toolName}" 不存在。你只能使用以下工具：${available}。请重新选择。`,
      }
    }

    // 第二关：参数校验（拦截编造或缺失的参数）
    const result = tool.schema.safeParse(args)
    if (!result.success) {
      // 把校验错误整理成给模型的反馈
      const issues = result.error.issues
        .map((i) => `参数 "${i.path.join('.')}"：${i.message}`)
        .join('；')
      return {
        valid: false,
        feedback: `调用 "${toolName}" 的参数有问题：${issues}。请检查后重新提供，不要编造参数。`,
      }
    }

    // 校验通过，返回清洗过的参数
    return {
      valid: true,
      cleanArgs: result.data,
    }
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys())
  }
}