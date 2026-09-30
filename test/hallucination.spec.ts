import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { ChatMessage } from '../src/core/types.js';
import { checkCitations, CITATION_INSTRUCTION } from '../src/robust/citation-guard.js';
import { SelfChecker } from '../src/robust/self-check.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, StubChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

function lookupTool(handler = async ({ key }: { key: string }) => `订单 ${key}：2026-09-01 创建`) {
  const definition = {
    name: 'lookup',
    description: '查订单',
    schema: z.object({ key: z.string() }),
    handler,
  };
  return new ToolRegistry().register(definition);
}

const toolMessage = (name: string, id: string, content: string): ChatMessage => ({
  role: 'tool',
  name,
  toolCallId: id,
  content,
});

describe('来源约束（确定性那一半）', () => {
  it('标注了从没得到过的来源 → 判定为编造', () => {
    const messages: ChatMessage[] = [toolMessage('lookup', 'c1', '订单 42：已创建')];

    const report = checkCitations('订单 42 已发货 [tool:orders_api]', messages);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.kind).toBe('unknown-source');
    expect(report.findings[0]?.detail).toContain('orders_api');
  });

  it('标注了真实来源就放行（含带调用 id 的写法）', () => {
    const messages: ChatMessage[] = [toolMessage('lookup', 'c1', '订单 42：已创建')];

    expect(checkCitations('订单 42 已创建 [tool:lookup]', messages).ok).toBe(true);
    expect(checkCitations('订单 42 已创建 [tool:lookup#c1]', messages).ok).toBe(true);
    // id 对不上也算编造
    expect(checkCitations('订单 42 已创建 [tool:lookup#c9]', messages).ok).toBe(false);
  });

  it('用过工具却没有任何标注 → 无来源支撑', () => {
    const messages: ChatMessage[] = [toolMessage('lookup', 'c1', '订单 42：已创建')];

    const report = checkCitations('订单 42 已经发货了', messages);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.kind).toBe('missing-citation');
  });

  it('纯聊天（没用过工具）不检查，避免误伤', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '你好' }];

    expect(checkCitations('你好，我能帮你做什么？', messages).ok).toBe(true);
  });

  it('requireCitation 关掉后只查编造来源，不要求必须标注', () => {
    const messages: ChatMessage[] = [toolMessage('lookup', 'c1', '订单 42：已创建')];

    expect(checkCitations('订单 42 已创建', messages, { requireCitation: false }).ok).toBe(true);
    expect(checkCitations('订单 42 已发货 [tool:x]', messages, { requireCitation: false }).ok).toBe(
      false,
    );
  });
});

describe('自我核查（模型判断那一半）', () => {
  it('核查不通过时返回具体问题；通过时放行', async () => {
    const verifier = new StubChatModel('verifier', async () =>
      answerTurn('{"ok": false, "issues": ["观测里没有物流信息"]}'),
    );
    const checker = new SelfChecker(verifier);

    const verdict = await checker.check({
      question: '订单 42 发货了吗',
      answer: '已经发货了',
      messages: [toolMessage('lookup', 'c1', '订单 42：2026-09-01 创建')],
    });

    expect(verdict).toEqual({ ok: false, issues: ['观测里没有物流信息'], degraded: false });
    // 核查请求里带上了问题、观测与待交付答案
    const prompt = verifier.requests[0]?.messages.at(-1)?.content ?? '';
    expect(prompt).toContain('订单 42 发货了吗');
    expect(prompt).toContain('2026-09-01 创建');
    expect(prompt).toContain('已经发货了');
  });

  it('核查器给不出可用结论时降级，不假装检查过', async () => {
    const checker = new SelfChecker(new StubChatModel('verifier', async () => answerTurn('我觉得还行')));

    const verdict = await checker.check({ question: 'q', answer: 'a', messages: [] });

    expect(verdict.ok).toBe(true);
    expect(verdict.degraded).toBe(true);
    expect(verdict.degradedReason).toContain('没有给出可用结论');
  });

  it('核查器本身调用失败也算降级，不阻断交付', async () => {
    const checker = new SelfChecker(
      new StubChatModel('verifier', async () => {
        throw new Error('502 Bad Gateway');
      }),
    );

    const verdict = await checker.check({ question: 'q', answer: 'a', messages: [] });

    expect(verdict.degraded).toBe(true);
    expect(verdict.degradedReason).toContain('502');
  });
});

