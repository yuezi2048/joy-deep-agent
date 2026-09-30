/**
 * 来源约束（Grounding）
 * 构建强约束的 prompt，让模型只基于给定材料回答
 */

export interface GroundedSource {
  id: string       // 来源编号
  title: string    // 来源标题
  content: string  // 来源内容
}

/**
 * 构建带来源约束的 prompt
 * 强制模型只用提供的材料，并标注来源
 */
export function buildGroundedPrompt(
  question: string,
  sources: GroundedSource[],
): string {
  const sourcesText = sources
    .map((s) => `[来源 ${s.id}] ${s.title}\n${s.content}`)
    .join('\n\n')

  return `请严格根据以下提供的资料回答问题。

【硬性要求】
1. 只能使用下面提供的资料，不要使用你自己的知识，不要编造。
2. 每个关键结论后面，用 [来源 X] 标注它来自哪条资料。
3. 如果资料里没有相关信息，必须明确说"提供的资料中没有相关信息"，不要猜测、不要编造。
4. 如果资料之间有矛盾，指出矛盾，不要自行决定哪个对。

【提供的资料】
${sourcesText}

【问题】
${question}`
}

/**
 * 检查回答里是否标注了来源
 * 没有任何来源标注的回答，可能是模型在自由发挥（幻觉风险高）
 */
export function hasSourceCitation(answer: string): boolean {
  return /\[来源\s*\d+\]/.test(answer)
}