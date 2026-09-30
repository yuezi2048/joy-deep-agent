import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, runScenario } from './scenarios.js';
import {
  renderMarkdownReport,
  summarizeAll,
  summarizeRuns,
  toJsonReport,
  type ReportMeta,
  type RunObservation,
  type ScenarioMetrics,
  type VariantMetrics,
} from './metrics.js';

/**
 * 评测入口（#8）：跑全部故障场景的基线与加固，按口径汇总，落盘 Markdown + JSON。
 *
 * 用法：`pnpm eval`（等价 `tsx src/eval/run.ts`）。
 * 输出：`docs/eval/report-<日期>.md` 与同名 `.json`。
 */

/** 每场景每变体的重复次数。假供应商是确定性的，重复只为取恢复时间的样本分布。 */
export const DEFAULT_REPEATS = 5;

export interface EvalRunOptions {
  repeats?: number;
  /** 时间源；默认墙钟。测试可注入假时钟避免真的等退避。 */
  now?: () => number;
}

export interface OverallMetrics {
  baseline: VariantMetrics;
  hardened: VariantMetrics;
  delta: { completionRatePp: number | null; recoveryRatePp: number | null; meanTokensPercent: number | null };
}

export interface EvalReport {
  generatedAt: string;
  meta: ReportMeta;
  observations: RunObservation[];
  summaries: ScenarioMetrics[];
  overall: OverallMetrics;
  markdown: string;
  json: { meta: ReportMeta; scenarios: ScenarioMetrics[]; overall: OverallMetrics };
}

/** 按「场景 → 变体 → 重复」跑一遍，顺序固定，报告可复现。 */
export async function runAllScenarios(options: EvalRunOptions = {}): Promise<RunObservation[]> {
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`重复次数必须是正整数，收到 ${repeats}`);

  const runs: RunObservation[] = [];
  for (const scenario of SCENARIOS) {
    for (const variant of ['baseline', 'hardened'] as const) {
      for (let round = 0; round < repeats; round++) {
        runs.push(await runScenario(scenario, variant, options.now ? { now: options.now } : {}));
      }
    }
  }
  return runs;
}

/** 报告口径说明。数字怎么来的必须写在报告里，读者才不用猜。 */
export function reportMeta(generatedAt: string, repeats: number): ReportMeta {
  return {
    generatedAt,
    notes: [
      `退避：initialDelayMs=500、backoffFactor=2、maxDelayMs=15000、maxRetries=3（生产值，未调整）`,
      `模型：进程内确定性假供应商（ScriptedModel），无网络、不烧 key；token 按本项目字符权重口径估算`,
      `每场景每变体重复 ${repeats} 次；基线 = 裸循环（不装中间件、单供应商、无检查点、无关卡），加固 = docs/eval/metrics.md 第三节的全套`,
      `供应商故障转移的恢复时间是进程内模拟，不含真实网络超时；工具重试的恢复时间包含真实退避等待`,
      `「异常退出」= 运行抛异常、没产出交付物；这类样本没有 usage，token 均值不计入，样本数见括号`,
      `恢复率只有「注入时刻可观测」的类别才有：失败调用 / 供应商故障 / 用户中断 / 终端异常有，幻觉 / 工具误用 / 死循环 / 上下文溢出一律记 —（拦截式防护，没有恢复时间可言）`,
      `C-01 是无故障对照组：两侧都必须完成，用来验证「基线失败」是故障造成的，而不是评测本身对基线不友好`,
    ],
  };
}

