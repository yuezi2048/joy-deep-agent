import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError, RetryableError, TimeoutError, isRetryable } from '../src/core/errors.js';
import type { ToolCall, ToolHandler, ToolMiddleware, ToolResult } from '../src/core/types.js';
import {
  CircuitBreaker,
  budgetMiddleware,
  canonicalize,
  circuitBreakerMiddleware,
  dedupeMiddleware,
  withRetry,
  withTimeout,
} from '../src/robust/index.js';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 'c1',
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

/** 把中间件链装起来，返回执行结果与底层 handler 的调用次数。 */
async function runChain(
  middleware: ToolMiddleware[],
  toolCall: ToolCall,
  base?: ToolHandler,
): Promise<{ result: ToolResult; calls: number }> {
  let calls = 0;
  const handler: ToolHandler =
    base ?? (async () => { calls++; return { content: 'ok' }; });
  const chain = middleware.reduceRight<ToolHandler>((next, mw) => mw(next), handler);
  const result = await chain(toolCall);
  return { result, calls };
}

describe('错误分类', () => {
  it('429 与 5xx 可重试，4xx 不可重试', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
  });

  it('网络类错误码可重试', () => {
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryable({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('未知错误不重试，避免放大成本', () => {
    expect(isRetryable(new Error('说不清的问题'))).toBe(false);
  });
});

describe('withRetry（失败调用）', () => {
  it('前两次失败、第三次成功', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new RetryableError('限流');
        return 'ok';
      },
      { maxRetries: 3, initialDelayMs: 1 },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('不可重试错误立即抛出，不做无谓重试', async () => {
    const fn = vi.fn(async () => {
      throw new NonRetryableError('参数错误', 400);
    });

    await expect(withRetry(fn, { maxRetries: 5, initialDelayMs: 1 })).rejects.toThrow('参数错误');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('重试耗尽后抛出最后一次错误', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new RetryableError('一直失败');
        },
        { maxRetries: 2, initialDelayMs: 1 },
      ),
    ).rejects.toThrow('一直失败');
    expect(attempts).toBe(3);
  });
});

describe('withTimeout（失败调用）', () => {
  it('按时返回时不打断', async () => {
    await expect(withTimeout(Promise.resolve('done'), 50, '测试')).resolves.toBe('done');
  });

  it('超时抛 TimeoutError，且归类为可重试', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    await expect(withTimeout(slow, 5, '测试')).rejects.toBeInstanceOf(TimeoutError);
    expect(isRetryable(new TimeoutError())).toBe(true);
  });
});

describe('CircuitBreaker（供应商故障）', () => {
  it('连续失败到阈值后打开，冷却后进入半开', () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500, now: () => now });

    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.canRequest()).toBe(false);

    now += 600;
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
  });

  it('半开状态下成功即闭合', () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => now });
    breaker.recordFailure();
    now += 200;
    breaker.canRequest();

    breaker.recordSuccess();

    expect(breaker.getState()).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
  });

  it('熔断打开时中间件短路，不再调用底层 handler', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const base: ToolHandler = async () => { throw new RetryableError('上游挂了'); };

    // 第一次失败把熔断打开
    await expect(runChain([circuitBreakerMiddleware(breaker)], call('t'), base)).rejects.toThrow();

    expect(breaker.getState()).toBe('open');
    // 打开后抛不可重试错误，让外层重试立刻放弃
    await expect(
      runChain([circuitBreakerMiddleware(breaker)], call('t'), base),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe('dedupeMiddleware（工具误用 · 去重）', () => {
  it('参数相同的重复调用复用结果，不再触达 handler', async () => {
    const middleware = dedupeMiddleware();
    const { calls } = await runChain([middleware], call('search', { q: 'a' }));

    expect(calls).toBe(1);

    let secondCalls = 0;
    const base: ToolHandler = async () => { secondCalls++; return { content: 'ok' }; };
    const outcome = await runChain([middleware], call('search', { q: 'a' }), base);

    expect(secondCalls).toBe(0);
    expect(outcome.result.content).toContain('复用');
  });

  it('参数不同则正常执行', async () => {
    const middleware = dedupeMiddleware();
    await runChain([middleware], call('search', { q: 'a' }));
    const { calls } = await runChain([middleware], call('search', { q: 'b' }));

    expect(calls).toBe(1);
  });

  it('失败结果不进缓存，允许重试', async () => {
    const middleware = dedupeMiddleware();
    let attempt = 0;
    const base: ToolHandler = async () => {
      attempt++;
      return attempt === 1 ? { content: '临时故障', isError: true } : { content: '成功' };
    };

    await runChain([middleware], call('t'), base);
    const { result } = await runChain([middleware], call('t'), base);

    expect(result.content).toBe('成功');
  });

  it('canonicalize 与键顺序无关', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('reset 清空缓存', async () => {
    const middleware = dedupeMiddleware();
    await runChain([middleware], call('t', { a: 1 }));
    middleware.reset();

    const { calls } = await runChain([middleware], call('t', { a: 1 }));
    expect(calls).toBe(1);
  });
});

describe('budgetMiddleware（工具误用 · 预算）', () => {
  it('单工具超限时返回可读反馈而非抛异常', async () => {
    const middleware = budgetMiddleware({ maxPerTool: 2 });
    await runChain([middleware], call('search'));
    await runChain([middleware], call('search'));

    const { result } = await runChain([middleware], call('search'));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('上限');
  });

  it('总调用数超限时一并拦截', async () => {
    const middleware = budgetMiddleware({ maxTotalCalls: 2, maxPerTool: 99 });
    await runChain([middleware], call('a'));
    await runChain([middleware], call('b'));

    const { result } = await runChain([middleware], call('c'));
    expect(result.isError).toBe(true);
  });

  it('usage 反映已消耗额度，reset 后归零', async () => {
    const middleware = budgetMiddleware({ maxTotalCalls: 5 });
    await runChain([middleware], call('a'));
    await runChain([middleware], call('a'));

    expect(middleware.usage()).toEqual({ total: 2, perTool: { a: 2 } });

    middleware.reset();
    expect(middleware.usage()).toEqual({ total: 0, perTool: {} });
  });
});

describe('默认中间件顺序', () => {
  it('dedupe 在最外层：命中的重复调用不消耗预算', async () => {
    const { DEFAULT_MIDDLEWARE_ORDER } = await import('../src/robust/index.js');
    expect(DEFAULT_MIDDLEWARE_ORDER).toEqual(['dedupe', 'budget', 'breaker', 'retry', 'timeout']);

    const budget = budgetMiddleware({ maxPerTool: 1 });
    const dedupe = dedupeMiddleware();
    await runChain([dedupe, budget], call('search', { q: 'a' }));
    const { result } = await runChain([dedupe, budget], call('search', { q: 'a' }));

    // 若顺序反了，第二次会被预算拦成 isError
    expect(result.isError).toBeUndefined();
  });
});
