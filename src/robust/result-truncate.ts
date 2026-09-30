import type { ChatMessage } from '../core/types.js';
import { estimateTokens, takePrefixByTokens, takeSuffixByTokens } from './token-counter.js';

export interface TruncateOptions {
  /** 单条工具结果的 token 上限 */
  maxTokens?: number;
}

export interface TruncateOutcome {
  content: string;
  truncated: boolean;
  /** 被丢弃的字符数，用于报告 */
  droppedChars: number;
}

/** 截断标记本身也要占预算，按 token 预留，避免「标记比正文还长」。 */
const MARKER_RESERVE_TOKENS = 12;

function buildMarker(droppedChars: number): string {
  return `\n…[已截断 ${droppedChars} 字符]…\n`;
}

/**
 * 工具结果截断：头部保留 60%、尾部保留 30%，中间丢弃并标注。
 * 两头都留，是因为命令输出与文件内容的关键信息常在首尾（报错在尾、签名在头）。
 *
 * 按 **token 预算**切而不是按字符数切：中英文每字符权重差 6 倍，
 * 按字符切对中文会低估约 4.5 倍，压不进预算。
 */
export function truncateToolResult(content: string, options: TruncateOptions = {}): TruncateOutcome {
  const maxTokens = options.maxTokens ?? 2000;
  if (estimateTokens(content) <= maxTokens) {
    return { content, truncated: false, droppedChars: 0 };
  }

  const budget = Math.max(1, maxTokens - MARKER_RESERVE_TOKENS);
  const head = takePrefixByTokens(content, Math.floor(budget * 0.6));
  const tail = takeSuffixByTokens(content, Math.floor(budget * 0.3));
  const droppedChars = Math.max(0, content.length - head.length - tail.length);

  return {
    content: `${head}${buildMarker(droppedChars)}${tail}`,
    truncated: true,
    droppedChars,
  };
}

/** 只截断 tool 角色的消息正文，其余消息原样返回。 */
export function truncateToolMessages(
  messages: readonly ChatMessage[],
  options: TruncateOptions = {},
): { messages: ChatMessage[]; truncatedCount: number; droppedChars: number } {
  let truncatedCount = 0;
  let droppedChars = 0;

  const result = messages.map((message) => {
    if (message.role !== 'tool') return message;
    const outcome = truncateToolResult(message.content, options);
    if (!outcome.truncated) return message;
    truncatedCount++;
    droppedChars += outcome.droppedChars;
    return { ...message, content: outcome.content };
  });

  return { messages: result, truncatedCount, droppedChars };
}