describe('AgentLoop · 交付前核查', () => {
  it('编造来源被拦下，把具体问题回灌后模型修正再交付', async () => {
    const tools = lookupTool();
    const model = new FakeChatModel([
      toolTurn('lookup', { key: '42' }),
      answerTurn('订单 42 已发货，物流单号 SF123 [tool:orders_api]'),
      answerTurn('订单 42 已创建，我这边查不到物流信息 [tool:lookup]'),
    ]);

    const result = await new AgentLoop({
      model,
      tools,
      options: { sourceConstraint: { enabled: true } },
    }).run('订单 42 发货了吗');

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('订单 42 已创建，我这边查不到物流信息 [tool:lookup]');
    // 回灌的问题里点名了编造的来源
    const feedback = model.calls[2]?.messages.at(-1);
    expect(feedback?.role).toBe('user');
    expect(feedback?.content).toContain('orders_api');
    expect(result.verification).toMatchObject({ passed: true, rounds: 1, degraded: false });
  });

  it('有依据的正常回答一次放行，不做多余往返', async () => {
    const tools = lookupTool();
    const model = new FakeChatModel([
      toolTurn('lookup', { key: '42' }),
      answerTurn('订单 42 于 2026-09-01 创建 [tool:lookup]'),
    ]);

    const result = await new AgentLoop({
      model,
      tools,
      options: { sourceConstraint: { enabled: true } },
    }).run('订单 42 什么时候创建的');

    expect(result.content).toBe('订单 42 于 2026-09-01 创建 [tool:lookup]');
    expect(model.calls).toHaveLength(2); // 没有多出来的核查往返
    expect(result.verification).toMatchObject({ passed: true, rounds: 0 });
  });

  it('用过工具却没有任何来源标注时被要求补上', async () => {
    const tools = lookupTool();
    const model = new FakeChatModel([
      toolTurn('lookup', { key: '42' }),
      answerTurn('订单 42 已经发货了'),
      answerTurn('订单 42 于 2026-09-01 创建，没有发货记录 [tool:lookup]'),
    ]);

    const result = await new AgentLoop({
      model,
      tools,
      options: { sourceConstraint: { enabled: true } },
    }).run('订单 42 发货了吗');

    expect(result.content).toContain('[tool:lookup]');
    expect(model.calls[2]?.messages.at(-1)?.content).toContain('来源标注');
    expect(result.verification?.passed).toBe(true);
  });

  it('开关默认关闭：不改变原有行为', async () => {
    const tools = lookupTool();
    const model = new FakeChatModel([
      toolTurn('lookup', { key: '42' }),
      answerTurn('订单 42 已经发货了 [tool:orders_api]'),
    ]);

    const result = await new AgentLoop({ model, tools }).run('订单 42 发货了吗');

    expect(result.content).toBe('订单 42 已经发货了 [tool:orders_api]');
    expect(model.calls).toHaveLength(2);
    expect(result.verification).toBeUndefined();
  });

  it('纯聊天不误伤：即使开着来源约束也直接交付', async () => {
    const model = new FakeChatModel([answerTurn('你好，我可以帮你查订单。')]);

    const result = await new AgentLoop({
      model,
      tools: new ToolRegistry(),
      options: { sourceConstraint: { enabled: true } },
    }).run('你好');

    expect(result.content).toBe('你好，我可以帮你查订单。');
    expect(model.calls).toHaveLength(1);
    expect(result.verification).toMatchObject({ passed: true, rounds: 0 });
  });

  it('开启后 system prompt 里带上了标注规范', async () => {
    const model = new FakeChatModel([answerTurn('好')]);

    await new AgentLoop({
      model,
      tools: new ToolRegistry(),
      options: { sourceConstraint: { enabled: true } },
    }).run('你好');

    expect(model.calls[0]?.messages[0]?.content).toContain('[tool:工具名]');
    expect(model.calls[0]?.messages[0]?.content).toContain(CITATION_INSTRUCTION.slice(0, 10));
  });
});

