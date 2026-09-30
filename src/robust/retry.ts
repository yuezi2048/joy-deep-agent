import { isRetryable } from '../core/errors.js';
import type { ToolHandler, ToolMiddleware } from '../core/types.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数退避重试。只重试可重试错误，其余立刻抛出，避免把确定性失败放大成 N 倍成本。 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 500,
    backoffFactor = 2,
    maxDelayMs = 15_000,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) throw error;
      if (attempt === maxRetries) break;
      const delay = Math.min(initialDelayMs * backoffFactor ** attempt, maxDelayMs);
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

export function withRetryMiddleware(options: RetryOptions = {}): ToolMiddleware {
  return (next: ToolHandler): ToolHandler =>
    (call) => withRetry(() => next(call), options);
}
