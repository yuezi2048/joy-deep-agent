import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/core/agent-loop.js';
import { RetryableError } from '../src/core/errors.js';
import {
  FAULT_CATEGORIES,
  RunRecorder,
  durationStats,
  percentile,
  renderMarkdownReport,
  summarizeAll,
  summarizeRuns,
  summarizeScenario,
  toJsonReport,
  type RunObservation,
} from '../src/eval/index.js';
import { FailoverChatModel } from '../src/providers/failover-model.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { StubChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

const run = (overrides: Partial<RunObservation> = {}): RunObservation => ({
  scenario: 'S-01',
  variant: 'hardened',
  passed: true,
  stopReason: 'completed',
  usage: { totalTokens: 100 },
  faults: [],
  ...overrides,
});

describe('口径 · 完成率', () => {
  it('分子是 passed 的运行数，分母是样本量', () => {
    const metrics = summarizeRuns([
      run({ passed: true }),
      run({ passed: true }),
      run({ passed: false }),
      run({ passed: false }),
    ]);

    expect(metrics.runs).toBe(4);
    expect(metrics.completed).toBe(2);
    expect(metrics.completionRate).toBe(0.5);
  });

  it('没有样本时记 null，不写 0 也不写 100%', () => {
    expect(summarizeRuns([]).completionRate).toBeNull();
  });
});

describe('口径 · 恢复成功率', () => {
  it('分子是吸收的故障数，分母是注入的故障数', () => {
    const metrics = summarizeRuns([
      run({
        faults: [
          { category: FAULT_CATEGORIES.providerFailure, injectedAt: 0, recoveredAt: 10, absorbed: true },
          { category: FAULT_CATEGORIES.failedCall, injectedAt: 0, absorbed: false },
        ],
      }),
    ]);

    expect(metrics.faultsInjected).toBe(2);
    expect(metrics.faultsAbsorbed).toBe(1);
    expect(metrics.recoveryRate).toBe(0.5);
  });

  it('没注入故障时记 null：没测的东西不该出现在报告里', () => {
    expect(summarizeRuns([run()]).recoveryRate).toBeNull();
  });

  it('恢复成功但任务没完成：两个指标各说各的', () => {
    const metrics = summarizeRuns([
      run({
        passed: false,
        stopReason: 'max_steps',
        faults: [
          { category: FAULT_CATEGORIES.failedCall, injectedAt: 0, recoveredAt: 500, absorbed: true },
        ],
      }),
    ]);

    expect(metrics.completionRate).toBe(0);
    expect(metrics.recoveryRate).toBe(1);
  });
});

describe('口径 · 恢复时间与尝试次数', () => {
  it('P50 用最近秩法，max 取最大值，样本数一并给出', () => {
    expect(percentile([300, 100, 200], 0.5)).toBe(200);
    expect(percentile([400, 100, 300, 200], 0.5)).toBe(200); // ceil(0.5*4)=2 → 第 2 个
    expect(percentile([500], 0.5)).toBe(500);
    expect(durationStats([100, 500, 300])).toEqual({ samples: 3, p50: 300, max: 500 });
    expect(durationStats([])).toBeNull();
  });

  it('只统计「已恢复」的故障：没恢复的不进样本，而是降低恢复成功率', () => {
    const metrics = summarizeRuns([
      run({
        faults: [
          { category: 'a', injectedAt: 1_000, recoveredAt: 1_500, attempts: 1, absorbed: true },
          { category: 'b', injectedAt: 1_000, absorbed: false },
        ],
      }),
    ]);

    expect(metrics.recoveryMs).toEqual({ samples: 1, p50: 500, max: 500 });
    expect(metrics.recoveryAttempts).toEqual({ samples: 1, p50: 1, max: 1 });
    expect(metrics.recoveryRate).toBe(0.5);
  });
});

describe('口径 · token 消耗', () => {
  it('报总量与均值；缺 usage 的样本不参与均值', () => {
    const metrics = summarizeRuns([
      run({ usage: { totalTokens: 100 } }),
      run({ usage: { totalTokens: 200 } }),
      run({ usage: undefined }),
    ]);

    expect(metrics.usageSamples).toBe(2);
    expect(metrics.totalTokens).toBe(300);
    expect(metrics.meanTokens).toBe(150);
  });

  it('一个 usage 都没有时记 null', () => {
    expect(summarizeRuns([run({ usage: undefined })]).meanTokens).toBeNull();
  });
});

