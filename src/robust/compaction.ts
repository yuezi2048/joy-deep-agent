import type { ChatMessage } from '../core/types.js';
import type { ChatModel } from '../providers/chat-model.js';

/** 把一段对话文本压成摘要。抽成函数是为了测试能注入假实现，不烧真模型。 */
export type Summarizer = (transcript: string) => Promise<string>;

const SUMMARY_HEADER = '【早期对话摘要（已压缩，非原始观测；如需细节请重新调用工具获取）】';

/** 把被丢弃的中段渲染成纯文本，供摘要使用。 */
export function renderTranscript(groups: readonly ChatMessage[][]): string {
  const lines: string[] = [];
  for (const group of groups) {
    for (const message of group) {
      const label = message.toolCalls?.length
        ? `${message.role}(调用 ${message.toolCalls.map((call) => call.name).join(', ')})`
        : message.role;
      lines.push(`[${label}] ${message.content}`);
    }
  }
  return lines.join('\n');
}

export function buildSummaryMessage(summary: string): ChatMessage {
  return { role: 'system', content: `${SUMMARY_HEADER}\n${summary}` };
}

/** 用内层模型做摘要。注意直接调 inner，不经过上下文装饰器，避免递归。 */
export function createModelSummarizer(model: ChatModel): Summarizer {
  return async (transcript: string): Promise<string> => {
    const response = await model.chat({
      messages: [
        {
          role: 'user',
          content:
            '把下面这段 Agent 执行历史压缩成一段简洁摘要。保留：已完成的关键步骤、' +
            '得到的结论与数据、尚未完成的待办、以及后续可能需要复现的工具调用。' +
            '去掉冗余的中间过程。直接给摘要，不要客套。\n\n' +
            transcript,
        },
      ],
      temperature: 0,
    });
    return response.content.trim();
  };
}
