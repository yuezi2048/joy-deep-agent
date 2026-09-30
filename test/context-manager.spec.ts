import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { ChatMessage } from '../src/core/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ContextManagedChatModel, withContextBudget } from '../src/robust/context-manager.js';
import { groupMessages, planSlidingWindow } from '../src/robust/sliding-window.js';
import { truncateToolResult } from '../src/robust/result-truncate.js';
import { estimateMessagesTokens, estimateTokens } from '../src/robust/token-counter.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

const assistantWithCalls = (id: string, name = 'fetch'): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: {}, rawArguments: '{}' }],
});

const toolResult = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  toolCallId: id,
  name: 'fetch',
  content,
});

/**
 * 校验结构合法性：任何 tool 结果都必须能找到对应的调用，
 * 且未配对的调用只允许出现在末尾（模型刚发起、结果还没回来的正常状态）。
 */
function pairingViolations(messages: readonly ChatMessage[]): string[] {
  const violations: string[] = [];
  const open = new Set<string>();

  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) open.add(call.id);
    }
    if (message.role === 'tool') {
      if (!message.toolCallId || !open.has(message.toolCallId)) {
        violations.push(`第 ${index} 条 tool 结果找不到对应调用`);
      } else {
        open.delete(message.toolCallId);
      }
    }
  });

  if (open.size > 0 && messages.at(-1)?.role !== 'assistant') {
    violations.push(`有 ${open.size} 个调用未配对，且不在末尾`);
  }
  return violations;
}

describe('token 估算口径', () => {
  it('CJK 按 1.5 token/字，其他按 4 字符/token', () => {
    expect(estimateTokens('你好世界')).toBe(6); // 4 × 1.5
    expect(estimateTokens('hello world')).toBe(3); // ceil(11 / 4)
  });

  it('同一长度下中文估值高于英文——取值偏保守', () => {
    const cjk = estimateTokens('一二三四五六七八九十');
    const ascii = estimateTokens('abcdefghij');
    expect(cjk).toBeGreaterThan(ascii);
  });

  it('空串为 0，且估值随内容单调不减', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBeLessThanOrEqual(estimateTokens('abcdef'));
  });

  it('工具调用本身计入预算（函数名 + 原始参数）', () => {
    const without = estimateMessagesTokens([{ role: 'assistant', content: 'hi' }]);
    const withCall = estimateMessagesTokens([
      {
        role: 'assistant',
        content: 'hi',
        toolCalls: [
          { id: 'c1', name: 'run_command', arguments: {}, rawArguments: '{"a":"b"}'.repeat(10) },
        ],
      },
    ]);
    expect(withCall).toBeGreaterThan(without);
  });
});

describe('工具结果截断', () => {
  it('未超限时原样返回', () => {
    expect(truncateToolResult('短内容', { maxTokens: 100 })).toEqual({
      content: '短内容',
      truncated: false,
      droppedChars: 0,
    });
  });

  it('超限时保留首尾、掐掉中段，并标注丢弃字符数', () => {
    const content = `HEAD${'x'.repeat(5000)}TAIL`;
    const outcome = truncateToolResult(content, { maxTokens: 50 });

    expect(outcome.truncated).toBe(true);
    expect(outcome.content).toContain('HEAD');
    expect(outcome.content).toContain('TAIL');
    expect(outcome.content).toContain('已截断');
    expect(outcome.droppedChars).toBeGreaterThan(0);
  });
});

describe('分组：tool_calls 与其结果不可分离', () => {
  it('tool 结果并入发起它的 assistant 所在组', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
      assistantWithCalls('c1'),
      toolResult('c1', '结果'),
      { role: 'assistant', content: '完成' },
    ];

    const { system, groups } = groupMessages(messages);

    expect(system).toHaveLength(1);
    expect(groups).toHaveLength(3);
    expect(groups[1]?.map((m) => m.role)).toEqual(['assistant', 'tool']);
  });
});

describe('滑动窗口', () => {
  it('预算紧张时按 keepRecentGroups 保底最近 N 组，其余全丢', () => {
    const many: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 10; i++) {
      many.push({ role: 'user', content: `第${i}问` });
      many.push({ role: 'assistant', content: `第${i}答` });
    }

    const outcome = planSlidingWindow(many, { maxTokens: 20, keepRecentGroups: 3 });

    expect(outcome.system).toHaveLength(1);
    expect(outcome.kept).toHaveLength(3);
    expect(outcome.dropped).toHaveLength(17); // 20 组 - 保留 3 组
  });

  it('预算充足时一组都不丢', () => {
    const many: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 10; i++) {
      many.push({ role: 'user', content: `第${i}问` });
      many.push({ role: 'assistant', content: `第${i}答` });
    }

    const outcome = planSlidingWindow(many, { maxTokens: 100_000, keepRecentGroups: 3 });
    expect(outcome.dropped).toHaveLength(0);
  });

  it('丢弃最旧而不是最新', () => {
    const many: ChatMessage[] = [
      { role: 'user', content: '最旧' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: '最新' },
      { role: 'assistant', content: 'b' },
    ];

    const outcome = planSlidingWindow(many, { maxTokens: 5, keepRecentGroups: 2 });
    const keptText = outcome.kept.flat().map((m) => m.content).join('|');
    expect(keptText).toContain('最新');
    expect(keptText).not.toContain('最旧');
  });

  it('预算充足时一条不丢', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    expect(planSlidingWindow(messages, { maxTokens: 10_000 }).dropped).toHaveLength(0);
  });

  it('不把 assistant 的调用和它的结果拆开', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'user', content: `问 ${i}` });
      messages.push(assistantWithCalls(`c${i}`));
      messages.push(toolResult(`c${i}`, 'x'.repeat(400)));
    }

    const plan = planSlidingWindow(messages, { maxTokens: 200, keepRecentGroups: 2 });
    const kept = [...plan.system, ...plan.kept.flat()];

    expect(pairingViolations(kept)).toEqual([]);
  });
});

