import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatModel, ChatRequest, ChatResponse, StreamChunk } from '../src/providers/chat-model.js';
import { InMemoryMemoryStore } from '../src/memory/index.js';
import { orchestrate } from '../src/orchestrate.js';
import type { AgentRuntime } from '../src/runtime.js';
import { ToolRegistry } from '../src/tools/registry.js';

/** 按系统提示分辨「这次是谁在问」，不必真的跑工具。 */
class EntryModel implements ChatModel {
  readonly name = 'fake-orchestrator';
  readonly model = 'fake-orchestrator-1';
  readonly supportsTools = true;

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
    const usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7 };

    if (system.includes('你是任务规划器')) {
      return {
        content: JSON.stringify({
          goal: '产出调研报告',
          steps: [
            { id: 's1', role: 'retrieval', task: '找出原始材料' },
            { id: 's2', role: 'writing', task: '组织成章节', dependsOn: ['s1'] },
          ],
        }),
        toolCalls: [],
        finishReason: 'stop',
        usage,
      };
    }
    if (system.includes('你是汇总器')) {
      return { content: '# 调研报告\n\n汇总后的正文。', toolCalls: [], finishReason: 'stop', usage };
    }
    return {
      content: `子智能体产出：${request.messages.at(-1)?.content ?? ''}`,
      toolCalls: [],
      finishReason: 'stop',
      usage,
    };
  }

  chatStream(): AsyncIterable<StreamChunk> {
    throw new Error('编排层不走流式');
  }
}

function fakeRuntime(model: ChatModel): AgentRuntime {
  return { model, tools: new ToolRegistry(), forkTools: () => new ToolRegistry() };
}

describe('orchestrate（编排入口）', () => {
  it('一个供应商都没配时给可读提示并返回 null，不抛异常', async () => {
    const lines: string[] = [];

    const result = await orchestrate({ goal: '做点什么', providers: [], out: (line) => lines.push(line) });

    expect(result).toBeNull();
    expect(lines.join('\n')).toContain('API Key');
    expect(lines.join('\n')).toContain('.env.example');
  });

  it('跑完整条链：计划打印、报告落盘、长期记忆写回、token 账可查', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'joy-orchestrate-'));
    const memory = new InMemoryMemoryStore();
    const lines: string[] = [];

    const result = await orchestrate({
      goal: '调研 X 并产出报告',
      workspaceRoot,
      reportDir: '.joy-agent/reports',
      memory,
      runtime: fakeRuntime(new EntryModel()),
      out: (line) => lines.push(line),
    });

    expect(result).not.toBeNull();
    expect(result!.planSource).toBe('planned');
    expect(result!.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded']);
    // 规划 + 两个子智能体 + 汇总，各 7 token；账要逐项可查，不能只给一个总数
    expect(result!.planUsage.totalTokens).toBe(7);
    expect(result!.subAgentUsage.totalTokens).toBe(14);
    expect(result!.synthesisUsage.totalTokens).toBe(7);
    expect(result!.usage.totalTokens).toBe(28);

    const output = lines.join('\n');
    expect(output).toContain('📋 计划（模型规划，2 步）');
    expect(output).toContain('s2 · writing');
    expect(output).toContain('⚙️  第 2 波并发：s2');
    expect(output).toContain('📄 报告：');
    expect(output).toContain('💰 token：规划 7 · 子智能体 14 · 汇总 7（总 28）');

    expect(result!.files).toHaveLength(2);
    const markdown = await readFile(result!.files[0]!, 'utf8');
    expect(markdown).toContain('# 产出调研报告');
    expect(markdown).toContain('汇总后的正文。');

    const facts = await memory.recall('default');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain('产出调研报告');
  });

  it('缺省内存后端下如实提示长期记忆不会跨进程累积', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'joy-orchestrate-'));
    const lines: string[] = [];

    await orchestrate({
      goal: '跑一次',
      workspaceRoot,
      reportDir: '.joy-agent/reports',
      runtime: fakeRuntime(new EntryModel()),
      out: (line) => lines.push(line),
    });

    expect(lines.join('\n')).toContain('AGENT_MEMORY=file');
  });

  it('报告目录越出工作区时被 PathGuard 拒掉', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'joy-orchestrate-'));

    await expect(
      orchestrate({
        goal: '越界试试',
        workspaceRoot,
        reportDir: '../../etc',
        memory: new InMemoryMemoryStore(),
        runtime: fakeRuntime(new EntryModel()),
        out: () => {},
      }),
    ).rejects.toThrow();
  });
});
