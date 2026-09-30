import type { ChatModel } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { addUsage, type Usage } from '../core/types.js';
import { errorMessage } from '../core/errors.js';
import { truncateToolResult } from '../robust/index.js';
import { Planner } from './planner.js';
import type { Plan, PlanStep } from './plan.js';
import { createSubAgent } from './sub-agent.js';
import type { AgentRole } from './role.js';
import { writeOrchestrationReport } from './report.js';
import type { OrchestrationResult, StepResult, StepStatus } from './types.js';

/**
 * Supervisor：编排层。
 *
 * 一次任务 = 规划一次 + 分波并发跑各子智能体 + 汇总一次。
 * 它自己**不调模型做决策**（除了规划与汇总两次固定调用）：谁跑什么、谁等谁，全由计划决定，
 * 所以行为可复现、可断点、可在测试里断言时序。要更自主的「边跑边改计划」，等真有需求再说。
 */
export interface SupervisorDeps {
  model: ChatModel;
  roles: readonly AgentRole[];
  /** 按角色派生工具集，通常直接传 `AgentRuntime.forkTools` */
  forkTools: (allow?: readonly string[]) => ToolRegistry;
  /** 工作区根目录；同时是报告落盘的边界 */
  workspaceRoot?: string;
  /** 报告子目录；不传则不落盘（评测与单测里常用） */
  outputDir?: string;
  /** 波内并发上限，默认 3 */
  maxConcurrency?: number;
  /** 单个子智能体的步数上限 */
  maxStepsPerAgent?: number;
  /** 单个子智能体的墙钟上限 */
  maxDurationPerAgent?: number;
  /** 计划步骤上限，默认 6 */
  maxPlanSteps?: number;
  /** 规划失败时降级用的角色，默认第一个角色 */
  fallbackRole?: string;
  /** 读长期记忆（注入规划提示） */
  recall?: (scope: string, limit: number) => Promise<string[]>;
  /** 写长期记忆（收尾时落一条本次结果摘要） */
  remember?: (scope: string, entry: string) => Promise<void>;
  memoryScope?: string;
  now?: () => number;
  onEvent?: (event: SupervisorEvent) => void;
}

export type SupervisorEvent =
  | { type: 'planned'; source: 'planned' | 'fallback'; steps: number; note?: string; plan: Plan }
  | { type: 'wave'; index: number; stepIds: string[] }
  | { type: 'step'; stepId: string; role: string; status: StepStatus; durationMs: number }
  | { type: 'synthesized'; degraded: boolean }
  | { type: 'reported'; files: string[] };

export interface SupervisorRunOptions {
  signal?: AbortSignal;
  /** 覆盖 scope，用于把不同任务的长期记忆分开 */
  memoryScope?: string;
}

const DEFAULTS = {
  maxConcurrency: 3,
  maxStepsPerAgent: 6,
  maxDurationPerAgent: 180_000,
  maxPlanSteps: 6,
  /** 注入给下游的单条上游输出上限（token） */
  upstreamTokens: 600,
  /** 长期记忆条数 */
  memoryLimit: 5,
} as const;

export class Supervisor {
  constructor(private readonly deps: SupervisorDeps) {}

  async run(input: string, options: SupervisorRunOptions = {}): Promise<OrchestrationResult> {
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const scope = options.memoryScope ?? this.deps.memoryScope ?? 'default';
    const usage: Usage = {};

    const planned = await this.plan(input, scope, options);
    addUsage(usage, planned.usage);
    this.emit({
      type: 'planned',
      source: planned.planSource,
      steps: planned.plan.steps.length,
      ...(planned.planNote ? { note: planned.planNote } : {}),
      plan: planned.plan,
    });

    const { plan } = planned;
    const steps = await this.execute(plan, usage, options);
    const synthesis = await this.synthesize(plan, steps, options);
    addUsage(usage, synthesis.usage);
    this.emit({ type: 'synthesized', degraded: synthesis.degraded });

    const result: OrchestrationResult = {
      goal: plan.goal,
      plan,
      planSource: planned.planSource,
      ...(planned.planNote ? { planNote: planned.planNote } : {}),
      steps,
      report: synthesis.report,
      synthesisDegraded: synthesis.degraded,
      files: [],
      planUsage: planned.usage,
      subAgentUsage: sumUsage(steps.map((step) => step.usage)),
      synthesisUsage: synthesis.usage,
      usage,
      startedAt,
      durationMs: now() - startedAt,
    };

    if (this.deps.outputDir && this.deps.workspaceRoot) {
      const files = await writeOrchestrationReport(result, {
        workspaceRoot: this.deps.workspaceRoot,
        outputDir: this.deps.outputDir,
        ...(this.deps.now ? { now: () => new Date(this.deps.now!()) } : {}),
      });
      result.files = [files.markdown, files.json];
      this.emit({ type: 'reported', files: result.files });
    }

    if (this.deps.remember) {
      const digest = truncateToolResult(synthesis.report, { maxTokens: 160 }).content.replace(/\s+/g, ' ').trim();
      await this.deps.remember(scope, `【${plan.goal}】${digest}`);
    }

    return result;
  }

