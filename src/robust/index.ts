import type { ToolRegistry } from '../tools/registry.js';
import { budgetMiddleware, type BudgetOptions } from './budget.js';
import { CircuitBreaker, circuitBreakerMiddleware, type CircuitBreakerOptions } from './circuit-breaker.js';
import { dedupeMiddleware, type DedupeOptions } from './dedupe.js';
import { withRetryMiddleware, type RetryOptions } from './retry.js';
import { withTimeoutMiddleware } from './timeout.js';

export * from './budget.js';
export * from './circuit-breaker.js';
export * from './dedupe.js';
export * from './retry.js';
export * from './timeout.js';

export interface DefaultMiddlewareOptions {
  dedupe?: DedupeOptions | false;
  budget?: BudgetOptions | false;
  retry?: RetryOptions | false;
  timeoutMs?: number | false;
  breaker?: { instance: CircuitBreaker; label?: string } | false;
}

/**
 * 默认中间件顺序（外层 → 内层）：
 *
 *   dedupe → budget → retry → timeout → 工具本体
 *
 * 为什么是这个顺序：
 * - dedupe 最外层：重复调用直接命中缓存，连预算都不消耗。
 * - budget 在 retry 外层：预算是「逻辑调用」的额度，重试不该重复计数。
 * - retry 在 timeout 外层：重试的是单次尝试，超时属于可重试错误。
 * - 熔断放在 retry 外层时，打开后由 NonRetryableError 让重试立刻放弃。
 */
export function applyDefaultToolMiddleware(
  registry: ToolRegistry,
  options: DefaultMiddlewareOptions = {},
): ToolRegistry {
  const {
    dedupe = {},
    budget = {},
    retry = {},
    timeoutMs = 30_000,
    breaker = false,
  } = options;

  if (dedupe !== false) registry.use(dedupeMiddleware(dedupe));
  if (budget !== false) registry.use(budgetMiddleware(budget));
  if (breaker !== false) registry.use(circuitBreakerMiddleware(breaker.instance, breaker.label));
  if (retry !== false) registry.use(withRetryMiddleware(retry));
  if (timeoutMs !== false) registry.use(withTimeoutMiddleware(timeoutMs));

  return registry;
}

/** 默认中间件顺序（外层 → 内层），供文档与测试引用。 */
export const DEFAULT_MIDDLEWARE_ORDER = ['dedupe', 'budget', 'breaker', 'retry', 'timeout'] as const;
