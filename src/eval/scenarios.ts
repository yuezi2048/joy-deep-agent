import { AgentLoop, type AgentEvent, type AgentLoopOptions, type AgentRunResult } from '../core/agent-loop.js';
import { RetryableError, errorMessage } from '../core/errors.js';
import { InMemoryCheckpointStore } from '../memory/checkpoint-store.js';
import { FailoverChatModel, type ProviderMember } from '../providers/failover-model.js';
import type { ChatModel } from '../providers/chat-model.js';
import { applyDefaultToolMiddleware, withContextBudget } from '../robust/index.js';
import { DEFAULT_ALLOWED_COMMANDS, createBuiltinTools } from '../tools/builtin/index.js';
import { evaluateExpression } from '../tools/builtin/calculator.js';
import { ToolRegistry } from '../tools/registry.js';
import { formatPreflightReport, runPreflight } from '../security/preflight.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ScriptedModel, fakeAnswer, fakeToolCall, observations } from './fakes.js';
import { FAULT_CATEGORIES, type EvalVariant, type FaultCategory } from './metrics.js';
import { RunRecorder } from './recorder.js';

/**
 * 故障注入场景库（#8）：8 类故障各一个确定性场景，基线与加固各跑一遍。
 *
 * 两条规矩：
 * - 全部用假供应商，不依赖任何 API Key；
 * - 场景的行为必须确定：同一个场景重复跑，判定结果必须一致（报告才可信）。
 */

export interface AssembledRun {
  loop: AgentLoop;
  run: (input?: string) => Promise<AgentRunResult>;
  resume: (input?: string) => Promise<AgentRunResult>;
}

export interface ScenarioContext {
  variant: EvalVariant;
  recorder: RunRecorder;
  /** 按口径装配一次运行（同一个 Context 里重复调用会复用工具注册表） */
  assemble: (overrides?: { tools?: ToolRegistry; options?: AgentLoopOptions }) => AssembledRun;
}

export interface EvalScenario {
  id: string;
  title: string;
  /** 对应的故障类别；对照组没有注入故障，省略 */
  category?: FaultCategory;
  input: string;
  /** 供应商；基线只用第一家，加固按顺序转移 */
  providers: (recorder: RunRecorder) => readonly ProviderMember[];
  /** 工具；缺省由 execute 自己装配 */
  tools?: (recorder: RunRecorder) => ToolRegistry;
  /** 上下文预算（只对加固侧生效，用来模拟「加固后压得进预算」） */
  budget?: { maxTokens: number; maxToolResultTokens: number };
  options?: AgentLoopOptions;
  /** 场景自己声明的缺口（本类尚未加固时写在这里） */
  gap?: string;
  assert: (result: AgentRunResult) => boolean;
  execute?: (context: ScenarioContext) => Promise<AgentRunResult>;
}

/** 加固侧的自我核查器：只在看到编造来源时判不通过，其余一律放行（确定性）。 */
export function createVerifierModel(): ScriptedModel {
  return new ScriptedModel('verifier', (request) => {
    const prompt = request.messages.at(-1)?.content ?? '';
    const candidate = prompt.split('【待交付答案】')[1] ?? '';
    const fabricated = /\[tool:(orders_api|nonexistent)\]/.test(candidate);
    return fakeAnswer(
      fabricated
        ? '{"ok": false, "issues": ["引用了观测里不存在的来源 orders_api"]}'
        : '{"ok": true, "issues": []}',
    );
  });
}

const HARDENED_DEFAULTS: AgentLoopOptions = {
  noProgressLimit: 3,
  maxCyclePeriod: 3,
  cycleRepeats: 2,
  maxDurationMs: 300_000,
};
const BASELINE_DEFAULTS: AgentLoopOptions = {
  noProgressLimit: 0,
  maxCyclePeriod: 0,
  maxDurationMs: 0,
};

