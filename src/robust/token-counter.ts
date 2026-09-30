import type { ChatMessage } from '../core/types.js';

/**
 * Token 估算（对应「上下文溢出」一类）。
 *
 * 刻意不接特定供应商的 tokenizer：那会把上下文层绑死在某个模型上，
 * 而供应商是可切换的（见 ADR-0003）。这里用字符类别的经验公式：
 *
 *   CJK 字符 × 1.5 + 其他字符 ÷ 4
 *
 * 取值偏保守——主流 tokenizer 对中文大致是 1~2 token/字，对英文约 4 字符/token，
 * 所以本公式在中文上略微高估，宁可早压缩也不要等供应商报超限。
 * 误差范围依据见 test/context-manager.spec.ts 的「token 估算口径」一组用例。
 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 每条消息除正文外的固定开销（角色标记、分隔符等）。 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * 单个字符的权重。截断必须按这个权重来切，
 * 否则「按字符数切」对中文会低估约 4.5 倍，压不进预算（本项目踩过）。
 */
export function charWeight(char: string): number {
  return CJK_PATTERN.test(char) ? 1.5 : 0.25;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const char of text) total += charWeight(char);
  return Math.ceil(total);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(call.rawArguments) + PER_MESSAGE_OVERHEAD;
  }
  return total;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

/** 按 token 预算截取前缀（不会把一个字符切一半）。 */
export function takePrefixByTokens(text: string, maxTokens: number): string {
  let used = 0;
  let out = '';
  for (const char of text) {
    const weight = charWeight(char);
    if (used + weight > maxTokens) break;
    used += weight;
    out += char;
  }
  return out;
}

/** 按 token 预算截取后缀。 */
export function takeSuffixByTokens(text: string, maxTokens: number): string {
  const chars = [...text];
  let used = 0;
  const kept: string[] = [];
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index] as string;
    const weight = charWeight(char);
    if (used + weight > maxTokens) break;
    used += weight;
    kept.unshift(char);
  }
  return kept.join('');
}
