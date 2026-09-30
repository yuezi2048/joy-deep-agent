import type { ChatMessage } from '../core/types.js';
import { estimateMessagesTokens } from './token-counter.js';

export interface GroupedMessages {
  system: ChatMessage[];
  groups: ChatMessage[][];
}

/**
 * 把消息切成「组」。分组是这一层的正确性关键：
 * assistant 发起 tool_calls 之后，必须有对应的 tool 结果紧随其后；
 * 两者一旦被窗口拆开，请求结构就非法，供应商会直接拒绝整轮请求。
 *
 * 规则：
 * - system 单独拎出，永远保留在最前
 * - user 消息自成一组
 * - assistant 消息另起一组，紧随其后的 tool 结果并入该组
 */
export function groupMessages(messages: readonly ChatMessage[]): GroupedMessages {
  const system: ChatMessage[] = [];
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] | null = null;

  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message);
      continue;
    }
    if (message.role === 'user') {
      current = [message];
      groups.push(current);
      continue;
    }
    if (message.role === 'assistant') {
      current = [message];
      groups.push(current);
      continue;
    }
    // tool 结果：并入当前组；若前面没有组（异常轨迹），单独成组避免丢失
    if (current) {
      current.push(message);
    } else {
      current = [message];
      groups.push(current);
    }
  }

  return { system, groups };
}

export interface WindowOptions {
  /** 历史预算（含 system），超出即从最旧开始丢弃 */
  maxTokens?: number;
  /** 无论如何都要保留的最近组数，保证模型仍有近期上下文 */
  keepRecentGroups?: number;
}

export interface WindowPlan {
  system: ChatMessage[];
  kept: ChatMessage[][];
  dropped: ChatMessage[][];
  tokens: number;
}

/** 只做规划，不改动消息：让调用方决定被丢弃的中段是丢掉还是压缩。 */
export function planSlidingWindow(
  messages: readonly ChatMessage[],
  options: WindowOptions = {},
): WindowPlan {
  const { system, groups } = groupMessages(messages);
  const maxTokens = options.maxTokens ?? 32_000;
  const keepRecentGroups = Math.max(0, options.keepRecentGroups ?? 4);
  const systemTokens = estimateMessagesTokens(system);

  let budget = maxTokens - systemTokens;
  let keptFrom = groups.length;
  let keptTokens = 0;

  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (!group) break;
    const groupTokens = estimateMessagesTokens(group);
    const keptSoFar = groups.length - index;

    if (keptSoFar <= keepRecentGroups || keptTokens + groupTokens <= budget) {
      keptTokens += groupTokens;
      keptFrom = index;
    } else {
      break;
    }
  }

  return {
    system,
    kept: groups.slice(keptFrom),
    dropped: groups.slice(0, keptFrom),
    tokens: systemTokens + keptTokens,
  };
}

export interface WindowOutcome {
  messages: ChatMessage[];
  droppedGroups: number;
  dropped: ChatMessage[][];
  tokens: number;
}

export function applySlidingWindow(
  messages: readonly ChatMessage[],
  options: WindowOptions = {},
): WindowOutcome {
  const plan = planSlidingWindow(messages, options);
  return {
    messages: [...plan.system, ...plan.kept.flat()],
    droppedGroups: plan.dropped.length,
    dropped: plan.dropped,
    tokens: plan.tokens,
  };
}