describe('ContextManagedChatModel', () => {
  const build = (options = {}) => {
    const inner = new FakeChatModel([answerTurn('ok')]);
    return { inner, model: withContextBudget(inner, options) };
  };

  it('未超预算时原样透传，不做无谓改动', async () => {
    const { inner, model } = build({ maxTokens: 10_000 });
    await model.chat({ messages: [{ role: 'user', content: '你好' }] });

    expect(inner.calls[0]?.messages).toEqual([{ role: 'user', content: '你好' }]);
    expect(model.lastStats?.droppedGroups).toBe(0);
    expect(model.lastStats?.summarized).toBe(false);
  });

  it('超预算时收缩，并给出可读的收缩统计', async () => {
    const { model } = build({ maxTokens: 60, maxToolResultTokens: 20, summarize: false });
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `问 ${i}` });
      messages.push(assistantWithCalls(`c${i}`));
      messages.push(toolResult(`c${i}`, 'x'.repeat(600)));
    }

    const fitted = await model.fit(messages);

    expect(estimateMessagesTokens(fitted)).toBeLessThanOrEqual(60);
    expect(model.lastStats?.truncatedResults).toBeGreaterThan(0);
    expect(model.lastStats?.tokensAfter).toBeLessThan(model.lastStats!.tokensBefore);
  });

  it('丢弃的中段被压成摘要，且标注「已压缩」', async () => {
    const summarizer = vi.fn(async () => '早期做了 A、B 两件事');
    const { inner, model } = build({
      maxTokens: 60,
      maxToolResultTokens: 20,
      keepRecentGroups: 1,
      summarizer,
    });
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `问 ${i}` });
      messages.push({ role: 'assistant', content: `答 ${i}` });
    }

    const fitted = await model.fit(messages);

    expect(summarizer).toHaveBeenCalledTimes(1);
    // 摘要器是注入的假实现，不会走 inner，所以断言 fit() 的返回值本身
    const summaryMessage = fitted.find((m) => m.content.includes('已压缩'));
    expect(summaryMessage).toBeDefined();
    expect(summaryMessage?.content).toContain('早期做了 A、B 两件事');
    expect(model.lastStats?.summarized).toBe(true);
  });

  it('摘要失败时降级为直接丢弃，不拖垮整轮任务', async () => {
    const { model } = build({
      maxTokens: 60,
      maxToolResultTokens: 20,
      keepRecentGroups: 1,
      summarizer: async () => {
        throw new Error('摘要模型挂了');
      },
    });
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `问 ${i}` });
      messages.push({ role: 'assistant', content: `答 ${i}` });
    }

    const fitted = await model.fit(messages);

    expect(model.lastStats?.summarizerFailed).toBe(true);
    expect(estimateMessagesTokens(fitted)).toBeLessThanOrEqual(60);
  });

  it('收缩后的历史结构合法：tool 结果不与其调用分离', async () => {
    const { model } = build({ maxTokens: 80, maxToolResultTokens: 20, summarize: false });
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'user', content: `问 ${i}` });
      messages.push(assistantWithCalls(`c${i}`));
      messages.push(toolResult(`c${i}`, 'y'.repeat(500)));
    }

    const fitted = await model.fit(messages);

    expect(pairingViolations(fitted)).toEqual([]);
  });
});

describe('端到端：必然超限的长任务能收尾', () => {
  const bigDoc = '长文档内容'.repeat(2000);

  function buildLoop(withBudget: boolean) {
    const tools = new ToolRegistry().register({
      name: 'fetch',
      description: '取文档',
      schema: z.object({ id: z.string() }),
      handler: async () => bigDoc,
    });

    const inner = new FakeChatModel([
      toolTurn('fetch', { id: '1' }, 'c1'),
      toolTurn('fetch', { id: '2' }, 'c2'),
      toolTurn('fetch', { id: '3' }, 'c3'),
      toolTurn('fetch', { id: '4' }, 'c4'),
      answerTurn('四份文档都读完了'),
    ]);

    const model = withBudget
      ? withContextBudget(inner, { maxTokens: 300, maxToolResultTokens: 40, summarize: false })
      : inner;

    return { loop: new AgentLoop({ model, tools, options: { maxSteps: 8 } }), inner };
  }

  it('加固后每轮请求都在预算内，且任务正常收尾', async () => {
    const { loop, inner } = buildLoop(true);

    const result = await loop.run('读完这几份文档并总结');

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('四份文档都读完了');
    expect(result.toolCalls).toHaveLength(4);
    // 每一轮真正发给模型的请求都必须落在预算内
    for (const call of inner.calls) {
      expect(estimateMessagesTokens(call.messages)).toBeLessThanOrEqual(300);
    }
  });

  it('未加固时同样场景会超出预算——证明这道防护确实起了作用', async () => {
    const { loop, inner } = buildLoop(false);

    const result = await loop.run('读完这几份文档并总结');
    const peak = Math.max(...inner.calls.map((call) => estimateMessagesTokens(call.messages)));

    expect(result.content).toBe('四份文档都读完了');
    expect(peak).toBeGreaterThan(300);
  });
});
