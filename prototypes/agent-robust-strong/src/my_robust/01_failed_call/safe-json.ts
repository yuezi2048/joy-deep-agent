/**
 * 安全解析模型返回的 JSON
 * 模型经常返回带 markdown 代码块的 JSON，或者多余的解释文字
 * 直接 JSON.parse 会崩，这里做容错
 */

export function safeParseJSON<T = any>(raw: string): T | null {
  if (!raw) return null

  // 第一步：直接尝试解析
  try {
    return JSON.parse(raw)
  } catch {
    // 继续往下做清洗
  }

  // 第二步：去掉 markdown 代码块包裹
  // 模型经常返回 ```json ... ``` 这种
  let cleaned = raw.trim()
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      // 继续
    }
  }

  // 第三步：尝试提取第一个 { 到最后一个 } 之间的内容
  // 应对模型在 JSON 前后加了解释文字的情况
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = cleaned.slice(firstBrace, lastBrace + 1)
    try {
      return JSON.parse(extracted)
    } catch {
      // 继续
    }
  }

  // 数组的情况，同理处理 [ ]
  const firstBracket = cleaned.indexOf('[')
  const lastBracket = cleaned.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const extracted = cleaned.slice(firstBracket, lastBracket + 1)
    try {
      return JSON.parse(extracted)
    } catch {
      // 继续
    }
  }

  // 实在解析不出来，返回 null，让上层决定怎么办
  return null
}

/**
 * 让模型重新生成正确的 JSON
 * 配合上面用：解析失败时，把错误反馈给模型让它重新生成
 */
export async function parseJSONWithRetry<T = any>(
  raw: string,
  regenerate: (errorHint: string) => Promise<string>,
  maxRetries = 2,
): Promise<T | null> {
  let current = raw

  for (let i = 0; i <= maxRetries; i++) {
    const parsed = safeParseJSON<T>(current)
    if (parsed !== null) return parsed

    // 解析失败，且还有重试机会，让模型重新生成
    if (i < maxRetries) {
      console.warn(`[safeJSON] 第 ${i + 1} 次解析失败，让模型重新生成`)
      current = await regenerate(
        '你上次的返回不是合法的 JSON，请只返回纯 JSON，不要任何解释文字和 markdown 代码块。',
      )
    }
  }

  return null
}