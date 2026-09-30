import type { StopReason } from '../core/agent-loop.js';
import type { Usage } from '../core/types.js';

/**
 * 故障注入评测的指标口径（定义见 `docs/eval/metrics.md`）。
 *
 * 这里只做「算」与「渲染」：输入是场景跑出来的原始观测，输出是基线 / 加固并列的报告。
 * 采集那些观测是 `recorder.ts` 的事，跑场景是 #8 的事——三层分开，口径才不会被实现细节带偏。
 */

/** 8 类故障的稳定 key。报告里用它当列，不用中文当键（中文会随文案变）。 */
export const FAULT_CATEGORIES = {
  /** 失败调用：重试 / 超时 / JSON 容错 */
  failedCall: 'failed-call',
  /** 幻觉：参数校验 / 来源约束 / 自我核查 */
  hallucination: 'hallucination',
  /** 工具误用：去重 / 预算 / 依赖序 */
  toolMisuse: 'tool-misuse',
  /** 死循环：步数 / 无进展 / 横跳 / 墙钟 */
  loop: 'loop',
  /** 上下文溢出 */
  contextOverflow: 'context-overflow',
  /** 供应商故障 */
  providerFailure: 'provider-failure',
  /** 用户中断 */
  userInterrupt: 'user-interrupt',
  /** 终端环境异常 */
  terminal: 'terminal',
} as const;

export type FaultCategory = (typeof FAULT_CATEGORIES)[keyof typeof FAULT_CATEGORIES];

/** 对照的两侧：裸循环 vs 全套防护。 */
export type EvalVariant = 'baseline' | 'hardened';

/** 一次注入故障的观测。 */
export interface FaultObservation {
  category: string;
  /** 故障注入时刻（毫秒时间戳） */
  injectedAt: number;
  /** 恢复正常执行的时刻；没恢复则为空——这一条不计入恢复时间 */
  recoveredAt?: number;
  /** 恢复到正常执行消耗的调用次数（含最后成功的那次） */
  attempts?: number;
  /** 是否被吸收：故障发生时任务没有因此终止 */
  absorbed: boolean;
}

/** 一次运行的观测。 */
export interface RunObservation {
  scenario: string;
  variant: EvalVariant;
  /** 场景预先声明的断言结果，不看人 */
  passed: boolean;
  stopReason: StopReason;
  usage?: Usage;
  faults?: readonly FaultObservation[];
}

export interface DurationStats {
  samples: number;
  p50: number;
  max: number;
}

export interface VariantMetrics {
  runs: number;
  completed: number;
  completionRate: number | null;
  faultsInjected: number;
  faultsAbsorbed: number;
  recoveryRate: number | null;
  recoveryMs: DurationStats | null;
  recoveryAttempts: DurationStats | null;
  /** 有 usage 的样本数：均值只按这些样本算 */
  usageSamples: number;
  totalTokens: number;
  meanTokens: number | null;
}

export interface ScenarioDelta {
  /** 百分点 */
  completionRatePp: number | null;
  recoveryRatePp: number | null;
  meanTokensPercent: number | null;
}

export interface ScenarioMetrics {
  scenario: string;
  baseline: VariantMetrics;
  hardened: VariantMetrics;
  delta: ScenarioDelta;
  /** 「本类尚未加固」等缺口标注 */
  gaps: string[];
}

export interface ReportMeta {
  generatedAt?: string;
  /** 脚注：配置口径、退避参数、样本量说明等，原样渲染 */
  notes?: string[];
}

/** 最近秩法：升序排序后取第 ceil(p × n) 个（1 起数）。小样本可复现，不做插值。 */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] as number;
}

