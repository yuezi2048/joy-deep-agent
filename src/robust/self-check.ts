import { errorMessage } from '../core/errors.js';
import type { ChatMessage } from '../core/types.js';
import type { ChatModel } from '../providers/chat-model.js';
import { parseToolArguments } from '../tools/arguments.js';

/**
 * 自我核查（对应「幻觉」一类里的输出侧第二层）。
 *
 * 来源约束只能查「标注对不对」，查不出「没有标注、但把观测里没有的数字当事实说」。
 * 所以在交付前再走一次核查：把用户问题、工具观测、待交付答案交给一个核查模型，
 * 让它只挑「没有依据的断言」，不挑措辞。核查不通过就把具体问题回灌给主模型修正。
 *
 * 核查不通过**不直接改答案**：改写由主模型做，核查器只负责指出问题——
 * 让「生成」和「判断」分离，避免核查器自己编一套结论。
 */

export interface SelfCheckVerdict {
  ok: boolean;
  issues: string[];
  /** 核查器输出没法解析 / 调用失败：这次可能根本没检查过，如实上报而不是假装通过 */
  degraded: boolean;
  /** 降级原因，写进结果里便于排查 */
  degradedReason?: string;
}

export interface SelfCheckInput {
  question: string;
  answer: string;
  messages: readonly ChatMessage[];
}

export interface SelfCheckerOptions {
  /** 每条工具观测送进核查上下文时的字符上限 */
  maxObservationChars?: number;
  maxTokens?: number;
}

const CHECK_SYSTEM_PROMPT = [
  '你是 Agent 交付前的核查员，只做一件事：判断待交付答案里的关键结论是否由工具观测支撑。',
  '只报这几类问题：',
  '1) 引用了观测里没有的来源或工具名；',
  '2) 把观测里没有的数据 / 事实当成已确认的事实陈述；',
  '3) 工具观测是失败或报错，却被当成成功结论。',
  '不要因为措辞、排版、语气、缺少额外背景而报问题；有依据的正常结论必须放行。',
  '只输出 JSON，不要任何解释：{"ok": true, "issues": []} 或 {"ok": false, "issues": ["具体问题"]}。',
].join('\n');

export class SelfChecker {
  private readonly maxObservationChars: number;
  private readonly maxTokens: number;

  constructor(
    private readonly model: ChatModel,
    options: SelfCheckerOptions = {},
  ) {
    this.maxObservationChars = options.maxObservationChars ?? 1_000;
    this.maxTokens = options.maxTokens ?? 512;
  }

  async check(input: SelfCheckInput, signal?: AbortSignal): Promise<SelfCheckVerdict> {
    const request = {
      messages: [
        { role: 'system' as const, content: CHECK_SYSTEM_PROMPT },
        {
          role: 'user' as const,
          content: [
            `【用户问题】\n${input.question}`,
            `【工具观测】\n${this.renderObservations(input.messages)}`,
            `【待交付答案】\n${input.answer}`,
          ].join('\n\n'),
        },
      ],
      temperature: 0,
      maxTokens: this.maxTokens,
      ...(signal ? { signal } : {}),
    };

    let raw: string;
    try {
      const response = await this.model.chat(request);
      raw = response.content;
    } catch (error) {
      return {
        ok: true,
        issues: [],
        degraded: true,
        degradedReason: `核查器调用失败：${errorMessage(error)}`,
      };
    }

    const parsed = parseToolArguments(raw);
    const ok = parsed.value.ok;
    if (typeof ok !== 'boolean') {
      return {
        ok: true,
        issues: [],
        degraded: true,
        degradedReason: `核查器没有给出可用结论（输出不是 {ok, issues} JSON）：${raw.slice(0, 80)}`,
      };
    }
    if (ok) return { ok: true, issues: [], degraded: false };

    const issues = Array.isArray(parsed.value.issues)
      ? parsed.value.issues.filter((issue): issue is string => typeof issue === 'string')
      : [];
    return {
      ok: false,
      issues: issues.length > 0 ? issues : ['核查未通过，但没有说明具体问题，请复核关键结论是否有观测支撑'],
      degraded: false,
    };
  }

  private renderObservations(messages: readonly ChatMessage[]): string {
    const observations = messages.filter((message) => message.role === 'tool');
    if (observations.length === 0) return '（本次没有调用任何工具）';

    return observations
      .map((message) => {
        const content = message.content.length > this.maxObservationChars
          ? `${message.content.slice(0, this.maxObservationChars)}…（已截断）`
          : message.content;
        return `<${message.name ?? 'tool'}#${message.toolCallId ?? '?'}>\n${content}`;
      })
      .join('\n\n');
  }
}
