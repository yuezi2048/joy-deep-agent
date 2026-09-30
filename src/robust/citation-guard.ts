import type { ChatMessage } from '../core/types.js';

/**
 * 来源约束（对应「幻觉」一类里的输出侧）。
 *
 * 参数校验挡得住不合 schema 的工具调用，但挡不住「结论是编的」：
 * 模型完全可能给出一个像模像样、却没有任何观测支撑的答案。
 * 这里做的是**确定性**的那一半——只查来源标注能不能对上真实拿到过的工具结果，
 * 不判断语义。语义那半交给自我核查（`self-check.ts`）。
 */

/** 来源标注写法：`[tool:工具名]`，带上调用 id 写成 `[tool:工具名#id]`。 */
const CITATION_PATTERN = /\[tool:([A-Za-z0-9_.\-/]+)(?:#([A-Za-z0-9_.\-]+))?\]/g;

/** 开启来源约束时追加到 system prompt 的交付要求。 */
export const CITATION_INSTRUCTION =
  '交付要求：结论只要依赖工具结果，就必须用 [tool:工具名] 标注来源（需要精确到某次调用时写 ' +
  '[tool:工具名#调用id]）。只能标注本次真正得到过的来源，不要凭印象编造来源。';

export interface CitationFinding {
  kind: 'unknown-source' | 'missing-citation';
  detail: string;
}

export interface CitationReport {
  /** 答案里出现过的标注（去重前，按出现顺序） */
  citations: string[];
  findings: CitationFinding[];
  ok: boolean;
}

export interface CitationGuardOptions {
  /** 本次用过工具、但答案一个标注都没有时是否算问题（默认 true） */
  requireCitation?: boolean;
}

export interface ToolObservation {
  name: string;
  id?: string;
}

/** 从轨迹里收集「真正拿到过的工具结果」。报错的结果也算拿到过，只是内容不同。 */
export function collectObservations(messages: readonly ChatMessage[]): ToolObservation[] {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => ({ name: message.name ?? '', id: message.toolCallId }));
}

/**
 * 检查答案里的来源标注：
 * - 标注了从没得到过的来源 → `unknown-source`（典型的编造来源）
 * - 用过工具却一个标注都没有 → `missing-citation`（无来源支撑的断言）
 *
 * 纯聊天（本次没用过工具）不检查，避免误伤正常回答。
 */
export function checkCitations(
  answer: string,
  messages: readonly ChatMessage[],
  options: CitationGuardOptions = {},
): CitationReport {
  const observations = collectObservations(messages);
  const citations: string[] = [];
  const findings: CitationFinding[] = [];

  for (const match of answer.matchAll(CITATION_PATTERN)) {
    const name = match[1] as string;
    const id = match[2];
    citations.push(id ? `${name}#${id}` : name);

    const matched = observations.some(
      (observation) => observation.name === name && (!id || observation.id === id),
    );
    if (!matched) {
      findings.push({
        kind: 'unknown-source',
        detail: `答案引用了并不存在的来源 [tool:${id ? `${name}#${id}` : name}]，本次没有拿到过这个工具结果`,
      });
    }
  }

  if (options.requireCitation !== false && citations.length === 0 && observations.length > 0) {
    const names = [...new Set(observations.map((observation) => observation.name))].join(', ');
    findings.push({
      kind: 'missing-citation',
      detail: `本次调用过工具（${names}），但答案里没有任何 [tool:工具名] 来源标注：关键结论需要有来源支撑`,
    });
  }

  return { citations, findings, ok: findings.length === 0 };
}
