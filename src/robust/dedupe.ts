import { toolCallKey } from '../core/stable-key.js';
import type { ToolCall, ToolHandler, ToolMiddleware, ToolResult } from '../core/types.js';

export interface DedupeOptions {
  /** 只对无副作用的工具去重。写操作重复执行会改变世界，默认不去重。 */
  shouldDedupe?: (toolName: string) => boolean;
}

/** 带生命周期的中间件：AgentLoop 每轮任务开始前会调 reset()。 */
export type ResettableMiddleware = ToolMiddleware & { reset: () => void };

/**
 * 工具去重：同一轮任务里，参数完全相同的调用直接复用上次结果。
 * key 由 `toolCallKey` 生成（键顺序稳定），与 AgentLoop 判定「同一次调用」用的是同一套标识。
 * 命中时在结果前加一行说明，让模型知道这是缓存而不是新观测。
 * 失败结果不进缓存，否则一次偶发故障会被永久固化。
 */
export function dedupeMiddleware(options: DedupeOptions = {}): ResettableMiddleware {
  const cache = new Map<string, ToolResult>();
  const shouldDedupe = options.shouldDedupe ?? (() => true);

  const middleware = ((next: ToolHandler): ToolHandler => {
    return async (call: ToolCall): Promise<ToolResult> => {
      if (!shouldDedupe(call.name)) return next(call);

      const key = toolCallKey(call.name, call.arguments);
      const cached = cache.get(key);
      if (cached) {
        return { ...cached, content: `（与上次调用参数相同，直接复用结果）\n${cached.content}` };
      }

      const result = await next(call);
      if (!result.isError) cache.set(key, result);
      return result;
    };
  }) as ResettableMiddleware;

  middleware.reset = () => cache.clear();
  return middleware;
}