describe('口径 · 差值与缺口', () => {
  it('Δ完成率按百分点、Δtoken 按百分比算', () => {
    const summary = summarizeScenario('S-01', [
      run({ variant: 'baseline', passed: false, usage: { totalTokens: 1_000 } }),
      run({ variant: 'hardened', passed: true, usage: { totalTokens: 1_600 } }),
    ]);

    expect(summary.delta.completionRatePp).toBe(100);
    expect(summary.delta.meanTokensPercent).toBe(60);
  });

  it('基线为 0 或任一侧没样本时，Δ 记 null', () => {
    // 加固侧还没做：样本为 0，自动标缺口（S-07 这种「本类尚未加固」的场景）
    const noHardened = summarizeScenario('S-02', [run({ variant: 'baseline' })]);
    expect(noHardened.delta.completionRatePp).toBeNull();
    expect(noHardened.gaps).toContain('加固侧没有样本：本场景尚未加固');
    // 基线侧缺样本（只有加固数据）时 Δ 同样记 null，但不标「未加固」缺口
    const noBaseline = summarizeScenario('S-02b', [run({ variant: 'hardened' })]);
    expect(noBaseline.delta.completionRatePp).toBeNull();
    expect(noBaseline.gaps).toEqual([]);

    const zeroTokens = summarizeScenario('S-03', [
      run({ variant: 'baseline', usage: { totalTokens: 0 } }),
      run({ variant: 'hardened', usage: { totalTokens: 10 } }),
    ]);
    expect(zeroTokens.delta.meanTokensPercent).toBeNull();
  });

  it('场景声明的缺口原样带进报告', () => {
    const summary = summarizeScenario('S-07', [run({ variant: 'baseline' })], {
      gaps: ['本类未加固：检查点未开启'],
    });

    expect(summary.gaps).toEqual([
      '本类未加固：检查点未开启',
      '加固侧没有样本：本场景尚未加固',
    ]);
  });
});

describe('报告渲染', () => {
  const observations: RunObservation[] = [
    run({ scenario: 'S-01', variant: 'baseline', passed: false, usage: { totalTokens: 1_000 }, faults: [{ category: 'provider-failure', injectedAt: 0, absorbed: false }] }),
    run({ scenario: 'S-01', variant: 'baseline', passed: true, usage: { totalTokens: 1_000 }, faults: [{ category: 'provider-failure', injectedAt: 0, absorbed: false }] }),
    run({ scenario: 'S-01', variant: 'hardened', passed: true, usage: { totalTokens: 1_600 }, faults: [{ category: 'provider-failure', injectedAt: 0, recoveredAt: 1_500, attempts: 2, absorbed: true }] }),
    run({ scenario: 'S-07', variant: 'baseline', passed: false, usage: { totalTokens: 900 } }),
  ];

  it('场景清单含基线列、加固列、差值与缺口位', () => {
    const markdown = renderMarkdownReport(summarizeAll(observations, { 'S-07': ['本类未加固'] }), {
      generatedAt: '2026-09-30T20:00:00+08:00',
      notes: ['退避：initialDelayMs=500、backoffFactor=2、maxDelayMs=15000、maxRetries=3（生产值，未调整）'],
    });

    expect(markdown).toContain('# 故障注入评测报告');
    expect(markdown).toContain('| 场景 | 样本量(基线/加固) | 完成率 基线 | 完成率 加固 | Δ(pp)');
    expect(markdown).toContain('| S-01 | 2 / 1 | 50% | 100% | +50pp');
    expect(markdown).toContain('| S-07 | 1 / 0 | 0% | — | —');
    // 恢复时间与恢复尝试次数必须并列出现
    expect(markdown).toContain('| 恢复时间 ms（P50 / max，n） |');
    expect(markdown).toContain('| 恢复尝试次数（P50 / max，n） |');
    expect(markdown).toContain('1500 / 1500（n=1）');
    // 缺口位
    expect(markdown).toContain('本类未加固；加固侧没有样本：本场景尚未加固');
    // 说明区带上退避参数
    expect(markdown).toContain('注意事项'.replace('注意事项', '说明'));
    expect(markdown).toContain('initialDelayMs=500');
  });

  it('测不出来的项渲染成破折号，不编数字', () => {
    const markdown = renderMarkdownReport([summarizeScenario('S-09', [run({ scenario: 'S-09' })])]);

    expect(markdown).toContain('| 恢复成功率 | —（0/0） |');
    expect(markdown).toContain('| 恢复时间 ms（P50 / max，n） | — |');
  });

  it('JSON 与表格同源', () => {
    const summaries = summarizeAll(observations);
    const json = toJsonReport(summaries, { generatedAt: 'now' });

    expect(json.scenarios[0]?.scenario).toBe('S-01');
    expect(json.scenarios[0]?.hardened.recoveryMs).toEqual({ samples: 1, p50: 1_500, max: 1_500 });
    expect(json.meta.generatedAt).toBe('now');
  });
});

