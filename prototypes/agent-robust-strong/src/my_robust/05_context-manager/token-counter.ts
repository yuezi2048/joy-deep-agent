/**
 * Token 估算
 * 精确计算要用 tiktoken 这类库，这里用够用的估算方法
 */

/**
 * 估算一段文本的 token 数
 * 经验规则：中文约 1 字 = 1.5 token，英文约 1 词 = 1.3 token
 * 简化处理：中文字符按 1.5，其他按字符数/4
 */
export function estimateTokens(text: string): number {
  if (!text) return 0

  // 统计中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  // 非中文部分的字符数
  const otherChars = text.length - chineseChars

  // 中文按 1.5 token/字，其他按 4 字符/token（英文经验值）
  return Math.ceil(chineseChars * 1.5 + otherChars / 4)
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 估算一组消息的总 token
 */
export function estimateMessagesTokens(messages: Message[]): number {
  // 每条消息有固定开销（role 等元数据），经验值约 4 token
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + 4,
    0,
  )
}