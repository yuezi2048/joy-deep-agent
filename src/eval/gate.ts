import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildReport, reportMeta, runAllScenarios, type EvalReport } from './run.js';
import type { RunObservation } from './metrics.js';

/**
 * 评测门禁（#9）：把 #8 的评测接进 CI，防止后续改动把防护悄悄改退化。
 *
 * 判据只有一条硬线——**加固侧不许比基线差**——外加一条总体达标线。
 * token 只记录、不设门禁：它是「代价列」，涨了要人看，不该直接拦提交。
 */

/**
 * 总体达标线默认值：加固侧完成率不得低于它。
 *
 * 依据不是拍脑袋的整数：2026-09-30 的实测（`docs/eval/report-2026-09-30.md`）
 * 加固侧 45/45 完成，8 类故障逐类都是 5/5；**任一类**退化都会让总体跌破 1。
 * 假供应商是确定性的，所以这条线是精确可测的，不是统计近似。
 * 将来若引入非确定性（真实模型 / 随机故障），必须按重复次数重新定线。
 */
export const DEFAULT_MIN_COMPLETION = 1;

export interface GateOptions {
  /** 总体完成率达标线，取值区间 [0, 1]；缺省用 `EVAL_MIN_COMPLETION` 或 `DEFAULT_MIN_COMPLETION` */
  minCompletion?: number;
  /**
   * 重复次数，缺省 1。
   * 假供应商确定性，1 次就足以判定「退没退化」；重复多次只为报告里的恢复时间分布服务（那是 `pnpm eval` 的事）。
   */
  repeats?: number;
  now?: () => number;
}

export interface GateViolation {
  /** 违规位置：场景 id，或 `总体` */
  scope: string;
  metric: 'completion' | 'recovery';
  /** 加固侧实测值 */
  hardened: number;
  /** 基线实测值；达标线违规时为 null */
  baseline: number | null;
  /** 可读的一句：哪一类退了、差多少 */
  detail: string;
}

export interface GateResult {
  passed: boolean;
  minCompletion: number;
  violations: GateViolation[];
  report: EvalReport;
}

/** 纯函数判据：只吃观测，不跑模型，便于单测。 */
export function evaluateGate(
  observations: readonly RunObservation[],
  options: { minCompletion?: number; meta?: EvalReport['meta'] } = {},
): GateResult {
  const minCompletion = options.minCompletion ?? DEFAULT_MIN_COMPLETION;
  const report = buildReport(observations, options.meta ?? reportMeta('(未记录)', 1));
  const violations: GateViolation[] = [];

  // 1) 逐场景：加固不许低于基线
  for (const summary of report.summaries) {
    const baseline = summary.baseline.completionRate;
    const hardened = summary.hardened.completionRate;
    if (baseline === null || hardened === null || hardened >= baseline) continue;
    violations.push({
      scope: summary.scenario,
      metric: 'completion',
      hardened,
      baseline,
      detail:
        `${summary.scenario}：完成率 ${percent(baseline)} → ${percent(hardened)}` +
        `（${signedPp(hardened - baseline)}），加固侧已经不比基线好`,
    });
  }

  // 2) 总体：达标线
  const overallHardened = report.overall.hardened.completionRate;
  if (overallHardened === null || overallHardened < minCompletion) {
    violations.push({
      scope: '总体',
      metric: 'completion',
      hardened: overallHardened ?? 0,
      baseline: null,
      detail:
        `总体完成率 ${overallHardened === null ? '无样本' : percent(overallHardened)}` +
        `，低于达标线 ${percent(minCompletion)}` +
        `（${report.overall.hardened.completed}/${report.overall.hardened.runs}）`,
    });
  }

  // 3) 总体：恢复成功率不许低于基线（基线没样本时跳过，不做无米之炊）
  const baselineRecovery = report.overall.baseline.recoveryRate;
  const hardenedRecovery = report.overall.hardened.recoveryRate;
  if (baselineRecovery !== null && hardenedRecovery !== null && hardenedRecovery < baselineRecovery) {
    violations.push({
      scope: '总体',
      metric: 'recovery',
      hardened: hardenedRecovery,
      baseline: baselineRecovery,
      detail:
        `总体恢复成功率 ${percent(baselineRecovery)} → ${percent(hardenedRecovery)}` +
        `（${signedPp(hardenedRecovery - baselineRecovery)}）`,
    });
  }

  return { passed: violations.length === 0, minCompletion, violations, report };
}

