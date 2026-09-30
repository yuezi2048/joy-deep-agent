/**
 * 编排入口（ADR-0007）：`pnpm run report -- "<目标>"`。
 *
 * 一次跑完整条链：Planner 拆解 → 检索 / 分析 / 写作子智能体分波并发 → 主模型汇总 → 落盘。
 * 与 `src/cli.ts`（单 agent REPL）的区别是这里的产物是一份报告，而不是一段对话。
 */
import 'dotenv/config';
import { errorMessage } from './core/errors.js';
import { createMemoryStore, type MemoryStore } from './memory/index.js';
import {
  BUILTIN_ROLES,
  Supervisor,
  type OrchestrationResult,
  type SupervisorEvent,
} from './orchestrator/index.js';
import { buildProviders, type ProviderConfig } from './providers/index.js';
import { createAgentRuntime, type AgentRuntime } from './runtime.js';
import { formatPreflightReport, runPreflight } from './security/preflight.js';
import { DEFAULT_ALLOWED_COMMANDS } from './tools/builtin/index.js';

export const USAGE = `用法：pnpm run report -- "<目标>"

Planner 拆解 → 子智能体分波并发 → 主模型汇总 → 落盘（Markdown + JSON）。
环境变量：AGENT_MEMORY（缺省 memory；想跨次累积长期记忆就设 file）、AGENT_MEMORY_DIR、
         AGENT_MEMORY_SCOPE、AGENT_REPORT_DIR、AGENT_MAX_PARALLEL、AGENT_PLAN_MAX_STEPS、
         AGENT_SKILLS_DIR、AGENT_SKILL_TOKENS、AGENT_WRITE_ROOT、AGENT_MAX_*（写盘配额）。`;

export interface OrchestrateOptions {
  goal: string;
  /** 工作区根目录，同时是报告落盘的边界；缺省当前目录 */
  workspaceRoot?: string;
  /** 报告子目录；缺省 `AGENT_REPORT_DIR` 或 `.joy-agent/reports` */
  reportDir?: string;
  /** 长期记忆后端；缺省按 `AGENT_MEMORY`（缺省 file）建 */
  memory?: MemoryStore;
  /** 长期记忆的 scope；缺省 `AGENT_MEMORY_SCOPE` 或 `default` */
  memoryScope?: string;
  /** 已装配的运行时（测试注入）；不传就按环境变量现场装配 */
  runtime?: AgentRuntime;
  /** 已装配的供应商集合（测试注入）；不传就读环境变量 */
  providers?: readonly ProviderConfig[];
  /** 波内并发上限；缺省 `AGENT_MAX_PARALLEL` 或 3 */
  maxParallel?: number;
  /** 计划步骤上限；缺省 `AGENT_PLAN_MAX_STEPS` 或 6 */
  maxPlanSteps?: number;
  out?: (line: string) => void;
}

/**
 * 跑一次编排。环境不可用（比如一个 API Key 都没配）时**返回 null 并打印可读提示**，
 * 而不是抛栈——入口的第一职责是告诉人「哪里没配好」。
 */
export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrationResult | null> {
  const out = options.out ?? ((line: string) => console.log(line));
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const reportDir = options.reportDir ?? process.env.AGENT_REPORT_DIR ?? '.joy-agent/reports';

  let runtime = options.runtime;
  let owned = false;

  if (!runtime) {
    const providers = options.providers ?? buildProviders();
    if (providers.length === 0) {
      out('没有可用的模型供应商：请在 .env 里至少配置一个 API Key（参考 .env.example）。');
      out('本地模型可以设 USE_OLLAMA=true，用 Ollama 跑。');
      return null;
    }
    runtime = await createAgentRuntime({ workspaceRoot });
    owned = true;
  }

  try {
    const forkTools = runtime.forkTools;
    if (!forkTools) {
      throw new Error('运行时没有提供 forkTools：编排层无法给子智能体派生独立的工具集');
    }

    // 后端缺省值与服务侧一致（memory）。CLI 每次进程只跑一个任务，内存后端下长期记忆
    // 写得进读不回，所以这里如实提示一句，而不是偷偷换一个别的缺省值。
    const memoryKind = (process.env.AGENT_MEMORY ?? 'memory').trim().toLowerCase();
    const memory =
      options.memory ??
      createMemoryStore({
        kind: memoryKind,
        ...(process.env.AGENT_MEMORY_DIR ? { dir: process.env.AGENT_MEMORY_DIR } : {}),
      });
    if (!options.memory && memoryKind !== 'file') {
      out('ℹ️  长期记忆后端是 memory：只在本次进程内有效，想跨次累积请设 AGENT_MEMORY=file。');
    }

    const supervisor = new Supervisor({
      model: runtime.model,
      roles: BUILTIN_ROLES,
      forkTools,
      workspaceRoot,
      outputDir: reportDir,
      maxConcurrency: options.maxParallel ?? readPositiveInt('AGENT_MAX_PARALLEL', 3),
      maxPlanSteps: options.maxPlanSteps ?? readPositiveInt('AGENT_PLAN_MAX_STEPS', 6),
      memoryScope: options.memoryScope ?? process.env.AGENT_MEMORY_SCOPE ?? 'default',
      recall: (scope, limit) => memory.recall(scope, limit),
      remember: (scope, entry) => memory.remember(scope, entry),
      ...(runtime.loopOptions?.augmentPrompt
        ? { augmentPrompt: runtime.loopOptions.augmentPrompt }
        : {}),
      onEvent: (event) => printEvent(event, out),
    });

    out(`🧭 目标：${options.goal}`);
    const writable = runtime.sandbox?.writableMounts() ?? [];
    if (writable.length > 0) {
      // 子智能体一个写盘工具都没有（落盘由编排层单点执行），这里说的是内置工具那条路的口子
      out(
        `🔒 沙箱可写范围：${writable.map((mount) => mount.label).join('、')}` +
          `（子智能体无写盘工具，报告由编排层落盘）`,
      );
    }
    const { skills, problems } = (await runtime.skills?.load()) ?? { skills: [], problems: [] };
    if (skills.length > 0) {
      out(
        `📚 技能 ${skills.length} 个：${skills.map((skill) => skill.name).join('、')}（命中触发条件才注入）`,
      );
    }
    for (const problem of problems) out(`⚠️  技能 ${problem.source} 没加载：${problem.detail}`);
    const result = await supervisor.run(options.goal);
    for (const line of summarize(result)) out(line);
    return result;
  } finally {
    if (owned) await runtime.close?.();
  }
}

