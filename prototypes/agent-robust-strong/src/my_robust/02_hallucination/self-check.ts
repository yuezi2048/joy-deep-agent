/**
 * 自我核查
 * 用模型对照原始材料，检查输出有没有编造的内容
 * 这是 harness 里讲的"推理型 Sensor"
 */

import { SafeLLM } from '../01_failed_call/safe-llm.js'
import { safeParseJSON } from '../01_failed_call/safe-json.js'

export interface FactCheckResult {
  // 是否发现了编造内容
  hasFabrication: boolean
  // 发现的问题列表
  issues: string[]
  // 是否建议重新生成
  shouldRegenerate: boolean
}

/**
 * 核查一段回答是否基于给定材料，有没有编造
 * @param answer 要核查的回答
 * @param sourceMaterial 原始材料
 * @param llm SafeLLM 实例
 */
export async function factCheck(
  answer: string,
  sourceMaterial: string,
  llm: SafeLLM,
): Promise<FactCheckResult> {
  const checkPrompt = `你是事实核查员。下面有一段"原始材料"和一段"待核查回答"。
请检查回答中的每个事实性陈述，是否都能在原始材料中找到依据。

【原始材料】
${sourceMaterial}

【待核查回答】
${answer}

请只返回 JSON，格式如下，不要任何解释：
{
  "hasFabrication": true 或 false,
  "issues": ["发现的编造内容描述", ...]
}

如果回答中有原始材料里找不到依据的内容，hasFabrication 为 true，并在 issues 里列出。
如果回答完全有据可查，hasFabrication 为 false，issues 为空数组。`

  const response = await llm.chat([{ role: 'user', content: checkPrompt }])
  const parsed = safeParseJSON<{ hasFabrication: boolean; issues: string[] }>(
    response,
  )

  if (!parsed) {
    // 核查结果都解析不出来，保守起见标记为需要人工关注
    return {
      hasFabrication: false,
      issues: ['核查结果解析失败，建议人工复核'],
      shouldRegenerate: false,
    }
  }

  return {
    hasFabrication: parsed.hasFabrication,
    issues: parsed.issues ?? [],
    shouldRegenerate: parsed.hasFabrication && parsed.issues.length > 0,
  }
}