/** 按口径装配一次运行。基线 = 裸循环，加固 = 全套防护（配置表见 docs/eval/metrics.md 第三节）。 */
class RunContext implements ScenarioContext {
  private registry?: ToolRegistry;
  private middlewareApplied = false;

  constructor(
    readonly variant: EvalVariant,
    readonly recorder: RunRecorder,
    private readonly scenario: EvalScenario,
  ) {}

  assemble(overrides: { tools?: ToolRegistry; options?: AgentLoopOptions } = {}): AssembledRun {
    const hardened = this.variant === 'hardened';
    const members = this.scenario.providers(this.recorder);
    const primary = members[0];
    if (!primary) throw new Error(`场景 ${this.scenario.id} 没有提供任何供应商`);

    const routed: ChatModel =
      hardened && members.length > 1
        ? new FailoverChatModel(members, { onEvent: this.recorder.onFailoverEvent })
        : primary.model;

    const budget = this.scenario.budget;
    const model = hardened && budget ? withContextBudget(routed, budget) : routed;
    const tools = overrides.tools ?? this.tools();

    // 加固侧的幻觉防护（对应 docs/eval/metrics.md 第三节）：来源约束 + 自我核查。
    // 核查器用确定性的 ScriptedModel，只看「引用了没拿到过的来源」，其余放行。
    const guards: AgentLoopOptions = hardened
      ? { sourceConstraint: { enabled: true }, selfCheck: { enabled: true, model: createVerifierModel() } }
      : {};

    const options: AgentLoopOptions = {
      ...(hardened ? HARDENED_DEFAULTS : BASELINE_DEFAULTS),
      ...guards,
      ...(this.scenario.options ?? {}),
      ...(overrides.options ?? {}),
    };

    const loop = new AgentLoop({ model, tools, options });
    const input = this.scenario.input;
    return {
      loop,
      run: (override) => this.drive(loop.runStream(override ?? input)),
      resume: (override) => this.drive(loop.resumeStream(override)),
    };
  }

  private tools(): ToolRegistry {
    if (!this.registry) {
      if (!this.scenario.tools) throw new Error(`场景 ${this.scenario.id} 既没有 tools 也没有自定义 execute`);
      this.registry = this.scenario.tools(this.recorder);
    }
    if (this.variant === 'hardened' && !this.middlewareApplied) {
      applyDefaultToolMiddleware(this.registry, {
        // 退避按生产值，禁止为美化数字调小（见 docs/eval/metrics.md）
        retry: { initialDelayMs: 500, backoffFactor: 2, maxDelayMs: 15_000, maxRetries: 3, onRetry: this.recorder.onRetry },
        timeoutMs: 5_000,
      });
      this.middlewareApplied = true;
    }
    return this.registry;
  }

  private async drive(events: AsyncGenerator<AgentEvent, AgentRunResult>): Promise<AgentRunResult> {
    let result: AgentRunResult | null = null;
    for await (const event of events) {
      this.recorder.onAgentEvent(event);
      if (event.type === 'done') result = event.result;
    }
    if (!result) throw new Error('场景没有拿到执行结果');
    return result;
  }
}

/** 跑一个场景的一次运行，返回可进报告的观测。 */
export async function runScenario(
  scenario: EvalScenario,
  variant: EvalVariant,
  options: { now?: () => number } = {},
): Promise<import('./metrics.js').RunObservation> {
  const recorder = new RunRecorder({
    scenario: scenario.id,
    variant,
    judge: scenario.assert,
    ...(options.now ? { now: options.now } : {}),
  });
  const context = new RunContext(variant, recorder, scenario);

  try {
    const result = scenario.execute
      ? await scenario.execute(context)
      : await context.assemble().run();
    return recorder.finish(result);
  } catch (error) {
    return recorder.finishErrored(errorMessage(error));
  }
}

