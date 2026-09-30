/**
 * 工具结果截断
 * 工具返回的大内容，放进上下文前先控制大小
 */

import { estimateTokens } from './token-counter.js'

export interface TruncateConfig {
  // 单个工具结果的 token 上限
  maxTokens?: number
}

/**
 * 截断过大的工具结果
 * 保留头部和尾部，中间用省略标记
 */
export function truncateResult(
  result: string,
  config: TruncateConfig = {},
): string {
  const { maxTokens = 2000 } = config

  if (estimateTokens(result) <= maxTokens) {
    return result
  }

  // 超了，保留头尾，掐掉中间
  // 粗略按 token 比例换算成字符
  const maxChars = maxTokens * 3
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.floor(maxChars * 0.3)

  const head = result.slice(0, headChars)
  const tail = result.slice(-tailChars)

  return `${head}\n\n...[内容过长，已截断 ${result.length - headChars - tailChars} 个字符]...\n\n${tail}`
}