describe('AgentLoop · 自我核查回灌', () => {
  /** 核查模型：先判不通过并给理由，再判通过。 */
  function verifierScript(verdicts: string[]) {
    const remaining = [...verdicts];
    return new StubChatModel('verifier', async () => answerTurn(remaining.shift() ?? '{"ok": true}'));
  }

  it('核查失败 → 把具体问题回灌 → 模型修正 → 核查通过后交付', async () => {
    const tools = lookupTool();
    const verifier = verifierScript([
      '{"ok": false, "issues": ["观测里没有物流单号，SF123 是编的"]}',
      '{"ok": true, "issues": []}',
    ]);
    const model = new FakeChatModel([
      toolTurn('lookup', { key: '42' }),
      answerTurn('订单 42 已发货，物流单号 SF123'),
      answerTurn('订单 42 于 2026-09-01 创建，没有查到物流信息 [tool:lookup]'),
    ]);

    const result = await new AgentLoop({
      model,
      tools,
      options: {
        sourceConstraint: { enabled: true },
        selfCheck: { enabled: true, model: verifier },
      },
    }).run('订单 42 发货了吗');

    expect(verifier.calls).toBe(2);
    expect(result.content).toBe('订单 42 于 2026-09-01 创建，没有查到物流信息 [tool:lookup]');
    expect(model.calls[2]?.messages.at(-1)?.content).toContain('SF123 是编的');
    expect(result.verification).toMatchObject({ passed: true, rounds: 1, degraded: false });
  });

  it('核查器不可用时不阻断交付，但如实标记 degraded', async () => {
    const tools = lookupTool();
    const verifier = new StubChatModel('verifier', async () => answerTurn('我觉得没问题'));
    const model = new FakeChatModel([
      toolTurn('lookup', { key: '42' }),
      answerTurn('订单 42 于 2026-09-01 创建 [tool:lookup]'),
    ]);

    const result = await new AgentLoop({
      model,
      tools,
      options: {
        sourceConstraint: { enabled: true },
        selfCheck: { enabled: true, model: verifier },
      },
    }).run('订单 42 什么时候创建的');

    expect(result.content).toContain('2026-09-01');
    expect(model.calls).toHaveLength(2); // 没有因为核查降级多绕一圈
    expect(result.verification).toMatchObject({ passed: true, degraded: true });
    expect(result.verification?.degradedReason).toContain('没有给出可用结论');
  });

  it('修正轮数用尽后照样交付，但如实记录没通过', async () => {
    const tools = lookupTool();
    const model = new FakeChatModel([
      toolTurn('lookup', { key: '42' }),
      answerTurn('订单 42 已发货 [tool:orders_api]'),
      answerTurn('订单 42 已签收 [tool:orders_api]'),
      answerTurn('订单 42 在派件 [tool:orders_api]'),
    ]);

    const result = await new AgentLoop({
      model,
      tools,
      options: { sourceConstraint: { enabled: true }, selfCheck: { maxRounds: 2 } },
    }).run('订单 42 发货了吗');

    // 1 次原始回答 + 2 次修正后仍然编造 → 不再无限修下去
    expect(model.calls).toHaveLength(4);
    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('订单 42 在派件 [tool:orders_api]');
    expect(result.verification?.passed).toBe(false);
    expect(result.verification?.rounds).toBe(2);
    expect(result.stopDetail).toContain('交付前核查未通过');
  });
});