  /** 规划。失败时按「解析归解析、策略归调用方」降级成单步计划，并把原因记进 planNote。 */
  private async plan(
    input: string,
    scope: string,
    options: SupervisorRunOptions,
  ): Promise<{ plan: Plan; planSource: 'planned' | 'fallback'; planNote?: string; usage: Usage }> {
    const usage: Usage = {};
    const planner = new Planner({
      model: this.deps.model,
      roles: this.deps.roles,
      ...(this.deps.maxPlanSteps !== undefined ? { maxSteps: this.deps.maxPlanSteps } : {}),
    });

    const memories = this.deps.recall ? await this.deps.recall(scope, DEFAULTS.memoryLimit) : [];
    const outcome = await planner.plan({
      input,
      memories,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    addUsage(usage, outcome.usage);

    if (outcome.kind === 'planned') {
      return {
        plan: outcome.plan,
        planSource: 'planned',
        usage,
        ...(outcome.repaired ? { planNote: '规划输出经过规范化（补齐过步骤 id）' } : {}),
      };
    }

    const role = this.fallbackRole();
    return {
      plan: { goal: input, steps: [{ id: 's1', role: role.name, task: input }] },
      planSource: 'fallback',
      planNote: `规划不可用（${outcome.code}）：${outcome.detail}。已降级为单步计划，交给「${role.title}」角色`,
      usage,
    };
  }

  /**
   * 分波执行：每一波是所有「依赖已成功」的步骤，波内并发、波间串行。
   * 依赖没成功的步骤标 skipped，不抛异常中断全局——一个分支烂掉不该让整份报告消失。
   */
  private async execute(
    plan: Plan,
    usage: Usage,
    options: SupervisorRunOptions,
  ): Promise<StepResult[]> {
    const now = this.deps.now ?? Date.now;
    const results = new Map<string, StepResult>();
    const pending = new Map(plan.steps.map((step) => [step.id, step]));
    const concurrency = Math.max(1, this.deps.maxConcurrency ?? DEFAULTS.maxConcurrency);
    let waveIndex = 0;

    while (pending.size > 0) {
      const ready: PlanStep[] = [];
      const blocked: Array<{ step: PlanStep; reason: string }> = [];

      for (const step of pending.values()) {
        const failedDeps = (step.dependsOn ?? [])
          .map((id) => results.get(id))
          .filter((result): result is StepResult => result !== undefined && result.status !== 'succeeded');
        if (failedDeps.length > 0) {
          blocked.push({
            step,
            reason: `上游未成功：${failedDeps.map((result) => `${result.stepId}(${result.status})`).join('、')}`,
          });
        } else if ((step.dependsOn ?? []).every((id) => results.get(id)?.status === 'succeeded')) {
          ready.push(step);
        }
      }

      for (const { step, reason } of blocked) {
        pending.delete(step.id);
        results.set(step.id, skipped(step, reason, now()));
        this.emit({ type: 'step', stepId: step.id, role: step.role, status: 'skipped', durationMs: 0 });
      }

      if (ready.length === 0) {
        if (blocked.length === 0) break;
        continue;
      }

      this.emit({ type: 'wave', index: waveIndex++, stepIds: ready.map((step) => step.id) });
      const ran = await mapWithConcurrency(ready, concurrency, (step) =>
        this.runStep(step, results, options),
      );
      for (const result of ran) {
        pending.delete(result.stepId);
        results.set(result.stepId, result);
        addUsage(usage, result.usage);
        this.emit({
          type: 'step',
          stepId: result.stepId,
          role: result.role,
          status: result.status,
          durationMs: result.durationMs,
        });
      }
    }

    return plan.steps.map((step) => results.get(step.id) ?? skipped(step, '未执行', now()));
  }

  private async runStep(
    step: PlanStep,
    done: ReadonlyMap<string, StepResult>,
    options: SupervisorRunOptions,
  ): Promise<StepResult> {
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const role = this.deps.roles.find((item) => item.name === step.role);

    if (!role) {
      return {
        stepId: step.id,
        role: step.role,
        task: step.task,
        status: 'failed',
        output: '',
        detail: `角色 "${step.role}" 未注册`,
        usage: {},
        startedAt,
        durationMs: 0,
      };
    }

    try {
      const tools = this.deps.forkTools(role.allowedTools);
      const agent = createSubAgent({
        role,
        model: this.deps.model,
        tools,
        ...(this.deps.maxStepsPerAgent !== undefined ? { maxSteps: this.deps.maxStepsPerAgent } : {}),
        maxDurationMs: this.deps.maxDurationPerAgent ?? DEFAULTS.maxDurationPerAgent,
        ...(this.deps.now ? { now: this.deps.now } : {}),
      });

      const result = await agent.run(withUpstream(step, done), {
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const succeeded = result.stopReason === 'completed';
      return {
        stepId: step.id,
        role: step.role,
        task: step.task,
        status: succeeded ? 'succeeded' : 'failed',
        output: result.content,
        ...(succeeded ? {} : { detail: `子智能体未正常收尾（${result.stopReason}${result.stopDetail ? `：${result.stopDetail}` : ''}）` }),
        stopReason: result.stopReason,
        usage: result.usage,
        startedAt,
        durationMs: now() - startedAt,
      };
    } catch (error) {
      return {
        stepId: step.id,
        role: step.role,
        task: step.task,
        status: 'failed',
        output: '',
        detail: `子智能体抛错：${errorMessage(error)}`,
        usage: {},
        startedAt,
        durationMs: now() - startedAt,
      };
    }
  }

  /** 汇总。模型那一步没跑成就退化成确定性拼接，并如实置位 `degraded`。 */
  private async synthesize(
    plan: Plan,
    steps: readonly StepResult[],
    options: SupervisorRunOptions,
  ): Promise<{ report: string; degraded: boolean; usage: Usage }> {
    const usage: Usage = {};
    const sections = steps
      .filter((step) => step.output.trim())
      .map((step) => `## ${step.stepId} · ${step.role}（任务：${step.task}）\n${step.output.trim()}`);

    const missing = steps.filter((step) => !step.output.trim());

    try {
      const response = await this.deps.model.chat({
        messages: [
          {
            role: 'system',
            content: [
              '你是汇总器。把各步子智能体的产出收敛成一份完整的 Markdown 报告。',
              '直接输出报告正文：不要写文件名，不要写「以下是报告」这类元话术。',
              '互相矛盾的地方如实指出，不要抹平。',
              '产出缺失的部分要明确标注缺了什么、为什么缺，绝不假装有结果。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `目标：${plan.goal}`,
              '',
              sections.length > 0 ? sections.join('\n\n') : '（各步都没有产出）',
              missing.length > 0
                ? `\n\n以下步骤没有产出，请在报告里如实说明：\n${missing.map((step) => `- ${step.stepId} · ${step.role}（${step.status}${step.detail ? `：${step.detail}` : ''}）`).join('\n')}`
                : '',
            ].join('\n'),
          },
        ],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      addUsage(usage, response.usage);

      const content = response.content?.trim();
      if (content) return { report: content, degraded: false, usage };
      return { report: fallbackReport(plan, steps), degraded: true, usage };
    } catch {
      return { report: fallbackReport(plan, steps), degraded: true, usage };
    }
  }

  private fallbackRole(): AgentRole {
    const role = this.deps.fallbackRole
      ? this.deps.roles.find((item) => item.name === this.deps.fallbackRole)
      : this.deps.roles[0];
    if (!role) throw new Error('Supervisor 需要至少一个角色；roles 是空的');
    return role;
  }

  private emit(event: SupervisorEvent): void {
    this.deps.onEvent?.(event);
  }
}

function skipped(step: PlanStep, reason: string, startedAt: number): StepResult {
  return {
    stepId: step.id,
    role: step.role,
    task: step.task,
    status: 'skipped',
    output: '',
    detail: reason,
    usage: {},
    startedAt,
    durationMs: 0,
  };
}

/** 把上游结果按 token 预算截断后拼进子任务；不截断的话上游会把下游的上下文冲爆（原型的另一条教训）。 */
function withUpstream(step: PlanStep, done: ReadonlyMap<string, StepResult>): string {
  const dependencies = step.dependsOn ?? [];
  if (dependencies.length === 0) return step.task;

  const blocks = dependencies.map((id) => {
    const result = done.get(id);
    if (!result) return `## ${id}\n（上游结果缺失）`;
    const bounded = truncateToolResult(result.output, { maxTokens: DEFAULTS.upstreamTokens });
    return `## ${id} · ${result.role}\n${bounded.content}`;
  });

  return [
    step.task,
    '',
    '--- 以下是上游步骤的结果，供你参考（不是要你复述）：',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** token 按字段相加，缺项当 0；数字只在报告里出现，不影响控制流。 */
function sumUsage(items: readonly Usage[]): Usage {
  const total: Usage = {};
  for (const item of items) addUsage(total, item);
  return total;
}

function fallbackReport(plan: Plan, steps: readonly StepResult[]): string {
  const lines = [`# ${plan.goal}`, '', '> 汇总模型未跑成，以下是各步产出的原始拼接。', ''];
  for (const step of steps) {
    lines.push(`## ${step.stepId} · ${step.role}`, '');
    if (step.output.trim()) lines.push(step.output.trim(), '');
    else lines.push(`（本步没有产出：${step.status}${step.detail ? ` — ${step.detail}` : ''}）`, '');
  }
  return lines.join('\n').trimEnd();
}

/** 有界并发的 map：结果顺序与输入一致，避免报告里步骤顺序随并发抖动。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