/** 跑一遍评测再判门禁。 */
export async function runGate(options: GateOptions = {}): Promise<GateResult> {
  const repeats = options.repeats ?? 1;
  const observations = await runAllScenarios({ repeats, ...(options.now ? { now: options.now } : {}) });
  const meta = reportMeta('(门禁运行，未落盘)', repeats);
  return evaluateGate(observations, {
    ...(options.minCompletion !== undefined ? { minCompletion: options.minCompletion } : {}),
    meta,
  });
}

/** 人读的门禁输出：没退化时给一行结论 + 关键数字，退化时逐条列出差在哪。 */
export function renderGateReport(result: GateResult): string {
  const { report, violations, minCompletion } = result;
  const lines: string[] = [];
  const overall = report.overall;

  lines.push(`评测门禁：${result.passed ? '通过' : '未通过'}`);
  lines.push('');
  lines.push(
    `总体完成率：加固 ${percent(overall.hardened.completionRate)}` +
      `（${overall.hardened.completed}/${overall.hardened.runs}）` +
      ` vs 基线 ${percent(overall.baseline.completionRate)}` +
      `（${overall.baseline.completed}/${overall.baseline.runs}），达标线 ${percent(minCompletion)}`,
  );
  lines.push(
    `总体恢复成功率：加固 ${percent(overall.hardened.recoveryRate)}` +
      `（${overall.hardened.faultsAbsorbed}/${overall.hardened.faultsInjected}）` +
      ` vs 基线 ${percent(overall.baseline.recoveryRate)}` +
      `（${overall.baseline.faultsAbsorbed}/${overall.baseline.faultsInjected}）`,
  );
  lines.push(`异常退出：加固 ${overall.hardened.errored} vs 基线 ${overall.baseline.errored}`);
  lines.push(
    `token 均值：加固 ${overall.hardened.meanTokens ?? '—'} vs 基线 ${overall.baseline.meanTokens ?? '—'}` +
      `（代价列，只记录不拦）`,
  );

  if (violations.length > 0) {
    lines.push('');
    lines.push('退化的地方：');
    for (const violation of violations) lines.push(`- ${violation.detail}`);
  }
  lines.push('');
  return lines.join('\n');
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(0)}%`;
}

function signedPp(delta: number): string {
  const pp = Math.round(delta * 100);
  return `${pp > 0 ? '+' : ''}${pp}pp`;
}

/** 解析命令行：`--min-completion=0.9`、`--repeats=3`，也认环境变量 `EVAL_MIN_COMPLETION`。 */
export function parseGateArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): GateOptions {
  const options: GateOptions = {};
  const fromEnv = env.EVAL_MIN_COMPLETION;
  if (fromEnv !== undefined && fromEnv !== '') options.minCompletion = parseRate(fromEnv, 'EVAL_MIN_COMPLETION');

  for (const arg of argv) {
    if (arg.startsWith('--min-completion=')) {
      options.minCompletion = parseRate(arg.slice('--min-completion='.length), '--min-completion');
    } else if (arg.startsWith('--repeats=')) {
      const repeats = Number(arg.slice('--repeats='.length));
      if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`--repeats 必须是正整数：${arg}`);
      options.repeats = repeats;
    } else {
      throw new Error(`无法识别的参数：${arg}（支持 --min-completion=0.9 / --repeats=1）`);
    }
  }
  return options;
}

function parseRate(raw: string, source: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${source} 必须是 [0, 1] 之间的数，收到：${raw}`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseGateArgs(process.argv.slice(2));
  const result = await runGate(options);
  process.stdout.write(renderGateReport(result));
  if (!result.passed) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
