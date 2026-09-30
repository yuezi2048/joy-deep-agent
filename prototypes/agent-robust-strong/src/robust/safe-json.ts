// 第1节：容错解析模型返回的 JSON
export function safeParseJSON<T = any>(raw: string): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  let cleaned = raw.trim()
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim()
    try { return JSON.parse(cleaned) } catch {}
  }
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) } catch {}
  }
  const firstBracket = cleaned.indexOf('[')
  const lastBracket = cleaned.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1)) } catch {}
  }
  return null
}
export async function parseJSONWithRetry<T = any>(
  raw: string, regenerate: (errorHint: string) => Promise<string>, maxRetries = 2,
): Promise<T | null> {
  let current = raw
  for (let i = 0; i <= maxRetries; i++) {
    const parsed = safeParseJSON<T>(current)
    if (parsed !== null) return parsed
    if (i < maxRetries) {
      current = await regenerate('你上次的返回不是合法的 JSON，请只返回纯 JSON，不要任何解释文字和 markdown 代码块。')
    }
  }
  return null
}