export function buildReport(
  observations: readonly RunObservation[],
  meta: ReportMeta,
  gapsByScenario: Readonly<Record<string, readonly string[]>> = {},
): EvalReport {
  const summaries = summarizeAll(observations, gapsByScenario);
  const baseline = summarizeRuns(observations.filter((run) => run.variant === 'baseline'));
  const hardened = summarizeRuns(observations.filter((run) => run.variant === 'hardened'));
  const overall: OverallMetrics = {
    baseline,
    hardened,
    delta: {
      completionRatePp: deltaPp(baseline.completionRate, hardened.completionRate),
      recoveryRatePp: deltaPp(baseline.recoveryRate, hardened.recoveryRate),
      meanTokensPercent: percentDelta(baseline.meanTokens, hardened.meanTokens),
    },
  };
  const json = { ...toJsonReport(summaries, meta), overall };
  return {
    generatedAt: meta.generatedAt ?? '',
    meta,
    observations: [...observations],
    summaries,
    overall,
    markdown: renderOverall(overall) + renderMarkdownReport(summaries, meta),
    json,
  };
}

/** 总体一节：把各场景等权合并，给出简历/README 需要引用的那一个数字。 */
function renderOverall(overall: OverallMetrics): string {
  const { baseline, hardened, delta } = overall;
  const lines: string[] = [];
  lines.push('## 总体（各场景等权，样本量=场景数 × 重复次数）');
  lines.push('');
  lines.push('| 指标 | 基线 | 加固 | 差值 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| 完成率 | ${rate(baseline.completionRate)}（${baseline.completed}/${baseline.runs}） ` +
      `| ${rate(hardened.completionRate)}（${hardened.completed}/${hardened.runs}） | ${pp(delta.completionRatePp)} |`,
  );
  lines.push(
    `| 恢复成功率 | ${rate(baseline.recoveryRate)}（${baseline.faultsAbsorbed}/${baseline.faultsInjected}） ` +
      `| ${rate(hardened.recoveryRate)}（${hardened.faultsAbsorbed}/${hardened.faultsInjected}） | ${pp(delta.recoveryRatePp)} |`,
  );
  lines.push(`| 异常退出 | ${baseline.errored} | ${hardened.errored} | — |`);
  lines.push(
    `| token 均值（样本数） | ${tokens(baseline)} | ${tokens(hardened)} | ${percent(delta.meanTokensPercent)} |`,
  );
  lines.push('');
  return lines.join('\n');
}

const rate = (value: number | null): string => (value === null ? '—' : `${(value * 100).toFixed(0)}%`);
const pp = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(0)}pp`);
const percent = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(0)}%`);
const tokens = (metrics: VariantMetrics): string =>
  metrics.meanTokens === null ? '—' : `${metrics.meanTokens}（n=${metrics.usageSamples}）`;

const round2 = (value: number): number => Math.round(value * 100) / 100;
function deltaPp(baseline: number | null, hardened: number | null): number | null {
  if (baseline === null || hardened === null) return null;
  return round2((hardened - baseline) * 100);
}
function percentDelta(baseline: number | null, hardened: number | null): number | null {
  if (baseline === null || hardened === null || baseline === 0) return null;
  return Math.round(((hardened - baseline) / baseline) * 100);
}

/** 生成报告并落盘；返回报告内容。 */
export async function writeReport(
  directory: string,
  options: EvalRunOptions & { gapsByScenario?: Readonly<Record<string, readonly string[]>> } = {},
): Promise<EvalReport> {
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  const observations = await runAllScenarios(options);
  const generatedAt = new Date().toISOString();
  const meta = reportMeta(generatedAt, repeats);
  const report = buildReport(observations, meta, options.gapsByScenario ?? {});
  const day = generatedAt.slice(0, 10);

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `report-${day}.md`), report.markdown, 'utf8');
  await writeFile(join(directory, `report-${day}.json`), `${JSON.stringify(report.json, null, 2)}\n`, 'utf8');
  return report;
}

/** CLI 入口：`tsx src/eval/run.ts [输出目录]`，默认写 `docs/eval/`。 */
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  const directory = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'docs', 'eval');
  const report = await writeReport(directory);
  process.stdout.write(report.markdown);
  process.stdout.write(`\n报告已写入 ${directory}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
