import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPEATS,
  FAULT_CATEGORIES,
  SCENARIOS,
  buildReport,
  reportMeta,
  runAllScenarios,
  runScenario,
  type RunObservation,
} from '../src/eval/index.js';

/**
 * 故障注入场景库的端到端校验（#8）。
 *
 * 这一组用例回答三个问题：
 * 1. 场景是确定的吗？（重复跑结果一致，报告才可信）
 * 2. 基线真的会暴露故障吗？
 * 3. 加固真的能收敛吗？
 *
 * 另外钉死两条反作弊口径：退避不许被调小；无故障对照组两侧都必须通过。
 */

const CONTROL = 'C-01 无故障对照';
const FAULT_SCENARIOS = SCENARIOS.filter((scenario) => scenario.id !== CONTROL);

/** 只留可复现的字段：恢复耗时会抖，用「是否恢复」与尝试次数代替。 */
function normalize(run: RunObservation): unknown {
  return {
    scenario: run.scenario,
    variant: run.variant,
    passed: run.passed,
    stopReason: run.stopReason ?? null,
    errored: run.errored !== undefined,
    tokens: run.usage?.totalTokens ?? null,
    faults: (run.faults ?? []).map((fault) => ({
      category: fault.category,
      absorbed: fault.absorbed,
      recovered: fault.recoveredAt !== undefined,
      attempts: fault.attempts ?? null,
    })),
  };
}

describe('场景库 · 覆盖', () => {
  it('8 类故障各有至少一个场景，外加一个无故障对照组', () => {
    const covered = new Set(FAULT_SCENARIOS.map((scenario) => scenario.category));
    for (const category of Object.values(FAULT_CATEGORIES)) {
      expect(covered, `故障类别 ${category} 没有场景覆盖`).toContain(category);
    }
    expect(SCENARIOS.some((scenario) => scenario.id === CONTROL)).toBe(true);
  });
});

describe('场景库 · 确定性', () => {
  for (const scenario of SCENARIOS) {
    for (const variant of ['baseline', 'hardened'] as const) {
      it(`${scenario.id} · ${variant} 重复跑结果一致`, async () => {
        const first = await runScenario(scenario, variant);
        const second = await runScenario(scenario, variant);
        expect(normalize(second)).toEqual(normalize(first));
      }, 60_000);
    }
  }
});

describe('场景库 · 基线暴露故障、加固收敛', () => {
  for (const scenario of FAULT_SCENARIOS) {
    it(`${scenario.id}：基线失败，加固通过`, async () => {
      const baseline = await runScenario(scenario, 'baseline');
      const hardened = await runScenario(scenario, 'hardened');

      // 基线要么答案不达标、要么直接抛异常退出；两种情况 passed 都是 false
      expect(
        baseline.passed,
        `基线的 ${scenario.id} 竟然没暴露问题：stop=${baseline.stopReason}`,
      ).toBe(false);
      expect(
        hardened.passed,
        `加固的 ${scenario.id} 没收敛：passed=${hardened.passed} stop=${hardened.stopReason} errored=${hardened.errored}`,
      ).toBe(true);
    }, 60_000);
  }

  it(`${CONTROL}：两侧都必须通过（否则说明评测本身对基线不友好）`, async () => {
    const baseline = await runScenario(SCENARIOS[0]!, 'baseline');
    const hardened = await runScenario(SCENARIOS[0]!, 'hardened');
    expect(baseline.passed).toBe(true);
    expect(hardened.passed).toBe(true);
  }, 60_000);
});