/** 让工具结果里带上「第几次执行」，用来验证去重与「不重复副作用」（确定性可断言）。 */
function countingTool(name: string, label: string): ToolRegistry {
  let executions = 0;
  return new ToolRegistry().register({
    name,
    description: `${label}（返回第几次执行）`,
    schema: z.object({ key: z.string() }),
    handler: async () => {
      executions += 1;
      return `${label}：第 ${executions} 次执行的结果`;
    },
  });
}

const pairSchema = z.object({ pair: z.string() });
const idSchema = z.object({ id: z.string() });

export const SCENARIOS: readonly EvalScenario[] = [
  {
    id: 'C-01 无故障对照',
    title: '不注入任何故障：两侧都该完成，用来证明这套评测不是「基线必挂」',
    input: '算一下 2+3',
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel('agent', (request) => {
          const seen = observations(request);
          if (seen.length === 0) return fakeToolCall('calc', { expression: '2+3' });
          return fakeAnswer(`结果是 ${seen.at(-1)?.content ?? ''} [tool:calc]`);
        }),
      },
    ],
    tools: () =>
      new ToolRegistry().register({
        name: 'calc',
        description: '算四则运算',
        schema: z.object({ expression: z.string() }),
        handler: async ({ expression }: { expression: string }) => String(evaluateExpression(expression)),
      }),
    assert: (result) => result.stopReason === 'completed' && result.content.includes('5'),
  },
  {
    id: 'S-01 工具首次限流',
    title: '工具第一次调用被限流，重试后应拿到数据',
    category: FAULT_CATEGORIES.failedCall,
    input: '查一下 USD/CNY 汇率',
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel('agent', (request) => {
          const seen = observations(request);
          if (seen.length === 0) return fakeToolCall('fetch_rate', { pair: 'USD/CNY' });
          const last = seen.at(-1)?.content ?? '';
          return last.includes('失败')
            ? fakeAnswer('查询失败，我拿不到汇率')
            : fakeAnswer(`汇率是 ${last} [tool:fetch_rate]`);
        }),
      },
    ],
    tools: () => {
      let attempts = 0;
      return new ToolRegistry().register({
        name: 'fetch_rate',
        description: '查汇率',
        schema: pairSchema,
        handler: async () => {
          attempts += 1;
          if (attempts === 1) throw new RetryableError('429 Too Many Requests');
          return '7.12';
        },
      });
    },
    assert: (result) => result.content.includes('7.12'),
  },
  {
    id: 'S-02 编造来源',
    title: '观测里没有的信息被当成事实交付',
    category: FAULT_CATEGORIES.hallucination,
    input: '订单 42 发货了吗',
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel('agent', (request) => {
          const seen = observations(request);
          if (seen.length === 0) return fakeToolCall('lookup_order', { id: '42' });
          const askedToFix = request.messages.some(
            (message) => message.role === 'user' && message.content.includes('核查'),
          );
          return askedToFix
            ? fakeAnswer('订单 42 于 2026-09-01 创建，没有物流信息 [tool:lookup_order]')
            : fakeAnswer('订单 42 已发货，物流单号 SF123456 [tool:orders_api]');
        }),
      },
    ],
    tools: () =>
      new ToolRegistry().register({
        name: 'lookup_order',
        description: '查订单',
        schema: idSchema,
        handler: async () => '订单 42：2026-09-01 创建',
      }),
    assert: (result) =>
      result.content.includes('[tool:lookup_order]') &&
      !result.content.includes('SF123456') &&
      !result.content.includes('orders_api'),
  },
  {
    id: 'S-03 重复调用',
    title: '模型用同样的参数反复调同一个工具（工具误用）',
    category: FAULT_CATEGORIES.toolMisuse,
    input: '读一下备忘录',
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel('agent', (request) => {
          const seen = observations(request);
          if (seen.length < 2) return fakeToolCall('read_note', { key: 'note' });
          return fakeAnswer(`我读到了：${seen.at(-1)?.content ?? ''} [tool:read_note]`);
        }),
      },
    ],
    tools: () => countingTool('read_note', '备忘录'),
    assert: (result) =>
      result.content.includes('第 1 次') && !result.content.includes('第 2 次'),
  },
  {
    id: 'S-04 两工具横跳',
    title: '模型在查与改之间来回横跳，永不收敛（死循环）',
    category: FAULT_CATEGORIES.loop,
    input: '把订单 42 处理一下',
    options: { maxSteps: 8 },
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel('agent', (request) => {
          const seen = observations(request);
          const last = seen.at(-1)?.name;
          return last === 'lookup_order'
            ? fakeToolCall('update_order', { id: '42' })
            : fakeToolCall('lookup_order', { id: '42' });
        }),
      },
    ],
    tools: () =>
      new ToolRegistry()
        .register({
          name: 'lookup_order',
          description: '查订单',
          schema: idSchema,
          handler: async () => '订单 42：待发货',
        })
        .register({
          name: 'update_order',
          description: '改订单',
          schema: idSchema,
          handler: async () => '订单 42：已更新',
        }),
    // 这一类要的不是「答对」，是「及早发现自己在绕圈」
    assert: (result) => result.stopReason === 'loop_detected',
  },
  {
    id: 'S-05 观测撑爆上下文',
    title: '工具返回超长结果，把上下文顶爆',
    category: FAULT_CATEGORIES.contextOverflow,
    input: '把记录导出来给我',
    budget: { maxTokens: 400, maxToolResultTokens: 100 },
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel(
          'agent',
          (request) => {
            const seen = observations(request);
            if (seen.length === 0) return fakeToolCall('dump_records', {});
            return fakeAnswer(`查到了：${(seen.at(-1)?.content ?? '').slice(0, 12)} [tool:dump_records]`);
          },
          { contextLimitTokens: 500 },
        ),
      },
    ],
    tools: () =>
      new ToolRegistry().register({
        name: 'dump_records',
        description: '导出记录',
        schema: z.object({}),
        handler: async () => `第 42 号记录：${'x'.repeat(6_000)}`,
      }),
    assert: (result) => result.stopReason === 'completed' && result.content.includes('第 42 号记录'),
  },
  {
    id: 'S-06 主供应商 502',
    title: '主供应商持续 502，应转移到备用供应商',
    category: FAULT_CATEGORIES.providerFailure,
    input: '2+3 等于几',
    providers: (recorder) => [
      {
        key: 'primary',
        label: 'Primary',
        model: new ScriptedModel('primary', async () => {
          // 注入点：主供应商在这一刻挂了。基线没有转移层，这条故障就停在 open 里。
          recorder.injectFault(FAULT_CATEGORIES.providerFailure);
          throw new RetryableError('502 Bad Gateway');
        }),
      },
      {
        key: 'backup',
        label: 'Backup',
        model: new ScriptedModel('backup', () => fakeAnswer('备用供应商回答：2+3=5')),
      },
    ],
    tools: () => new ToolRegistry(),
    assert: (result) => result.stopReason === 'completed' && result.content.includes('2+3=5'),
  },
  {
    id: 'S-07 中断后续跑',
    title: '任务执行到一半被打断，应能续跑且不重复副作用（用户中断）',
    category: FAULT_CATEGORIES.userInterrupt,
    input: '把结论写进笔记',
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel('agent', (request) => {
          const seen = observations(request);
          if (seen.length === 0) return fakeToolCall('write_note', { id: 'note' });
          return fakeAnswer(`笔记写好了：${seen.at(-1)?.content ?? ''} [tool:write_note]`);
        }),
      },
    ],
    assert: (result) =>
      result.content.includes('第 1 次') && !result.content.includes('第 2 次'),
    execute: async (context) => {
      const controller = new AbortController();
      const store = new InMemoryCheckpointStore();
      const hardened = context.variant === 'hardened';
      // 副作用计数按「一次场景运行」重置：中断后续跑不能重新计数
      const tools = countingToolWithAbort('write_note', '笔记', () => {
        // 注入点：用户在这一刻按了停止
        context.recorder.injectFault(FAULT_CATEGORIES.userInterrupt);
        controller.abort();
      });
      const options: AgentLoopOptions = hardened
        ? { checkpoint: { store, id: 'S-07' }, signal: controller.signal }
        : { signal: controller.signal };

      const first = await context.assemble({ tools, options }).run();
      if (first.stopReason !== 'cancelled') return first;

      if (!hardened) {
        // 裸循环没有检查点：只能从头再来一遍，副作用于是发生第二次
        const restart = context.assemble({ tools, options: { signal: undefined } });
        return restart.run();
      }

      const resumed = context.assemble({
        tools,
        options: { checkpoint: { store, id: 'S-07' } },
      });
      const result = await resumed.resume();
      // 恢复点：靠检查点续跑，没有重跑已经生效的副作用
      if (result.stopReason === 'completed') {
        context.recorder.recoverFault(FAULT_CATEGORIES.userInterrupt, undefined, 1);
      }
      return result;
    },
  },
  {
    id: 'S-08 工作区不可写',
    title: '工作区挂载成只读，应在任务开始前就被预检挡住（终端环境异常）',
    category: FAULT_CATEGORIES.terminal,
    input: '把结论写进文件',
    providers: () => [
      {
        key: 'fake',
        label: 'Fake',
        model: new ScriptedModel('agent', (request) => {
          const seen = observations(request);
          if (seen.length === 0) return fakeToolCall('write_file', { path: 'note.txt', content: 'hello' });
          return fakeAnswer(`写入结果：${(seen.at(-1)?.content ?? '').slice(0, 60)}`);
        }),
      },
    ],
    assert: (result) => result.toolCalls.length === 0 && /只读|权限/.test(result.content),
    execute: async (context) => {
      const root = await makeBlockedWorkspace();
      if (context.variant === 'hardened') {
        // 加固：预检先跑，环境问题在花掉任何 token 之前就被拦下
        context.recorder.injectFault(FAULT_CATEGORIES.terminal);
        const report = await runPreflight({ workspaceRoot: root, allowedCommands: DEFAULT_ALLOWED_COMMANDS });
        const blocked = report.checks.some((check) => !check.ok);
        if (blocked) context.recorder.recoverFault(FAULT_CATEGORIES.terminal, undefined, 1);
        return syntheticResult(formatPreflightReport(report));
      }
      // 基线：跳过预检，任务照常开始，写到一半才失败
      const tools = new ToolRegistry().registerAll(
        createBuiltinTools({ workspaceRoot: root, writeRequiresConfirmation: false }),
      );
      return context
        .assemble({
          tools,
          options: { sourceConstraint: { enabled: false }, selfCheck: { enabled: false } },
        })
        .run();
    },
  },
];

/** 执行一次就中止控制器的计数工具（用来模拟用户中途按停止）。 */
function countingToolWithAbort(name: string, label: string, onRun: () => void): ToolRegistry {
  let executions = 0;
  return new ToolRegistry().register({
    name,
    description: `${label}（返回第几次执行）`,
    schema: idSchema,
    handler: async () => {
      executions += 1;
      onRun();
      return `${label}：第 ${executions} 次执行的结果`;
    },
  });
}

/** 造一个「路径是一个文件、没法当目录用」的工作区，稳定复现只读/不可写。 */
async function makeBlockedWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'joy-agent-eval-'));
  const blocked = join(dir, 'readonly');
  await writeFile(blocked, 'this path is a file, not a writable directory', 'utf8');
  return blocked;
}

/** 把预检报告包成一次「没有开始执行」的运行结果，好让统一口径读它。 */
function syntheticResult(content: string): AgentRunResult {
  return {
    content,
    steps: 0,
    stopReason: 'cancelled',
    messages: [],
    toolCalls: [],
    // 预检在模型调用之前就拦下了：这次没有供应商 usage，按口径记 null（不写 0）
    usage: {},
  };
}
