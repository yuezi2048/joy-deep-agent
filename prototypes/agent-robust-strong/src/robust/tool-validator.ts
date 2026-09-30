// 第2节：工具调用校验（拦截幻觉工具和参数）
import { z } from 'zod'
export interface ToolDefinition {
  name: string
  description: string
  schema: z.ZodSchema
}
export interface ValidationResult {
  valid: boolean
  feedback?: string
  cleanArgs?: any
}
export class ToolValidator {
  private tools: Map<string, ToolDefinition> = new Map()
  constructor(tools: ToolDefinition[]) {
    for (const t of tools) this.tools.set(t.name, t)
  }
  validate(toolName: string, args: any): ValidationResult {
    const tool = this.tools.get(toolName)
    if (!tool) {
      const available = Array.from(this.tools.keys()).join(', ')
      return { valid: false, feedback: `工具 "${toolName}" 不存在。你只能使用以下工具：${available}。请重新选择。` }
    }
    const result = tool.schema.safeParse(args)
    if (!result.success) {
      const issues = result.error.issues.map((i) => `参数 "${i.path.join('.')}"：${i.message}`).join('；')
      return { valid: false, feedback: `调用 "${toolName}" 的参数有问题：${issues}。请检查后重新提供，不要编造参数。` }
    }
    return { valid: true, cleanArgs: result.data }
  }
  getToolNames(): string[] {
    return Array.from(this.tools.keys())
  }
}
