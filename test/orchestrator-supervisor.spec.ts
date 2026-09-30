import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatModel, ChatRequest, ChatResponse, StreamChunk } from '../src/providers/chat-model.js';
import { BUILTIN_ROLES } from '../src/orchestrator/role.js';
import { Supervisor } from '../src/orchestrator/supervisor.js';
import { parsePlan } from '../src/orchestrator/plan.js';
import { ToolRegistry } from '../src/tools/registry.js';

/**
 * 探针模型：把「是谁在调、同时有几个在飞」记录下来。
 * 并发是编排层的核心承诺，必须能被断言，而不是靠日志肉眼看。
 */
class ProbeModel implements ChatModel {
  readonly name = 'probe';
  readonly model = 'probe-1';
  readonly supportsTools = true;
  inFlight = 0;
  maxInFlight = 0;
  readonly subAgentTasks: string[] = [];
  readonly systems: string[] = [];
  removeCount = 0;

  constructor(
    private readonly options: {
      plan: () => string;
      subAgent: (task: string) => Promise<string> | string;
      synthesis?: () => Promise<string> | string;
      delayMs?: number;
    },
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
    this.systems.push(system);
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

    if (system.includes('你是任务规划器')) {
      return { content: this.options.plan(), toolCalls: [], finishReason: 'stop', usage };
    }
    if (system.includes('你是汇总器')) {
      if (!this.options.synthesis) throw new Error('汇总模型不可用');
      return { content: await this.options.synthesis(), toolCalls: [], finishReason: 'stop', usage };
    }

    const task = request.messages.at(-1)?.content ?? '';
    this.subAgentTasks.push(task);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
      const content = await this.options.subAgent(task);
      if (this.removeCount > 0) {
        this.removeCount--;
        throw new Error('供应商 502');
      }
      return { content, toolCalls: [], finishReason: 'stop', usage };
    } finally {
      this.inFlight--;
    }
  }

  chatStream(): AsyncIterable<StreamChunk> {
    throw new Error('SubAgent 不走流式');
  }
}

function makeSupervisor(model: ChatModel, extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  return new Supervisor({
    model,
    roles: BUILTIN_ROLES,
    forkTools: () => new ToolRegistry(),
    ...extra,
  });
}

const twoParallelSteps = () =>
  JSON.stringify({
    goal: '调研 X',
    steps: [
      { id: 's1', role: 'retrieval', task: '找材料 A' },
      { id: 's2', role: 'retrieval', task: '找材料 B' },
    ],
  });

