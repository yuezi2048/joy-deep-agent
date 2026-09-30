import type { ChatMessage } from '../core/types.js';
import type { ChatModel, ChatRequest, ChatResponse, StreamChunk } from '../providers/chat-model.js';
import {
  buildSummaryMessage,
  createModelSummarizer,
  renderTranscript,
  type Summarizer,
} from './compaction.js';
import { truncateToolMessages } from './result-truncate.js';
import { applySlidingWindow, planSlidingWindow } from './sliding-window.js';
import { estimateMessagesTokens } from './token-counter.js';

export interface ContextBudgetOptions {
  /** 发给模型的历史预算（token，含 system） */
  maxTokens?: number;
  /** 单条工具结果的 token 上限 */
  maxToolResultTokens?: number;
  /** 无论如何都要保留的最近组数 */
  keepRecentGroups?: number;
  /** 是否把丢弃的中段压成摘要；传 false 则直接丢弃 */
  summarize?: boolean;
  /** 注入自定义摘要器（测试用） */
  summarizer?: Summarizer;
}

export interface ContextStats {
  tokensBefore: number;
  tokensAfter: number;
  truncatedResults: number;
  droppedChars: number;
  droppedGroups: number;
  summarized: boolean;
  /** 摘要失败而降级为直接丢弃 */
  summarizerFailed: boolean;
  /** 已经压到极限仍超出预算（硬下限，如实上报而不是假装成功） */
  overBudget: boolean;
}

/** 工具结果能压到的下限：再小就只剩标记，没有信息量 */
const MIN_TOOL_RESULT_TOKENS = 24;

/**
 * 上下文预算层（对应「上下文溢出」一类）。
 *
 * 做成 ChatModel 装饰器而不是塞进 AgentLoop：编排层只负责「想 → 调 → 看 → 再想」，
 * 预算收缩是模型调用前的一道加工，两者职责不该混（见 ADR-0002 的同一思路）。
 * 轨迹在 AgentLoop 里保持完整可回放，被收缩的只是「发给模型的视图」。
 *
 * 三级降级，逐级更狠：
 *   1. 截断——单条工具结果超限就掐头去尾
 *   2. 压缩——历史超限时按组丢弃最旧，并把丢掉的中段压成摘要
 *   3. 丢弃——摘要后仍超限，再做一次纯丢弃
 */
export class ContextManagedChatModel implements ChatModel {
  readonly name: string;
  readonly model: string;
  readonly supportsTools: boolean;

  private readonly inner: ChatModel;
  private readonly maxTokens: number;
  private readonly maxToolResultTokens: number;
  private readonly keepRecentGroups: number;
  private readonly summarizer: Summarizer | null;
  private lastStatsValue: ContextStats | null = null;

  constructor(inner: ChatModel, options: ContextBudgetOptions = {}) {
    this.inner = inner;
    this.name = inner.name;
    this.model = inner.model;
    this.supportsTools = inner.supportsTools;
    this.maxTokens = options.maxTokens ?? 32_000;
    this.maxToolResultTokens = options.maxToolResultTokens ?? 2_000;
    this.keepRecentGroups = options.keepRecentGroups ?? 4;
    this.summarizer =
      options.summarizer ??
      (options.summarize === false ? null : createModelSummarizer(inner));
  }

  /** 最近一次收缩的统计，供评测报告使用 */
  get lastStats(): ContextStats | null {
    return this.lastStatsValue ? { ...this.lastStatsValue } : null;
  }

  /** 把一份完整历史收缩到预算内。公开出来是为了能单独测试，不必跑整轮循环。 */
  async fit(messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
    const tokensBefore = estimateMessagesTokens(messages);

    const truncated = truncateToolMessages(messages, { maxTokens: this.maxToolResultTokens });
    let working = truncated.messages;

    let droppedGroups = 0;
    let summarized = false;
    let summarizerFailed = false;

    if (estimateMessagesTokens(working) > this.maxTokens) {
      const plan = planSlidingWindow(working, {
        maxTokens: this.maxTokens,
        keepRecentGroups: this.keepRecentGroups,
      });
      droppedGroups = plan.dropped.length;

      if (plan.dropped.length > 0) {
        const keptMessages = [...plan.system, ...plan.kept.flat()];
        if (this.summarizer) {
          try {
            const summary = await this.summarizer(renderTranscript(plan.dropped));
            working = [...plan.system, buildSummaryMessage(summary), ...plan.kept.flat()];
            summarized = true;
          } catch {
            // 摘要失败不能拖垮整轮任务：降级为直接丢弃
            summarizerFailed = true;
            working = keptMessages;
          }
        } else {
          working = keptMessages;
        }
      }
    }

    // 摘要本身也可能超预算：此时预算优先于「保留最近 N 组」的偏好，只保最后一组。
    // keepRecentGroups 是偏好下限，而 maxTokens 是硬上限——两者冲突时上限赢。
    if (estimateMessagesTokens(working) > this.maxTokens) {
      working = applySlidingWindow(working, {
        maxTokens: this.maxTokens,
        keepRecentGroups: 1,
      }).messages;
    }

    // 最后手段：把留下来的工具结果继续对折，直到进预算或触底
    let perTool = this.maxToolResultTokens;
    while (estimateMessagesTokens(working) > this.maxTokens && perTool > MIN_TOOL_RESULT_TOKENS) {
      perTool = Math.max(MIN_TOOL_RESULT_TOKENS, Math.floor(perTool / 2));
      working = truncateToolMessages(working, { maxTokens: perTool }).messages;
    }

    const tokensAfter = estimateMessagesTokens(working);
    this.lastStatsValue = {
      tokensBefore,
      tokensAfter,
      truncatedResults: truncated.truncatedCount,
      droppedChars: truncated.droppedChars,
      droppedGroups,
      summarized,
      summarizerFailed,
      overBudget: tokensAfter > this.maxTokens,
    };

    return working;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = await this.fit(request.messages);
    return this.inner.chat({ ...request, messages });
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const messages = await this.fit(request.messages);
    yield* this.inner.chatStream({ ...request, messages });
  }
}

export function withContextBudget(
  model: ChatModel,
  options: ContextBudgetOptions = {},
): ContextManagedChatModel {
  return new ContextManagedChatModel(model, options);
}