describe('口径自查 · 四个指标都能从真实运行里测出来', () => {
  it('供应商故障转移：完成率、恢复成功率、恢复时间、尝试次数、token 一次采齐', async () => {
    let clock = 1_000;
    const recorder = new RunRecorder({
      scenario: 'S-01 供应商 502 后转移',
      variant: 'hardened',
      now: () => clock,
    });

    const script = [
      { ...toolTurn('add', { a: 2, b: 3 }), usage: { totalTokens: 60 } },
      { ...answerTurn('答案是 5'), usage: { totalTokens: 40 } },
    ];
    const primary = new StubChatModel('primary', async () => {
      clock += 250; // 主供应商先花掉 250ms，再失败
      throw new RetryableError('502 Bad Gateway');
    });
    const backup = new StubChatModel('backup', async () => {
      clock += 800; // 备用花 800ms 回应
      return script.shift() ?? answerTurn('剧本没了');
    });
    const model = new FailoverChatModel(
      [
        { key: 'primary', label: 'Primary', model: primary },
        { key: 'backup', label: 'Backup', model: backup },
      ],
      { onEvent: recorder.onFailoverEvent },
    );

    const tools = new ToolRegistry().register({
      name: 'add',
      description: '加法',
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: async ({ a, b }: { a: number; b: number }) => String(a + b),
    });
    const result = await new AgentLoop({ model, tools }).run('2+3 等于几');
    const observation = recorder.finish(result);

    expect(observation.passed).toBe(true);
    expect(observation.stopReason).toBe('completed');
    // 两次模型调用各注入一次供应商故障，都被转移吸收
    expect(observation.faults).toHaveLength(2);
    expect(observation.faults?.every((fault) => fault.absorbed)).toBe(true);
    expect(observation.faults?.map((fault) => fault.recoveredAt! - fault.injectedAt)).toEqual([
      800, 800,
    ]);
    expect(observation.faults?.map((fault) => fault.attempts)).toEqual([2, 2]);
    expect(observation.usage?.totalTokens).toBe(100);
  });

  it('故障没被吸收时如实记账：恢复时间为空，恢复成功率下降', async () => {
    const recorder = new RunRecorder({ scenario: 'S-02', variant: 'baseline', now: () => 5_000 });
    recorder.injectFault(FAULT_CATEGORIES.providerFailure, 1_000);

    const observation = recorder.finish({
      content: '',
      steps: 1,
      stopReason: 'max_steps',
      messages: [],
      toolCalls: [],
      usage: { totalTokens: 10 },
    });

    const metrics = summarizeRuns([observation]);
    expect(metrics.recoveryRate).toBe(0);
    expect(metrics.recoveryMs).toBeNull();
  });

  it('任务照样跑完时，没显式恢复的故障也算被吸收', () => {
    const recorder = new RunRecorder({ scenario: 'S-03', variant: 'hardened' });
    recorder.injectFault(FAULT_CATEGORIES.failedCall, 0);

    const observation = recorder.finish({
      content: '绕过去了',
      steps: 2,
      stopReason: 'completed',
      messages: [],
      toolCalls: [],
      usage: { totalTokens: 10 },
    });

    expect(observation.faults?.[0]?.absorbed).toBe(true);
  });

  it('重试适配器数尝试次数，工具恢复适配器收口', () => {
    let clock = 0;
    const recorder = new RunRecorder({ scenario: 'S-04', variant: 'hardened', now: () => clock });

    recorder.onRetry(new RetryableError('429'), 1, 500); // 第一次重试
    clock += 500;
    recorder.onRetry(new RetryableError('429'), 2, 1_000); // 第二次重试
    clock += 1_000;
    recorder.onAgentEvent({
      type: 'tool_result',
      call: { id: 'c1', name: 't', arguments: {}, rawArguments: '{}' },
      result: { content: 'ok' },
    }); // 第三次尝试成功

    const observation = recorder.snapshot('completed');
    expect(observation.faults).toEqual([
      {
        category: FAULT_CATEGORIES.failedCall,
        injectedAt: 0,
        recoveredAt: 1_500,
        attempts: 3,
        absorbed: true,
      },
    ]);
  });

  it('同一类故障已经在开放中就不重复记，避免把一次故障算成三次', () => {
    const recorder = new RunRecorder({ scenario: 'S-05', variant: 'hardened', now: () => 0 });
    recorder.onRetry(new RetryableError('429'), 1, 500);
    recorder.onRetry(new RetryableError('429'), 2, 500);
    recorder.onRetry(new RetryableError('429'), 3, 500);

    expect(recorder.snapshot().faults).toHaveLength(1);
  });
});
