import { TimeoutError } from '../core/errors.js';
import type { ToolHandler, ToolMiddleware } from '../core/types.js';

/** 给任意 promise 套一层超时。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = '操作'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label}超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** 单次工具调用的超时中间件。注意要放在重试内层：重试的是单次尝试，不是整个退避序列。 */
export function withTimeoutMiddleware(ms: number, label?: string): ToolMiddleware {
  return (next: ToolHandler): ToolHandler =>
    (call) => withTimeout(next(call), ms, label ?? `工具 ${call.name}`);
}
