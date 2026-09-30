import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler, ToolMiddleware } from '../src/core/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'add',
    description: '两数相加',
    schema: z.object({ a: z.number(), b: z.number() }),
    handler: async ({ a, b }: { a: number; b: number }) => String(a + b),
    ...overrides,
  };
}

const call = (name: string, args: Record<string, unknown>) => ({
  id: 'c1',
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

describe('ToolRegistry', () => {
  it('注册后可被发现，并给出 JSON Schema', () => {
    const registry = new ToolRegistry().register(makeTool());

    expect(registry.names()).toEqual(['add']);
    expect(registry.has('add')).toBe(true);

    const [schema] = registry.schemas();
    expect(schema?.name).toBe('add');
    expect(schema?.parameters).toMatchObject({ type: 'object' });
    expect(JSON.stringify(schema?.parameters)).toContain('"a"');
  });

  it('重名注册直接报错，避免静默覆盖', () => {
    const registry = new ToolRegistry().register(makeTool());
    expect(() => registry.register(makeTool())).toThrow(/已注册/);
  });

  it('未知工具返回可读反馈，而不是抛异常', async () => {
    const registry = new ToolRegistry().register(makeTool());
    const result = await registry.execute(call('delete_everything', {}));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('delete_everything');
    expect(result.content).toContain('add');
  });

  it('参数不合 schema 时拦截，且不触达 handler', async () => {
    const handler = vi.fn(async () => 'ok');
    const registry = new ToolRegistry().register(makeTool({ handler }));

    const result = await registry.execute(call('add', { a: '2', b: 3 }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数');
    expect(handler).not.toHaveBeenCalled();
  });

  it('校验通过时把解析后的参数交给 handler', async () => {
    const handler = vi.fn(async ({ a, b }: { a: number; b: number }) => String(a + b));
    const registry = new ToolRegistry().register(makeTool({ handler }));

    const result = await registry.execute(call('add', { a: 2, b: 3 }));

    expect(result).toEqual({ content: '5' });
    expect(handler).toHaveBeenCalledWith({ a: 2, b: 3 }, expect.objectContaining({ callId: 'c1' }));
  });

  it('中间件按 use() 顺序从外到内包裹', async () => {
    const order: string[] = [];
    const registry = new ToolRegistry().register(makeTool());
    registry.use((next) => async (c) => {
      order.push('outer:before');
      const result = await next(c);
      order.push('outer:after');
      return result;
    });
    registry.use((next) => async (c) => {
      order.push('inner:before');
      const result = await next(c);
      order.push('inner:after');
      return result;
    });

    await registry.execute(call('add', { a: 1, b: 1 }));

    expect(order).toEqual(['outer:before', 'inner:before', 'inner:after', 'outer:after']);
  });

  it('handler 抛异常时转成 isError 结果，不炸穿循环', async () => {
    const registry = new ToolRegistry().register(
      makeTool({
        handler: async () => {
          throw new Error('磁盘满了');
        },
      }),
    );

    const result = await registry.execute(call('add', { a: 1, b: 1 }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('磁盘满了');
  });

  it('resetState 会重置有状态中间件', () => {
    const resets: number[] = [];
    const registry = new ToolRegistry().register(makeTool());
    const stateful = ((next: ToolHandler) => next) as ToolMiddleware & { reset: () => void };
    stateful.reset = () => resets.push(1);
    registry.use(stateful);

    registry.resetState();

    expect(resets).toHaveLength(1);
  });
});
