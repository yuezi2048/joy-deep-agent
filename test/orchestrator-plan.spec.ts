import { describe, expect, it } from 'vitest';
import { parsePlan } from '../src/orchestrator/plan.js';
import { Planner, buildPlannerPrompt } from '../src/orchestrator/planner.js';
import { BUILTIN_ROLES, type AgentRole } from '../src/orchestrator/role.js';
import { FakeChatModel, answerTurn } from './helpers/fake-model.js';

const roles = BUILTIN_ROLES;
const options = { roles };

function planJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: '调研 X',
    steps: [
      { id: 's1', role: 'retrieval', task: '找材料' },
      { id: 's2', role: 'analysis', task: '分析材料', dependsOn: ['s1'] },
    ],
    ...overrides,
  });
}

describe('parsePlan（纯校验，不做降级）', () => {
  it('合法计划照单全收', () => {
    const result = parsePlan(JSON.parse(planJson()), options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(false);
    expect(result.plan.goal).toBe('调研 X');
    expect(result.plan.steps.map((step) => step.id)).toEqual(['s1', 's2']);
    expect(result.plan.steps[1]?.dependsOn).toEqual(['s1']);
  });

  it('缺 id 时按序号补齐并如实标记 repaired', () => {
    const result = parsePlan(
      { goal: 'g', steps: [{ role: 'retrieval', task: 'a' }, { role: 'writing', task: 'b' }] },
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(true);
    expect(result.plan.steps.map((step) => step.id)).toEqual(['s1', 's2']);
  });

  it('逐类非法输入都给出可读理由，而不是抛异常', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['不是对象', /必须是一个 JSON 对象/],
      [{ steps: [{ role: 'writing', task: 'x' }] }, /goal 必须是非空字符串/],
      [{ goal: 'g' }, /steps 必须是非空数组/],
      [{ goal: 'g', steps: [] }, /steps 必须是非空数组/],
      [{ goal: 'g', steps: [{ role: 'nope', task: 'x' }] }, /不存在的角色 "nope"/],
      [{ goal: 'g', steps: [{ role: 'writing' }] }, /task 是空的/],
      [{ goal: 'g', steps: [{ id: 'a', role: 'writing', task: 'x' }, { id: 'a', role: 'writing', task: 'y' }] }, /id "a" 重复/],
      [{ goal: 'g', steps: [{ id: 'a', role: 'writing', task: 'x', dependsOn: ['ghost'] }] }, /不存在的步骤 "ghost"/],
      [{ goal: 'g', steps: [{ id: 'a', role: 'writing', task: 'x', dependsOn: ['a'] }] }, /依赖了自己/],
      [{ goal: 'g', steps: [{ id: 'a', role: 'writing', task: 'x', dependsOn: 'b' }] }, /必须是字符串数组/],
    ];

    for (const [input, pattern] of cases) {
      let result: ReturnType<typeof parsePlan>;
      expect(() => {
        result = parsePlan(input, options);
      }).not.toThrow();
      expect(result!.ok).toBe(false);
      if (!result!.ok) expect(result!.detail).toMatch(pattern);
    }
  });

  it('成环与超步数上限都被拦下', () => {
    const cyclic = parsePlan(
      {
        goal: 'g',
        steps: [
          { id: 'a', role: 'writing', task: 'x', dependsOn: ['b'] },
          { id: 'b', role: 'writing', task: 'y', dependsOn: ['a'] },
        ],
      },
      options,
    );
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.detail).toMatch(/成环/);

    const tooMany = parsePlan(
      { goal: 'g', steps: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, role: 'writing', task: 'x' })) },
      options,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.detail).toMatch(/超过上限 6 步/);
  });
});

describe('Planner（产出 + 分类失败原因）', () => {
  const planner = (model: FakeChatModel, extra: Partial<{ maxSteps: number; memories: string[] }> = {}) =>
    new Planner({ model, roles, ...(extra.maxSteps !== undefined ? { maxSteps: extra.maxSteps } : {}) });

  it('正常规划：返回计划与原样 token 账', async () => {
    const model = new FakeChatModel([
      { content: planJson(), toolCalls: [], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ]);

    const outcome = await planner(model).plan({ input: '帮我调研 X' });

    expect(outcome.kind).toBe('planned');
    if (outcome.kind !== 'planned') return;
    expect(outcome.plan.steps).toHaveLength(2);
    expect(outcome.usage?.totalTokens).toBe(15);
  });

  it('包了围栏、前后带解释文字也能容错抽出，并标记 repaired', async () => {
    const model = new FakeChatModel([
      answerTurn(`好的，这是计划：\n\`\`\`json\n${planJson()}\n\`\`\`\n需要我再调整吗？`),
    ]);

    const outcome = await planner(model).plan({ input: 'x' });

    expect(outcome.kind).toBe('planned');
    if (outcome.kind !== 'planned') return;
    expect(outcome.repaired).toBe(true);
  });

  it('被 max_tokens 截断单独归类为 truncated，不与解析失败混为一谈', async () => {
    const model = new FakeChatModel([
      { content: '{"goal":"g","steps":[{"id":"s1","role":"retrie', toolCalls: [], finishReason: 'length' },
    ]);

    const outcome = await planner(model).plan({ input: 'x' });

    expect(outcome).toMatchObject({ kind: 'unplanned', code: 'truncated' });
    if (outcome.kind === 'unplanned') expect(outcome.detail).toMatch(/截断/);
  });

  it('空输出 / 非 JSON / 计划非法 分别给 empty、unparseable、invalid', async () => {
    const empty = await planner(new FakeChatModel([answerTurn('   ')])).plan({ input: 'x' });
    expect(empty).toMatchObject({ kind: 'unplanned', code: 'empty' });

    const garbage = await planner(new FakeChatModel([answerTurn('我想想…先不给你 JSON 了')])).plan({ input: 'x' });
    expect(garbage).toMatchObject({ kind: 'unplanned', code: 'unparseable' });

    const invalid = await planner(new FakeChatModel([answerTurn('{"goal":"g","steps":[{"role":"ghost","task":"x"}]}')])).plan({
      input: 'x',
    });
    expect(invalid).toMatchObject({ kind: 'unplanned', code: 'invalid' });
    if (invalid.kind === 'unplanned') expect(invalid.detail).toMatch(/ghost/);
  });

  it('长期记忆与角色清单都进了提示，且规划时不带工具', async () => {
    const model = new FakeChatModel([answerTurn(planJson())]);
    await planner(model).plan({ input: 'x', memories: ['上次用户偏好中文报告'] });

    const request = model.calls[0];
    const system = request?.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(system).toContain('上次用户偏好中文报告');
    expect(system).toContain('retrieval');
    expect(system).toContain('无工具');
    expect(request?.tools).toBeUndefined();
  });

  it('提示里如实写出各角色的工具范围', () => {
    const custom: AgentRole[] = [
      { name: 'x', title: 'X', description: 'd', systemPrompt: 's', allowedTools: ['calculator'] },
      { name: 'y', title: 'Y', description: 'd', systemPrompt: 's' },
    ];
    const prompt = buildPlannerPrompt(custom, []);
    expect(prompt).toContain('【可用工具：calculator】');
    expect(prompt).toContain('【可用工具：全部工具】');
  });
});
