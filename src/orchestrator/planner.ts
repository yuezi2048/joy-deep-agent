import type { ChatModel, FinishReason } from '../providers/index.js';
import type { Usage } from '../core/types.js';
import { parseToolArguments } from '../tools/arguments.js';
import { DEFAULT_MAX_STEPS, parsePlan, type Plan } from './plan.js';
import type { AgentRole } from './role.js';

/**
 * Planner：把一句请求拆成可独立推进的计划。
 *
 * 只负责「产出 + 校验」，不负责「产出不出来怎么办」——
 * 降级成单步计划是 `Supervisor` 的策略（原型复盘：解析归解析，策略归调用方）。
 */
export interface PlannerOptions {
  model: ChatModel;
  roles: readonly AgentRole[];
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface PlanRequest {
  /** 本次请求 */
  input: string;
  /** 长期记忆条目（来自 `MemoryStore.recall`），会注入提示帮助规划 */
  memories?: readonly string[];
  signal?: AbortSignal;
}

/**
 * 规划结果。失败也走返回值而不是抛异常：计划失败是可预期的（模型可能被截断、
 * 可能吐出半截 JSON），调用方需要的是「为什么失败」而不是一个栈。
 */
export type PlanOutcome =
  | { kind: 'planned'; plan: Plan; repaired: boolean; usage?: Usage }
  | { kind: 'unplanned'; code: PlanFailureCode; detail: string; raw: string; usage?: Usage };

/** `truncated` 与另外两个分开：截断是「模型没写完」，不是「解析不了」——修法完全不同。 */
export type PlanFailureCode = 'truncated' | 'unparseable' | 'invalid' | 'empty';

export class Planner {
  constructor(private readonly options: PlannerOptions) {}

  async plan(request: PlanRequest): Promise<PlanOutcome> {
    const response = await this.options.model.chat({
      messages: [
        {
          role: 'system',
          content: buildPlannerPrompt(
            this.options.roles,
            request.memories ?? [],
            this.options.maxSteps ?? DEFAULT_MAX_STEPS,
          ),
        },
        { role: 'user', content: request.input },
      ],
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const raw = response.content ?? '';
    const usage = response.usage;
    const withUsage = usage ? { usage } : {};

    if (!raw.trim()) {
      return { kind: 'unplanned', code: 'empty', detail: '规划模型没有返回任何内容', raw, ...withUsage };
    }

    // 截断优先判：半截 JSON 在解析器看来只是「格式不对」，会把真正的原因埋掉
    if (response.finishReason === 'length') {
      return {
        kind: 'unplanned',
        code: 'truncated',
        detail: `规划输出被 max_tokens 截断（finish_reason=length），计划不完整${
          this.options.maxTokens ? `（max_tokens=${this.options.maxTokens}）` : ''
        }`,
        raw,
        ...withUsage,
      };
    }

    const extracted = parseToolArguments(raw);
    if (extracted.error) {
      return { kind: 'unplanned', code: 'unparseable', detail: extracted.error, raw, ...withUsage };
    }

    const parsed = parsePlan(extracted.value, {
      roles: this.options.roles,
      ...(this.options.maxSteps !== undefined ? { maxSteps: this.options.maxSteps } : {}),
    });
    if (!parsed.ok) {
      return { kind: 'unplanned', code: 'invalid', detail: parsed.detail, raw, ...withUsage };
    }

    return { kind: 'planned', plan: parsed.plan, repaired: parsed.repaired || extracted.repaired, ...withUsage };
  }
}

export function buildPlannerPrompt(
  roles: readonly AgentRole[],
  memories: readonly string[],
  maxSteps = DEFAULT_MAX_STEPS,
): string {
  const roleLines = roles.map((role) => {
    const tools = role.allowedTools === undefined ? '全部工具' : role.allowedTools.length > 0 ? role.allowedTools.join('、') : '无工具';
    return `- ${role.name}（${role.title}）：${role.description}【可用工具：${tools}】`;
  });

  const memoryBlock =
    memories.length > 0
      ? ['', '已知的长期记忆（规划时可以参考，但不要当成待办事项）：', ...memories.map((item) => `- ${item}`)]
      : [];

  return [
    '你是任务规划器。把用户请求拆成若干**可独立推进**的子任务，交给专门的子智能体执行。',
    '',
    '可用角色：',
    ...roleLines,
    '',
    '输出要求（只输出 JSON，不要解释、不要 Markdown 围栏）：',
    '{',
    '  "goal": "这次要达成的目标，一句话",',
    '  "steps": [',
    '    { "id": "s1", "role": "上面列出的角色名", "task": "给子智能体的一段清晰指令", "dependsOn": ["依赖的步骤 id"] }',
    '  ]',
    '}',
    '',
    '规则：',
    `- 步骤数不超过 ${maxSteps}；能并行就并行，用 dependsOn 表达真实的先后依赖，不要为了好看加依赖。`,
    '- `role` 只能用上面列出的名字；用别的名字这次规划会被判为无效。',
    '- `task` 要写清目标与产出形式，子智能体看不到用户原话之外的其他上下文。',
    '- 没有依赖的步骤省略 dependsOn。',
    ...memoryBlock,
  ].join('\n');
}
