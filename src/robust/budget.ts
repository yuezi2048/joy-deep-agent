import type { ToolCall, ToolHandler, ToolMiddleware, ToolResult } from '../core/types.js';
import type { ResettableMiddleware } from './dedupe.js';

export interface BudgetOptions {
  maxTotalCalls?: number;
  maxPerTool?: number;
}

export interface BudgetUsage {
  total: number;
  perTool: Record<string, number>;
}

export type BudgetMiddleware = ResettableMiddleware & { usage: () => BudgetUsage };

/**
 * 工具调用预算：超限时返回可读反馈而不是抛异常，让模型有机会换策略收尾。
 * 位置在重试外层——重试属于同一次逻辑调用，不该重复计数。
 */
export function budgetMiddleware(options: BudgetOptions = {}): BudgetMiddleware {
  const maxTotalCalls = options.maxTotalCalls ?? 20;
  const maxPerTool = options.maxPerTool ?? 8;
  let total = 0;
  const perTool = new Map<string, number>();

  const middleware = ((next: ToolHandler): ToolHandler => {
    return async (call: ToolCall): Promise<ToolResult> => {
      if (total >= maxTotalCalls) {
        return {
          content: `已达到本次任务的工具调用上限（${maxTotalCalls} 次），无法再调用工具。请基于现有信息给出结论。`,
          isError: true,
        };
      }
      const used = perTool.get(call.name) ?? 0;
      if (used >= maxPerTool) {
        return {
          content: `工具 "${call.name}" 已达到调用上限（${maxPerTool} 次），无法再调用。请换一种做法或基于现有信息作答。`,
          isError: true,
        };
      }

      total++;
      perTool.set(call.name, used + 1);
      return next(call);
    };
  }) as BudgetMiddleware;

  middleware.reset = () => {
    total = 0;
    perTool.clear();
  };
  middleware.usage = () => ({ total, perTool: Object.fromEntries(perTool) });
  return middleware;
}
