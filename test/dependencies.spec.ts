import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { ToolDefinition } from '../src/core/types.js';
import { InMemoryCheckpointStore } from '../src/memory/checkpoint-store.js';
import {
  PreflightError,
  assertPreflight,
  compareVersions,
  formatPreflightReport,
  runPreflight,
} from '../src/security/preflight.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

const lookup: ToolDefinition = {
  name: 'lookup_order',
  description: '查订单',
  schema: z.object({ id: z.string() }),
  handler: async ({ id }: { id: string }) => `订单 ${id}：待发货`,
};

const update: ToolDefinition = {
  name: 'update_order',
  description: '改订单',
  schema: z.object({ id: z.string(), status: z.string() }),
  handler: async ({ id, status }: { id: string; status: string }) => `订单 ${id} → ${status}`,
  requires: ['lookup_order'],
};

const call = (name: string, args: Record<string, unknown>) => ({
  id: `c-${name}`,
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

describe('工具依赖顺序', () => {
  it('前置未满足时拒绝并给出可读反馈，工具本体不被触达', async () => {
    const handler = vi.fn(async () => '不该被调用');
    const tools = new ToolRegistry().register(lookup).register({ ...update, handler });

    const result = await tools.execute(call('update_order', { id: '42', status: '已发货' }));

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toContain('lookup_order');
    expect(result.content).toContain('先');
  });

  it('前置成功执行后才放行', async () => {
    const tools = new ToolRegistry().registerAll([lookup, update]);

    await tools.execute(call('lookup_order', { id: '42' }));
    const result = await tools.execute(call('update_order', { id: '42', status: '已发货' }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('订单 42 → 已发货');
  });

  it('前置失败不算满足：报错的前置不给后续动作放行', async () => {
    const tools = new ToolRegistry()
      .register({ ...lookup, handler: async () => { throw new Error('数据库断了'); } })
      .register(update);

    const failed = await tools.execute(call('lookup_order', { id: '42' }));
    expect(failed.isError).toBe(true);

    const blocked = await tools.execute(call('update_order', { id: '42', status: '已发货' }));
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('lookup_order');
  });

  it('参数不合法的前置同样不算满足', async () => {
    const tools = new ToolRegistry().registerAll([lookup, update]);

    const invalid = await tools.execute(call('lookup_order', { id: 42 }));
    expect(invalid.isError).toBe(true);

    const blocked = await tools.execute(call('update_order', { id: '42', status: 'x' }));
    expect(blocked.content).toContain('lookup_order');
  });

  it('每一轮任务重新要求前置（resetState 会清空记录）', async () => {
    const tools = new ToolRegistry().registerAll([lookup, update]);
    await tools.execute(call('lookup_order', { id: '42' }));

    tools.resetState();
    const blocked = await tools.execute(call('update_order', { id: '42', status: 'x' }));

    expect(blocked.isError).toBe(true);
  });

  it('markCompleted 可以直接回填（续跑时用）', async () => {
    const tools = new ToolRegistry().registerAll([lookup, update]);
    tools.markCompleted('lookup_order');

    expect(tools.completedNames()).toEqual(['lookup_order']);
    const result = await tools.execute(call('update_order', { id: '42', status: '已发货' }));
    expect(result.isError).toBeUndefined();
  });
});

describe('依赖图校验', () => {
  it('成环在注册阶段就报错，而不是等到运行时死锁', () => {
    const a: ToolDefinition = { ...lookup, name: 'a', requires: ['b'] };
    const b: ToolDefinition = { ...lookup, name: 'b', requires: ['a'] };
    const tools = new ToolRegistry().register(a);

    expect(() => tools.register(b)).toThrow(/成环/);
    // 注册失败不留半个工具在表里
    expect(tools.names()).toEqual(['a']);
  });

  it('自依赖也算成环', () => {
    expect(() =>
      new ToolRegistry().register({ ...lookup, name: 'self', requires: ['self'] }),
    ).toThrow(/成环/);
  });

  it('依赖了未注册的工具在 registerAll 结束时一次性说清楚', () => {
    const orphan: ToolDefinition = { ...lookup, name: 'update', requires: ['nope'] };

    expect(() => new ToolRegistry().registerAll([orphan])).toThrow(/未注册/);
  });

  it('无依赖的普通工具不受影响', () => {
    expect(() => new ToolRegistry().registerAll([lookup, update])).not.toThrow();
  });
});

describe('AgentLoop 里的依赖顺序', () => {
  it('模型跳过前置时被打回，收到反馈后补上再完成', async () => {
    const tools = new ToolRegistry().registerAll([lookup, update]);
    const model = new FakeChatModel([
      toolTurn('update_order', { id: '42', status: '已发货' }),
      toolTurn('lookup_order', { id: '42' }),
      toolTurn('update_order', { id: '42', status: '已发货' }),
      answerTurn('已按订单现状改成已发货'),
    ]);

    const result = await new AgentLoop({ model, tools }).run('把订单 42 改成已发货');

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('已按订单现状改成已发货');
    const rejected = model.calls[1]?.messages.find((message) => message.role === 'tool');
    expect(rejected?.content).toContain('必须先成功调用');
    const applied = result.messages.filter((message) => message.role === 'tool').at(-1);
    expect(applied?.content).toBe('订单 42 → 已发货');
  });

  it('续跑时把检查点里已成功执行过的工具回填，前置不会被误判', async () => {
    const store = new InMemoryCheckpointStore();
    const controller = new AbortController();
    const tools = new ToolRegistry()
      .register({
        ...lookup,
        handler: async ({ id }: { id: string }) => {
          controller.abort(); // 查完就中断，模拟任务半途被打断
          return `订单 ${id}：待发货`;
        },
      })
      .register(update);

    const first = new AgentLoop({
      model: new FakeChatModel([
        toolTurn('lookup_order', { id: '42' }),
        toolTurn('update_order', { id: '42', status: '已发货' }),
      ]),
      tools,
      options: { checkpoint: { store, id: 'dep-1' }, signal: controller.signal },
    });
    const interrupted = await first.run('改订单');
    expect(interrupted.stopReason).toBe('cancelled');

    const saved = await store.load<{ completedTools?: string[] }>('dep-1');
    expect(saved?.state.completedTools).toContain('lookup_order');

    const resumed = new AgentLoop({
      model: new FakeChatModel([
        toolTurn('update_order', { id: '42', status: '已发货' }),
        answerTurn('改好了'),
      ]),
      tools,
      options: { checkpoint: { store, id: 'dep-1' } },
    });
    const result = await resumed.resume();

    expect(result.stopReason).toBe('completed');
    expect(result.messages.filter((message) => message.role === 'tool').at(-1)?.content).toBe(
      '订单 42 → 已发货',
    );
  });
});

describe('启动预检', () => {
  const preflight = (overrides: Partial<Parameters<typeof runPreflight>[0]> = {}) =>
    runPreflight({
      workspaceRoot: process.cwd(),
      allowedCommands: ['node', 'git'],
      nodeVersion: '20.11.0',
      ...overrides,
    });

  it('三项都过时报告 ok', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-agent-preflight-'));
    const report = await preflight({ workspaceRoot: dir });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(['runtime', 'commands', 'workspace']);
    expect(formatPreflightReport(report)).toContain('启动预检通过');
  });

  it('运行时版本过低时失败，并给出升级提示', async () => {
    const report = await preflight({ nodeVersion: '18.19.0' });

    expect(report.ok).toBe(false);
    const runtime = report.checks.find((check) => check.name === 'runtime');
    expect(runtime?.ok).toBe(false);
    expect(runtime?.hint).toContain('升级 Node');
    expect(formatPreflightReport(report)).toContain('Node 18.19.0');
  });

  it('命令白名单为空时失败', async () => {
    const report = await preflight({ allowedCommands: ['  ', ''] });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'commands')?.hint).toContain('allowedCommands');
  });

  it('工作区不可写时失败，并指出目录与排查方向', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-agent-preflight-'));
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'this path is a file, not a directory', 'utf8');

    const report = await preflight({ workspaceRoot: blocked });

    expect(report.ok).toBe(false);
    const workspace = report.checks.find((check) => check.name === 'workspace');
    expect(workspace?.ok).toBe(false);
    expect(workspace?.detail).toContain(blocked);
    expect(workspace?.hint).toContain('只读');
  });

  it('assertPreflight 失败时抛出，报错信息里带着修复提示', async () => {
    const report = await preflight({ nodeVersion: '18.19.0' });

    expect(() => assertPreflight(report)).toThrow(PreflightError);
    expect(() => assertPreflight(report)).toThrow(/升级 Node/);
    expect(() => assertPreflight({ ok: true, checks: [] })).not.toThrow();
  });

  it('版本比较按段数值比，不做字符串比较', () => {
    expect(compareVersions('20.0.0', '20.0.0')).toBe(0);
    expect(compareVersions('20.11.0', '20.2.0')).toBeGreaterThan(0);
    expect(compareVersions('18.19.0', '20.0.0')).toBeLessThan(0);
    expect(compareVersions('22.0.0-nightly20240101', '20.0.0')).toBeGreaterThan(0);
  });
});
