/**
 * 带幻觉防护的工具调用
 * 集成：工具校验 + 校验失败让模型纠正
 */

import { ToolValidator } from './tool-validator.js'
import { SafeLLM } from '../01_failed_call/safe-llm.js'

export interface ToolCallRequest {
  toolName: string
  args: any
}

/**
 * 安全执行工具调用
 * 校验不通过时，把反馈给模型，让它重新生成，最多重试几次
 */
export async function safeToolCall(
  request: ToolCallRequest,
  validator: ToolValidator,
  executor: (toolName: string, args: any) => Promise<string>,
  regenerate: (feedback: string) => Promise<ToolCallRequest>,
  maxRetries = 2,
): Promise<string> {
  let current = request

  for (let i = 0; i <= maxRetries; i++) {
    // 校验工具调用
    const validation = validator.validate(current.toolName, current.args)

    if (validation.valid) {
      // 校验通过，执行
      return await executor(current.toolName, validation.cleanArgs)
    }

    // 校验失败
    console.warn(`[幻觉防护] 工具调用校验失败：${validation.feedback}`)

    // 还有重试机会，让模型根据反馈重新生成
    if (i < maxRetries) {
      console.log(`[幻觉防护] 让模型重新生成工具调用`)
      current = await regenerate(validation.feedback!)
    }
  }

  // 重试用完还不行，拒绝执行
  return `工具调用校验多次失败，已拒绝执行，避免基于错误参数操作。`
}