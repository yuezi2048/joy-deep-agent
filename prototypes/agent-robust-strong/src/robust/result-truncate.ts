// 第5节：工具结果截断
import { estimateTokens } from './token-counter.js'
export interface TruncateConfig {
  maxTokens?: number
}
export function truncateResult(result: string, config: TruncateConfig = {}): string {
  const { maxTokens = 2000 } = config
  if (estimateTokens(result) <= maxTokens) return result
  const maxChars = maxTokens * 3
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.floor(maxChars * 0.3)
  const head = result.slice(0, headChars)
  const tail = result.slice(-tailChars)
  return `${head}\n\n...[内容过长，已截断 ${result.length - headChars - tailChars} 个字符]...\n\n${tail}`
}
