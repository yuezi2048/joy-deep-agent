import { NonRetryableError } from '../core/errors.js';
import type { ToolHandler, ToolMiddleware } from '../core/types.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  now?: () => number;
}

/**
 * 熔断器：连续失败到阈值后直接短路，避免一边失败一边烧预算。
 * 到达冷却时间后放一个请求进去探路（half-open），成功则闭合，失败则重新打开。
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  canRequest(): boolean {
    if (this.state === 'closed' || this.state === 'half-open') return true;
    // open：到点了就放一个请求进去探路
    if (this.isAvailable()) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }

  /**
   * 只读探测：现在发请求会不会被短路。
   * 与 `canRequest()` 的区别是**不改变状态**——查询熔断状态不该顺手放一个探路请求进去。
   */
  isAvailable(): boolean {
    if (this.state === 'open') return this.now() - this.lastFailureAt >= this.resetTimeoutMs;
    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = this.now();
    if (this.state === 'half-open' || this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  snapshot(): { state: CircuitState; failureCount: number } {
    return { state: this.state, failureCount: this.failureCount };
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureAt = 0;
  }
}

/** 供应商/工具级熔断中间件。熔断打开时抛 NonRetryableError，让外层重试立即放弃。 */
export function circuitBreakerMiddleware(
  breaker: CircuitBreaker,
  label = '调用',
): ToolMiddleware {
  return (next: ToolHandler): ToolHandler =>
    async (call) => {
      if (!breaker.canRequest()) {
        throw new NonRetryableError(
          `${label}熔断中（连续失败 ${breaker.snapshot().failureCount} 次），暂时不再尝试`,
        );
      }
      try {
        const result = await next(call);
        breaker.recordSuccess();
        return result;
      } catch (error) {
        breaker.recordFailure();
        throw error;
      }
    };
}