function printEvent(event: SupervisorEvent, out: (line: string) => void): void {
  switch (event.type) {
    case 'planned':
      out('');
      out(
        `📋 计划（${event.source === 'planned' ? '模型规划' : '降级单步'}，${event.steps} 步）` +
          (event.note ? `：${event.note}` : ''),
      );
      for (const step of event.plan.steps) {
        const deps = step.dependsOn?.length ? `  ← ${step.dependsOn.join('、')}` : '';
        out(`   ${step.id} · ${step.role}：${collapse(step.task)}${deps}`);
      }
      return;
    case 'wave':
      out('');
      out(`⚙️  第 ${event.index + 1} 波并发：${event.stepIds.join('、')}`);
      return;
    case 'step':
      out(`   ${statusIcon(event.status)} ${event.stepId} · ${event.role}（${event.durationMs}ms）`);
      return;
    case 'synthesized':
      out(`\n🧩 汇总：${event.degraded ? '确定性拼接（汇总模型未跑成）' : '模型汇总'}`);
      return;
    case 'reported':
      for (const file of event.files) out(`📄 报告：${file}`);
      return;
  }
}

function summarize(result: OrchestrationResult): string[] {
  const succeeded = result.steps.filter((step) => step.status === 'succeeded').length;
  const lines = [`\n✅ ${succeeded}/${result.steps.length} 步成功（${result.durationMs}ms）`];

  for (const step of result.steps) {
    lines.push(
      `   ${statusIcon(step.status)} ${step.stepId} · ${step.role} · ${step.usage.totalTokens ?? 0} token${
        step.detail ? ` · ${collapse(step.detail)}` : ''
      }`,
    );
  }

  lines.push(
    `💰 token：规划 ${result.planUsage.totalTokens ?? 0} · 子智能体 ${
      result.subAgentUsage.totalTokens ?? 0
    } · 汇总 ${result.synthesisUsage.totalTokens ?? 0}（总 ${result.usage.totalTokens ?? 0}）`,
  );
  if (result.files.length === 0) lines.push('📄 报告：未落盘（没配输出目录）');
  return lines;
}

function statusIcon(status: 'succeeded' | 'failed' | 'skipped'): string {
  return status === 'succeeded' ? '✅' : status === 'failed' ? '❌' : '⏭️';
}

function collapse(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数，收到 "${raw}"`);
  }
  return parsed;
}

/**
 * 从 argv 解析目标。
 *
 * `pnpm run report -- "<目标>"` 里的 `--` 会被 pnpm **原样传给脚本**（npm 会自己剥掉），
 * 所以这里只剥掉**首个** `--`：两种包管理器下的写法都能得到干净的目标，
 * 也不会误伤目标正文里出现的 `--`。
 */
export function parseGoal(argv: readonly string[]): string {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  return args.join(' ').trim();
}

async function main(): Promise<void> {
  const goal = parseGoal(process.argv.slice(2));
  if (!goal) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const preflight = await runPreflight({
    workspaceRoot: process.cwd(),
    allowedCommands: DEFAULT_ALLOWED_COMMANDS,
  });
  if (!preflight.ok) {
    console.error(formatPreflightReport(preflight));
    process.exitCode = 1;
    return;
  }

  const result = await orchestrate({ goal });
  if (!result) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`编排失败：${errorMessage(error)}`);
  process.exitCode = 1;
});