export function durationStats(values: readonly number[]): DurationStats | null {
  if (values.length === 0) return null;
  return { samples: values.length, p50: percentile(values, 0.5), max: Math.max(...values) };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function summarizeRuns(runs: readonly RunObservation[]): VariantMetrics {
  const completed = runs.filter((run) => run.passed).length;
  const faults = runs.flatMap((run) => run.faults ?? []);
  const absorbed = faults.filter((fault) => fault.absorbed);
  const recovered = absorbed.filter((fault) => fault.recoveredAt !== undefined);

  const usageValues = runs
    .map((run) => run.usage?.totalTokens)
    .filter((value): value is number => typeof value === 'number');

  return {
    runs: runs.length,
    completed,
    completionRate: runs.length > 0 ? round2(completed / runs.length) : null,
    faultsInjected: faults.length,
    faultsAbsorbed: absorbed.length,
    recoveryRate: faults.length > 0 ? round2(absorbed.length / faults.length) : null,
    recoveryMs: durationStats(
      recovered.map((fault) => (fault.recoveredAt as number) - fault.injectedAt),
    ),
    recoveryAttempts: durationStats(
      recovered
        .map((fault) => fault.attempts)
        .filter((value): value is number => typeof value === 'number'),
    ),
    usageSamples: usageValues.length,
    totalTokens: usageValues.reduce((sum, value) => sum + value, 0),
    meanTokens:
      usageValues.length > 0
        ? Math.round(usageValues.reduce((sum, value) => sum + value, 0) / usageValues.length)
        : null,
  };
}

export function summarizeScenario(
  scenario: string,
  runs: readonly RunObservation[],
  options: { gaps?: readonly string[] } = {},
): ScenarioMetrics {
  const baseline = summarizeRuns(runs.filter((run) => run.variant === 'baseline'));
  const hardened = summarizeRuns(runs.filter((run) => run.variant === 'hardened'));
  return {
    scenario,
    baseline,
    hardened,
    delta: {
      completionRatePp: deltaPp(baseline.completionRate, hardened.completionRate),
      recoveryRatePp: deltaPp(baseline.recoveryRate, hardened.recoveryRate),
      meanTokensPercent: percentDelta(baseline.meanTokens, hardened.meanTokens),
    },
    gaps: [
      ...(options.gaps ?? []),
      ...(hardened.runs === 0 ? ['加固侧没有样本：本场景尚未加固'] : []),
    ],
  };
}

/** 按场景分组汇总；场景顺序按首次出现的顺序，便于报告可复现。 */
export function summarizeAll(
  runs: readonly RunObservation[],
  gapsByScenario: Readonly<Record<string, readonly string[]>> = {},
): ScenarioMetrics[] {
  const scenarios: string[] = [];
  for (const run of runs) if (!scenarios.includes(run.scenario)) scenarios.push(run.scenario);
  return scenarios.map((scenario) =>
    summarizeScenario(
      scenario,
      runs.filter((run) => run.scenario === scenario),
      { gaps: gapsByScenario[scenario] ?? [] },
    ),
  );
}

export function toJsonReport(
  summaries: readonly ScenarioMetrics[],
  meta: ReportMeta = {},
): { meta: ReportMeta; scenarios: ScenarioMetrics[] } {
  return { meta, scenarios: [...summaries] };
}

export function renderMarkdownReport(
  summaries: readonly ScenarioMetrics[],
  meta: ReportMeta = {},
): string {
  const lines: string[] = [];
  lines.push('# 故障注入评测报告');
  lines.push('');
  lines.push(`生成时间：${meta.generatedAt ?? '(未记录)'}`);
  lines.push('');
  lines.push('> 口径见 `docs/eval/metrics.md`：完成率看任务，恢复成功率看故障，');
  lines.push('> 恢复时间必须与恢复尝试次数并列读——耗时是退避配置的函数，尝试次数不是。');
  lines.push('');

  lines.push('## 场景清单');
  lines.push('');
  lines.push(
    '| 场景 | 样本量(基线/加固) | 完成率 基线 | 完成率 加固 | Δ(pp) | 恢复成功率 加固 | Δtoken | 缺口 |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const summary of summaries) {
    lines.push(
      `| ${summary.scenario} | ${summary.baseline.runs} / ${summary.hardened.runs} ` +
        `| ${formatRate(summary.baseline.completionRate)} | ${formatRate(summary.hardened.completionRate)} ` +
        `| ${formatPp(summary.delta.completionRatePp)} | ${formatRate(summary.hardened.recoveryRate)} ` +
        `| ${formatPercent(summary.delta.meanTokensPercent)} ` +
        `| ${summary.gaps.length > 0 ? summary.gaps.join('；') : '—'} |`,
    );
  }
  lines.push('');

  for (const summary of summaries) {
    lines.push(`## ${summary.scenario}`);
    lines.push('');
    if (summary.gaps.length > 0) {
      lines.push(`缺口：${summary.gaps.join('；')}`);
      lines.push('');
    }
    lines.push('| 指标 | 基线 | 加固 | 差值 |');
    lines.push('| --- | --- | --- | --- |');
    lines.push(
      `| 完成率 | ${formatRate(summary.baseline.completionRate)}（${summary.baseline.completed}/${summary.baseline.runs}） ` +
        `| ${formatRate(summary.hardened.completionRate)}（${summary.hardened.completed}/${summary.hardened.runs}） ` +
        `| ${formatPp(summary.delta.completionRatePp)} |`,
    );
    lines.push(
      `| 恢复成功率 | ${formatRate(summary.baseline.recoveryRate)}（${summary.baseline.faultsAbsorbed}/${summary.baseline.faultsInjected}） ` +
        `| ${formatRate(summary.hardened.recoveryRate)}（${summary.hardened.faultsAbsorbed}/${summary.hardened.faultsInjected}） ` +
        `| ${formatPp(summary.delta.recoveryRatePp)} |`,
    );
    lines.push(
      `| 恢复时间 ms（P50 / max，n） | ${formatDuration(summary.baseline.recoveryMs)} ` +
        `| ${formatDuration(summary.hardened.recoveryMs)} | — |`,
    );
    lines.push(
      `| 恢复尝试次数（P50 / max，n） | ${formatDuration(summary.baseline.recoveryAttempts)} ` +
        `| ${formatDuration(summary.hardened.recoveryAttempts)} | — |`,
    );
    lines.push(
      `| token 均值（样本数） | ${formatTokens(summary.baseline)} | ${formatTokens(summary.hardened)} ` +
        `| ${formatPercent(summary.delta.meanTokensPercent)} |`,
    );
    lines.push('');
  }

  if (meta.notes && meta.notes.length > 0) {
    lines.push('## 说明');
    lines.push('');
    for (const note of meta.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return lines.join('\n');
}

function deltaPp(baseline: number | null, hardened: number | null): number | null {
  if (baseline === null || hardened === null) return null;
  return round2((hardened - baseline) * 100);
}

function percentDelta(baseline: number | null, hardened: number | null): number | null {
  if (baseline === null || hardened === null || baseline === 0) return null;
  return Math.round(((hardened - baseline) / baseline) * 100);
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(0)}%`;
}

function formatPp(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(0)}pp`;
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(0)}%`;
}

function formatDuration(stats: DurationStats | null): string {
  return stats === null ? '—' : `${stats.p50} / ${stats.max}（n=${stats.samples}）`;
}

function formatTokens(metrics: VariantMetrics): string {
  return metrics.meanTokens === null ? '—' : `${metrics.meanTokens}（n=${metrics.usageSamples}）`;
}