describe('场景库 · 恢复记账', () => {
  const faultsOf = (run: RunObservation, category: string): RunObservation['faults'] =>
    (run.faults ?? []).filter((fault) => fault.category === category);

  it('失败调用：加固侧重试成功，尝试次数含成功那次；基线侧无法恢复', async () => {
    const scenario = FAULT_SCENARIOS.find((item) => item.id.startsWith('S-01'))!;
    const baseline = await runScenario(scenario, 'baseline');
    const hardened = await runScenario(scenario, 'hardened');

    const [baselineFault] = faultsOf(baseline, FAULT_CATEGORIES.failedCall) ?? [];
    expect(baselineFault?.absorbed).toBe(false);

    const [fault] = faultsOf(hardened, FAULT_CATEGORIES.failedCall) ?? [];
    expect(fault?.absorbed).toBe(true);
    expect(fault?.attempts).toBe(2);
    expect((fault?.recoveredAt ?? 0) - (fault?.injectedAt ?? 0)).toBeGreaterThanOrEqual(500);
  }, 60_000);

  it('供应商故障：加固侧转移到备用，尝试次数为 2', async () => {
    const scenario = FAULT_SCENARIOS.find((item) => item.id.startsWith('S-06'))!;
    const hardened = await runScenario(scenario, 'hardened');
    const [fault] = faultsOf(hardened, FAULT_CATEGORIES.providerFailure) ?? [];
    expect(fault?.absorbed).toBe(true);
    expect(fault?.attempts).toBe(2);
  }, 60_000);

  it('用户中断 / 终端异常：续跑与预检都算作已恢复', async () => {
    for (const [id, category] of [
      ['S-07', FAULT_CATEGORIES.userInterrupt],
      ['S-08', FAULT_CATEGORIES.terminal],
    ] as const) {
      const scenario = FAULT_SCENARIOS.find((item) => item.id.startsWith(id))!;
      const hardened = await runScenario(scenario, 'hardened');
      const [fault] = faultsOf(hardened, category) ?? [];
      expect(fault?.absorbed, `${id} 的 ${category} 没被吸收`).toBe(true);
      expect(fault?.recoveredAt, `${id} 的 ${category} 没有恢复时刻`).toBeTypeOf('number');
    }
  }, 60_000);
});

describe('评测入口', () => {
  it('按固定顺序跑满 场景 × 变体 × 重复次数', async () => {
    const runs = await runAllScenarios({ repeats: 1 });
    expect(runs).toHaveLength(SCENARIOS.length * 2);
    expect(runs[0]?.scenario).toBe(SCENARIOS[0]!.id);
    expect(runs[0]?.variant).toBe('baseline');
    expect(runs[1]?.variant).toBe('hardened');
    expect(runs[2]?.scenario).toBe(SCENARIOS[1]!.id);
  }, 60_000);

  it('报告汇总与逐场景观测对得上，并给出总体数字', async () => {
    const observations = await runAllScenarios({ repeats: 2 });
    const report = buildReport(observations, reportMeta('2026-09-30T00:00:00.000Z', 2));

    expect(report.summaries).toHaveLength(SCENARIOS.length);
    const total = SCENARIOS.length * 2;
    expect(report.overall.baseline.runs).toBe(total);
    expect(report.overall.hardened.runs).toBe(total);
    expect(report.overall.hardened.completed).toBe(total);
    expect(report.overall.baseline.completionRate).toBeLessThan(
      report.overall.hardened.completionRate as number,
    );
    expect(report.markdown).toContain('## 总体');
    expect(report.markdown).toContain('## 场景清单');
    expect(report.json.scenarios).toHaveLength(SCENARIOS.length);
  }, 120_000);

  it('默认重复次数是正整数，非法值直接拒绝', async () => {
    expect(DEFAULT_REPEATS).toBeGreaterThan(0);
    await expect(runAllScenarios({ repeats: 0 })).rejects.toThrow();
  });
});

describe('评测入口 · 缺口不允许静默省略', () => {
  it('场景声明的缺口与「加固侧没有样本」都会出现在报告里', () => {
    const runs: RunObservation[] = [
      { scenario: 'X-01', variant: 'baseline', passed: false, stopReason: 'max_steps', faults: [] },
    ];
    const report = buildReport(runs, { generatedAt: 't' }, { 'X-01': ['本例尚未加固'] });
    expect(report.summaries[0]?.gaps).toEqual([
      '本例尚未加固',
      '加固侧没有样本：本场景尚未加固',
    ]);
    expect(report.markdown).toContain('本例尚未加固');
  });
});
