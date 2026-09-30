import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentLoop, type AgentCheckpointState, type AgentEvent } from '../src/core/agent-loop.js';
import type { ToolDefinition } from '../src/core/types.js';
import { InMemoryCheckpointStore, JsonFileCheckpointStore } from '../src/memory/checkpoint-store.js';
import { dedupeMiddleware } from '../src/robust/dedupe.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn, multiToolTurn, toolTurn } from './helpers/fake-model.js';

/** 一个「有副作用」的工具：执行一次就往 effects 里记一笔。 */
function effectTool(name: string, effects: string[], onRun?: () => void): ToolDefinition {
  return {
    name,
    description: `写 ${name}`,
    schema: z.object({ value: z.string() }),
    handler: async ({ value }: { value: string }) => {
      effects.push(`${name}:${value}`);
      onRun?.();
      return `${name} 完成`;
    },
  };
}

function noteTool(handler: (args: { value: string }) => Promise<string>): ToolDefinition {
  return {
    name: 'write_note',
    description: '记一笔',
    schema: z.object({ value: z.string() }),
    handler,
  };
}

const state = async (store: InMemoryCheckpointStore, id: string) =>
  (await store.load<AgentCheckpointState>(id))?.state;

describe('Checkpoint / Resume（用户中断）', () => {
  it('取消时落盘：检查点足以还原「做过什么、拿到哪些结果」', async () => {
    const store = new InMemoryCheckpointStore();
    const controller = new AbortController();
    const handler = vi.fn(async ({ value }: { value: string }) => {
      controller.abort(); // 第一个观测回来后用户点了中断
      return `已写入 ${value}`;
    });
    const tools = new ToolRegistry().register(noteTool(handler));
    const model = new FakeChatModel([toolTurn('write_note', { value: 'a' }), answerTurn('不该走到这里')]);

    const loop = new AgentLoop({
      model,
      tools,
      options: { checkpoint: { store, id: 'task-1' }, signal: controller.signal },
    });
    const result = await loop.run('帮我记一笔');

    expect(result.stopReason).toBe('cancelled');
    expect(controller.signal.aborted).toBe(true);

    const saved = await state(store, 'task-1');
    expect(saved).toBeDefined();
    expect(saved?.input).toBe('帮我记一笔');
    expect(saved?.steps).toBe(1);
    expect(saved?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(saved?.messages.filter((message) => message.role === 'tool')).toEqual([
      expect.objectContaining({ name: 'write_note', content: '已写入 a' }),
    ]);
    // 中断后模型不再被调用第二次
    expect(model.remaining).toBe(1);
  });

  it('从检查点续跑：跑完剩余步骤，且已执行的工具调用不重跑', async () => {
    const store = new InMemoryCheckpointStore();
    const controller = new AbortController();
    const handler = vi.fn(async ({ value }: { value: string }) => {
      controller.abort();
      return `已写入 ${value}`;
    });
    const tools = new ToolRegistry().register(noteTool(handler));
    const first = new AgentLoop({
      model: new FakeChatModel([toolTurn('write_note', { value: 'a' }), answerTurn('不该走到这里')]),
      tools,
      options: { checkpoint: { store, id: 'task-1' }, signal: controller.signal },
    });
    await first.run('帮我记一笔');

    // 进程重启：新的循环、新的模型、新的（未中断的）信号，只有检查点是一样的
    const resumedModel = new FakeChatModel([answerTurn('记好了')]);
    const resumed = new AgentLoop({
      model: resumedModel,
      tools,
      options: { checkpoint: { store, id: 'task-1' } },
    });
    const result = await resumed.resume();

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('记好了');
    expect(handler).toHaveBeenCalledTimes(1); // 关键：副作用只发生一次
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    // 续跑的第一次请求带着上一次的工具结果，模型不用重新调一次工具
    const toolMessage = resumedModel.calls[0]?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toBe('已写入 a');
    expect(resumedModel.calls[0]?.messages.at(-1)?.role).toBe('tool');
    // 跑完就清点，避免下次误续跑一个已经完成的任务
    expect(await store.load('task-1')).toBeNull();
    expect(resumed.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('中断落在一组工具中间：续跑只补没跑完的那个', async () => {
    const store = new InMemoryCheckpointStore();
    const effects: string[] = [];
    const controller = new AbortController();
    const tools = new ToolRegistry();
    tools.use(dedupeMiddleware()); // 去重缓存跨进程就没了，这条保证只能来自检查点
    tools.register(effectTool('write_a', effects, () => controller.abort()));
    tools.register(effectTool('write_b', effects));

    const first = new AgentLoop({
      model: new FakeChatModel([
        multiToolTurn([
          { name: 'write_a', args: { value: '1' } },
          { name: 'write_b', args: { value: '2' } },
        ]),
      ]),
      tools,
      options: { checkpoint: { store, id: 'group-1' }, signal: controller.signal },
    });
    const interrupted = await first.run('写两条');
    expect(interrupted.stopReason).toBe('cancelled');
    expect(effects).toEqual(['write_a:1']);

    const saved = await state(store, 'group-1');
    expect(saved?.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(saved?.messages.find((message) => message.role === 'assistant')?.toolCalls).toHaveLength(2);

    const resumedModel = new FakeChatModel([answerTurn('都写好了')]);
    const resumed = new AgentLoop({
      model: resumedModel,
      tools,
      options: { checkpoint: { store, id: 'group-1' } },
    });
    const result = await resumed.resume();

    expect(result.stopReason).toBe('completed');
    expect(effects).toEqual(['write_a:1', 'write_b:2']); // write_a 没有被重跑

    // 补齐的调用与原 assistant 声明的 id 对得上，轨迹结构合法
    const request = resumedModel.calls[0];
    const declared = request?.messages.find(
      (message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
    );
    const answered = request?.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId);
    expect(answered).toEqual(declared?.toolCalls?.map((call) => call.id));
    expect(answered).toHaveLength(2);
  });

  it('没有检查点时 resume(input) 按冷启动处理', async () => {
    const store = new InMemoryCheckpointStore();
    const model = new FakeChatModel([answerTurn('你好')]);
    const loop = new AgentLoop({
      model,
      tools: new ToolRegistry(),
      options: { checkpoint: { store, id: 'cold-1' } },
    });

    const result = await loop.resume('第一次来');

    expect(result.stopReason).toBe('completed');
    expect(model.calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: '第一次来' });
  });

  it('没有检查点又没有 input 时报错，而不是静默什么都不做', async () => {
    const loop = new AgentLoop({
      model: new FakeChatModel([]),
      tools: new ToolRegistry(),
      options: { checkpoint: { store: new InMemoryCheckpointStore(), id: 'missing' } },
    });

    await expect(loop.resume()).rejects.toThrow(/没有 id 为 "missing" 的检查点/);
  });

  it('run() 冷启动会丢弃同一个 id 上的旧进度', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save('reuse', { input: '旧任务', messages: [], steps: 3, lastContent: '', fingerprints: [], usage: {}, executed: [] });

    const model = new FakeChatModel([answerTurn('新任务完成')]);
    const loop = new AgentLoop({
      model,
      tools: new ToolRegistry(),
      options: { checkpoint: { store, id: 'reuse' } },
    });
    const result = await loop.run('新任务');

    expect(result.steps).toBe(1);
    expect(model.calls[0]?.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(model.calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: '新任务' });
    expect(await store.load('reuse')).toBeNull();
  });

  it('未配置检查点存储时 resume() 直接报错，不假装能续跑', async () => {
    const loop = new AgentLoop({
      model: new FakeChatModel([]),
      tools: new ToolRegistry(),
    });

    await expect(loop.resume('x')).rejects.toThrow(/未配置检查点存储/);
  });

  it('流式续跑：事件照常吐出，done 与 resume() 结果一致', async () => {
    const store = new InMemoryCheckpointStore();
    const controller = new AbortController();
    const tools = new ToolRegistry().register(
      noteTool(async ({ value }) => {
        controller.abort();
        return `已写入 ${value}`;
      }),
    );
    await new AgentLoop({
      model: new FakeChatModel([toolTurn('write_note', { value: 'a' })]),
      tools,
      options: { checkpoint: { store, id: 'stream-1' }, signal: controller.signal },
    }).run('记一笔');

    const events: AgentEvent[] = [];
    const resumed = new AgentLoop({
      model: new FakeChatModel([answerTurn('完成')]),
      tools,
      options: { checkpoint: { store, id: 'stream-1' } },
    });
    for await (const event of resumed.resumeStream()) events.push(event);

    expect(events.map((event) => event.type)).toEqual(['step_start', 'text', 'done']);
    const done = events.at(-1);
    if (done?.type === 'done') {
      expect(done.result.stopReason).toBe('completed');
      expect(done.result.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    }
    expect(await store.load('stream-1')).toBeNull();
  });

  it('步数上限不是「完成」，检查点会保留下来供人工决定', async () => {
    const store = new InMemoryCheckpointStore();
    const tools = new ToolRegistry().register(effectTool('write_a', []));
    const model = new FakeChatModel([toolTurn('write_a', { value: '1' })]);

    const result = await new AgentLoop({
      model,
      tools,
      options: { maxSteps: 1, checkpoint: { store, id: 'capped' } },
    }).run('一直写');

    expect(result.stopReason).toBe('max_steps');
    expect(await store.load('capped')).not.toBeNull();
  });
});

describe('JsonFileCheckpointStore（落盘实现）', () => {
  it('原子写入：不留临时文件，读回来与写进去一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-agent-cp-'));
    const store = new JsonFileCheckpointStore(dir);

    await store.save('task/1', { hello: '世界' });

    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await store.list()).toEqual(['task_1']); // 非法字符会被替换，保证是合法文件名
    expect((await store.load<{ hello: string }>('task/1'))?.state).toEqual({ hello: '世界' });

    await store.delete('task/1');
    expect(await store.load('task/1')).toBeNull();
  });

  it('空目录不会报错：没有检查点就是 null / 空列表', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-agent-cp-'));
    const store = new JsonFileCheckpointStore(dir);

    expect(await store.load('nope')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('读到不认识的版本直接拒绝，而不是当成没有检查点', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-agent-cp-'));
    await writeFile(
      join(dir, 'old.json'),
      JSON.stringify({ id: 'old', version: 99, updatedAt: 0, state: {} }),
      'utf8',
    );

    await expect(new JsonFileCheckpointStore(dir).load('old')).rejects.toThrow(/版本/);
  });
});
