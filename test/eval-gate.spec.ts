import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_COMPLETION,
  evaluateGate,
  parseGateArgs,
  renderGateReport,
  runGate,
  type RunObservation,
} from '../src/eval/index.js';

/**
 * 评测门禁（#9）的判据测试。
 *
 * 判据本身是纯函数，用构造出来的观测直接测；另外有一条真实跑一遍的集成用例，
 * 保证「门禁在现状下确实通过」——门禁自己要是红了，后面的改动就没法提交。
 */

const run = (overrides: Partial<RunObservation>): RunObservation => ({
  scenario: 'S-01',
  variant: 'hardened',
  passed: true,
  stopReason: 'completed',
  usage: { totalTokens: 100 },
  faults: [],
  ...overrides,
});

describe('门禁 · 加固不许低于基线', () => {
  it('某个场景加固低于基线时判不通过，并说清是哪一类、差多少', () => {
    const result = evaluateGate(
      [
        run({ scenario: 'S-01', variant: 'baseline', passed: false }),
        run({ scenario: 'S-01', variant: 'hardened', passed: true }),
        run({ scenario: 'S-02', variant: 'baseline', passed: true }),
        run({ scenario: 'S-02', variant: 'hardened', passed: false }),
      ],
      { minCompletion: 0 },
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.scope).toBe('S-02');
    expect(result.violations[0]?.metric).toBe('completion');
    expect(result.violations[0]?.detail).toContain('100%');
    expect(result.violations[0]?.detail).toContain('0%');
    expect(result.violations[0]?.detail).toContain('-100pp');
    expect(renderGateReport(result)).toContain('未通过');
  });

  it('加固与基线打平不算退化（只有严格更差才拦）', () => {
    const result = evaluateGate(
      [
        run({ scenario: 'S-01', variant: 'baseline', passed: true }),
        run({ scenario: 'S-01', variant: 'hardened', passed: true }),
      ],
      { minCompletion: 0 },
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe('门禁 · 达标线', () => {
  it('低于达标线判不通过，违规位置是总体', () => {
    const result = evaluateGate(
      [
        run({ scenario: 'S-01', variant: 'baseline', passed: false }),
        run({ scenario: 'S-01', variant: 'hardened', passed: true }),
        run({ scenario: 'S-02', variant: 'baseline', passed: false }),
        run({ scenario: 'S-02', variant: 'hardened', passed: false }),
      ],
      { minCompletion: 1 },
    );

    const floor = result.violations.find((violation) => violation.scope === '总体');
    expect(floor?.detail).toContain('低于达标线 100%');
    expect(floor?.detail).toContain('1/2');
    expect(result.passed).toBe(false);
  });

  it('达标线可配置：放宽到 50% 后同一批观测就通过', () => {
    const observations = [
      run({ scenario: 'S-01', variant: 'baseline', passed: false }),
      run({ scenario: 'S-01', variant: 'hardened', passed: true }),
      run({ scenario: 'S-02', variant: 'baseline', passed: false }),
      run({ scenario: 'S-02', variant: 'hardened', passed: false }),
    ];
    expect(evaluateGate(observations, { minCompletion: 0.5 }).passed).toBe(true);
    expect(evaluateGate(observations, { minCompletion: 0.6 }).passed).toBe(false);
  });

  it('默认达标线有依据：等于「所有场景都得过」', () => {
    expect(DEFAULT_MIN_COMPLETION).toBe(1);
  });
});

describe('门禁 · 恢复成功率', () => {
  it('总体恢复成功率低于基线时也算退化', () => {
    const fault = (absorbed: boolean) => [
      { category: 'provider-failure', injectedAt: 0, absorbed, ...(absorbed ? { recoveredAt: 10, attempts: 2 } : {}) },
    ];
    const result = evaluateGate(
      [
        run({ scenario: 'S-06', variant: 'baseline', passed: true, faults: fault(true) }),
        run({ scenario: 'S-06', variant: 'hardened', passed: true, faults: fault(false) }),
      ],
      { minCompletion: 0 },
    );

    expect(result.violations.some((violation) => violation.metric === 'recovery')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('门禁 · 参数解析', () => {
  it('认 --min-completion 与 --repeats', () => {
    expect(parseGateArgs(['--min-completion=0.9', '--repeats=3'], {})).toEqual({
      minCompletion: 0.9,
      repeats: 3,
    });
  });

  it('认环境变量，命令行优先', () => {
    expect(parseGateArgs([], { EVAL_MIN_COMPLETION: '0.8' }).minCompletion).toBe(0.8);
    expect(
      parseGateArgs(['--min-completion=0.5'], { EVAL_MIN_COMPLETION: '0.8' }).minCompletion,
    ).toBe(0.5);
  });

  it('非法参数直接报错，不静默忽略', () => {
    expect(() => parseGateArgs(['--min-completion=1.5'], {})).toThrow(/\[0, 1\]/);
    expect(() => parseGateArgs(['--repeats=0'], {})).toThrow(/正整数/);
    expect(() => parseGateArgs(['--nope'], {})).toThrow(/无法识别/);
  });
});

describe('门禁 · 现状下必须通过', () => {
  it('跑一遍真实评测，门禁应当放行', async () => {
    const result = await runGate({ repeats: 1 });
    expect(renderGateReport(result)).toContain('评测门禁：通过');
    expect(result.passed, renderGateReport(result)).toBe(true);
  }, 120_000);
});