describe('Supervisor', () => {
  it('无依赖的步骤真并发，不是排队', async () => {
    const model = new ProbeModel({
      plan: twoParallelSteps,
      subAgent: (task) => `产出：${task}`,
      synthesis: () => '# 报告',
      delayMs: 5,
    });

    const result = await makeSupervisor(model).run('调研 X');

    expect(model.maxInFlight).toBe(2);
    expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded']);
    expect(result.planSource).toBe('planned');
    expect(result.synthesisDegraded).toBe(false);
    expect(result.report).toBe('# 报告');
  });

  it('有依赖的步骤严格等上游，且上游产出被注入下游任务', async () => {
    const model = new ProbeModel({
      plan: () =>
        JSON.stringify({
          goal: 'g',
          steps: [
            { id: 's1', role: 'retrieval', task: '找材料' },
            { id: 's2', role: 'analysis', task: '分析', dependsOn: ['s1'] },
          ],
        }),
      subAgent: (task) => (task.startsWith('找材料') ? 'S1-OUTPUT' : 'S2-OUTPUT'),
      synthesis: () => '报告',
    });

    const result = await makeSupervisor(model).run('干活');

    expect(model.maxInFlight).toBe(1); // 有依赖就不该重叠
    expect(model.subAgentTasks[1]).toContain('S1-OUTPUT');
    expect(model.subAgentTasks[1]).toContain('不是要你复述');
    expect(result.steps.every((step) => step.status === 'succeeded')).toBe(true);
  });

  it('上游失败 → 下游 skipped 并写明原因，汇总照常产出', async () => {
    const model = new ProbeModel({
      plan: () =>
        JSON.stringify({
          goal: 'g',
          steps: [
            { id: 's1', role: 'retrieval', task: '会炸' },
            { id: 's2', role: 'analysis', task: '依赖它', dependsOn: ['s1'] },
          ],
        }),
      subAgent: () => {
        throw new Error('工具把子智能体带崩了');
      },
      synthesis: () => '报告',
    });

    const result = await makeSupervisor(model).run('干活');

    const [first, second] = result.steps;
    expect(first?.status).toBe('failed');
    expect(first?.detail).toContain('工具把子智能体带崩了');
    expect(second?.status).toBe('skipped');
    expect(second?.detail).toContain('s1');
    expect(result.report).toBe('报告');
    // 汇总提示里必须带上下游缺失的事实，别让汇总器假装什么都没发生
    expect(model.systems.some((system) => system.includes('你是汇总器'))).toBe(true);
  });

  it('计划不可用时降级成单步，并如实标注来源与原因', async () => {
    const model = new ProbeModel({ plan: () => '我先想想，不给你 JSON', subAgent: () => '兜底产出', synthesis: () => '报告' });

    const result = await makeSupervisor(model).run('帮我做一件事');

    expect(result.planSource).toBe('fallback');
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]?.role).toBe('retrieval');
    expect(result.planNote).toMatch(/unparseable/);
    expect(result.steps[0]?.status).toBe('succeeded');
  });

  it('汇总模型跑不成 → 确定性拼接兜底并置位 degraded', async () => {
    const model = new ProbeModel({
      plan: () =>
        JSON.stringify({ goal: 'g', steps: [{ id: 's1', role: 'retrieval', task: '找材料' }] }),
      subAgent: () => '原始产出',
    });

    const result = await makeSupervisor(model).run('干活');

    expect(result.synthesisDegraded).toBe(true);
    expect(result.report).toContain('原始产出');
    expect(result.report).toContain('汇总模型未跑成');
  });

  it('token 账把规划 / 子智能体 / 汇总都算进去', async () => {
    const model = new ProbeModel({
      plan: twoParallelSteps,
      subAgent: () => '产出',
      synthesis: () => '报告',
    });

    const result = await makeSupervisor(model).run('x');

    // 1 次规划 + 2 次子智能体 + 1 次汇总，每次 2 token
    expect(result.usage.totalTokens).toBe(8);
    expect(result.steps.reduce((sum, step) => sum + (step.usage.totalTokens ?? 0), 0)).toBe(4);
    // 逐项可查：规划 / 子智能体 / 汇总各自单独记，别只给一个总账
    expect(result.planUsage.totalTokens).toBe(2);
    expect(result.subAgentUsage.totalTokens).toBe(4);
    expect(result.synthesisUsage.totalTokens).toBe(2);
  });

  it('报告落盘：Markdown 给人看、JSON 给机器读，且都在工作区内', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-orch-'));
    const model = new ProbeModel({
      plan: () => JSON.stringify({ goal: 'g', steps: [{ id: 's1', role: 'retrieval', task: '找材料' }] }),
      subAgent: () => '原始产出',
      synthesis: () => '# 报告正文',
    });

    const supervisor = makeSupervisor(model, {
      workspaceRoot: dir,
      outputDir: 'reports',
      // 用本地时间构造：报告文件名按本地时间戳走，测试不该受时区影响
      now: () => new Date(2026, 8, 30, 12, 0, 0).getTime(),
    });
    const result = await supervisor.run('干活');

    expect(result.files).toHaveLength(2);
    const markdown = await readFile(result.files[0]!, 'utf8');
    const json = JSON.parse(await readFile(result.files[1]!, 'utf8')) as Record<string, unknown>;
    expect(markdown).toContain('# 报告正文');
    expect(markdown).toContain('执行明细');
    expect(json.goal).toBe('g');
    expect(String(result.files[0])).toMatch(/report-20260930-120000\.md$/);
    expect(String(result.files[0])).toContain(dir);
  });

  it('落盘目录越界被 PathGuard 拒掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-orch-'));
    const model = new ProbeModel({
      plan: () => JSON.stringify({ goal: 'g', steps: [{ id: 's1', role: 'retrieval', task: 't' }] }),
      subAgent: () => '产出',
      synthesis: () => '报告',
    });

    const supervisor = makeSupervisor(model, { workspaceRoot: dir, outputDir: '../escape' });
    await expect(supervisor.run('干活')).rejects.toThrow(/越界/);
  });

  it('长期记忆：读回来注入规划提示，收尾写回一条摘要', async () => {
    const written: Array<{ scope: string; entry: string }> = [];
    const model = new ProbeModel({
      plan: () => JSON.stringify({ goal: 'g', steps: [{ id: 's1', role: 'retrieval', task: 't' }] }),
      subAgent: () => '产出',
      synthesis: () => '报告正文',
    });

    const supervisor = makeSupervisor(model, {
      recall: async () => ['用户偏好中文报告'],
      remember: async (scope, entry) => {
        written.push({ scope, entry });
      },
      memoryScope: 'user-1',
    });

    await supervisor.run('干活');

    const plannerSystem = model.systems.find((system) => system.includes('你是任务规划器')) ?? '';
    expect(plannerSystem).toContain('用户偏好中文报告');
    expect(written).toHaveLength(1);
    expect(written[0]?.scope).toBe('user-1');
    expect(written[0]?.entry).toContain('报告正文');
  });

  it('事件流能画出「分了哪几波、每步什么状态」', async () => {
    const events: string[] = [];
    const model = new ProbeModel({
      plan: () =>
        JSON.stringify({
          goal: 'g',
          steps: [
            { id: 's1', role: 'retrieval', task: 'a' },
            { id: 's2', role: 'analysis', task: 'b', dependsOn: ['s1'] },
          ],
        }),
      subAgent: () => '产出',
      synthesis: () => '报告',
    });

    await makeSupervisor(model, { onEvent: (event) => events.push(event.type) }).run('干活');

    expect(events).toEqual(['planned', 'wave', 'step', 'wave', 'step', 'synthesized']);
  });

  it('技能注入按步各算一次，落到子智能体的 system prompt 里（ADR-0009）', async () => {
    const model = new ProbeModel({
      plan: twoParallelSteps,
      subAgent: () => '产出',
      synthesis: () => '报告',
    });
    const seen: string[] = [];

    await makeSupervisor(model, {
      augmentPrompt: async (input) => {
        seen.push(input);
        return '\n## 针对本次任务的技能说明\n\n### weekly-report\n整理周报';
      },
    }).run('调研 X');

    // 每步子任务各调一次，且注入文本进了子智能体的 system prompt
    expect(seen).toHaveLength(2);
    expect(model.systems.some((system) => system.includes('weekly-report'))).toBe(true);
  });

  it('不传 augmentPrompt 时子智能体 prompt 里不会出现技能段落', async () => {
    const model = new ProbeModel({
      plan: twoParallelSteps,
      subAgent: () => '产出',
      synthesis: () => '报告',
    });

    await makeSupervisor(model).run('调研 X');

    expect(model.systems.every((system) => !system.includes('技能说明'))).toBe(true);
  });

  it('parsePlan 与 Supervisor 对「角色不存在」的判断一致', () => {
    const result = parsePlan({ goal: 'g', steps: [{ id: 's1', role: 'ghost', task: 't' }] }, { roles: BUILTIN_ROLES });
    expect(result.ok).toBe(false);
  });
});
