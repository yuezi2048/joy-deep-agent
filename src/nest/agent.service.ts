import { Inject, Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { AgentLoop, type AgentEvent, type AgentRunResult } from '../core/agent-loop.js';
import type { ChatMessage } from '../core/types.js';
import { InMemoryMemoryStore, type MemoryStore } from '../memory/index.js';
import type { ProviderState } from '../providers/index.js';
import type { AgentRuntime } from '../runtime.js';

export const AGENT_RUNTIME = Symbol('AGENT_RUNTIME');
export const AGENT_MEMORY_STORE = Symbol('AGENT_MEMORY_STORE');

export interface RuntimeInfo {
  provider: string;
  model: string;
  tools: string[];
  sessions: number;
  /** 故障转移下每个供应商的熔断状态；只有一家供应商时为空数组 */
  providers: ProviderState[];
}

export interface AgentServiceOptions {
  /**
   * 新会话最多接回多少条历史。0 或负数表示不限。
   * 默认取 `AGENT_MEMORY_HISTORY`（缺省 40）——历史无限接回来 = 上下文越滚越大，迟早炸。
   */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 40;

/**
 * 服务化外壳：把 AgentLoop 包成可注入的 Provider，并按会话隔离上下文。
 * 同一个 sessionId 复用同一个 AgentLoop（多轮对话），不同会话互不串味。
 *
 * 会话轨迹同时写进 `MemoryStore`（ADR-0004）。`AGENT_MEMORY=memory` 时两者都活在进程内，
 * 行为与从前一致；`file` 时新进程能用同一 sessionId 把上下文接回来。
 */
@Injectable()
export class AgentService implements OnApplicationShutdown {
  private readonly sessions = new Map<string, AgentLoop>();
  /** 每个会话已经进过 store 的消息条数：`run()` 给的是全量轨迹，只追加增量，不重复落库 */
  private readonly persisted = new Map<string, number>();
  private readonly memory: MemoryStore;
  private readonly historyLimit: number;

  constructor(
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
    @Optional() @Inject(AGENT_MEMORY_STORE) memory?: MemoryStore,
    options: AgentServiceOptions = {},
  ) {
    this.memory = memory ?? new InMemoryMemoryStore();
    this.historyLimit = options.historyLimit ?? readHistoryLimit();
  }

  info(): RuntimeInfo {
    return {
      provider: this.runtime.model.name,
      model: this.runtime.model.model,
      tools: this.runtime.tools.names(),
      sessions: this.sessions.size,
      providers: this.runtime.providerStates?.() ?? [],
    };
  }

  async run(input: string, sessionId = 'default'): Promise<AgentRunResult> {
    const loop = await this.loopFor(sessionId);
    const result = await loop.run(input);
    await this.persistDelta(sessionId, result.messages);
    return result;
  }

  stream(input: string, sessionId = 'default'): AsyncGenerator<AgentEvent, AgentRunResult> {
    return this.streamSession(input, sessionId);
  }

  /** 清空指定会话的上下文与历史。两个都要清：只清一个，下一次 run 会把另一个又捞回来。 */
  async reset(sessionId = 'default'): Promise<void> {
    this.sessions.get(sessionId)?.reset();
    this.persisted.set(sessionId, 0);
    await this.memory.clear(sessionId);
  }

  /** 进程退出时把协议层拉起的资源（MCP 子进程等）收干净，别留孤儿进程。 */
  async onApplicationShutdown(): Promise<void> {
    await this.runtime.close?.();
  }

  private async *streamSession(input: string, sessionId: string): AsyncGenerator<AgentEvent, AgentRunResult> {
    const loop = await this.loopFor(sessionId);
    const iterator = loop.runStream(input);

    let next = await iterator.next();
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }

    // 流式同样要落历史：不然「流式跑的会话重启后接不上」，这个坑很难查
    await this.persistDelta(sessionId, next.value.messages);
    return next.value;
  }

  private async loopFor(sessionId: string): Promise<AgentLoop> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const seed = await this.loadSeed(sessionId);
    const baseOptions = this.runtime.loopOptions ?? {};
    const loop = new AgentLoop({
      model: this.runtime.model,
      tools: this.runtime.tools,
      options: seed.length > 0 ? { ...baseOptions, initialMessages: seed } : baseOptions,
    });

    this.sessions.set(sessionId, loop);
    this.persisted.set(sessionId, seed.length);
    return loop;
  }

  private async loadSeed(sessionId: string): Promise<ChatMessage[]> {
    const history = await this.memory.history(sessionId, this.historyLimit);
    return trimToTurnBoundary(history);
  }

  private async persistDelta(sessionId: string, messages: readonly ChatMessage[]): Promise<void> {
    const from = this.persisted.get(sessionId) ?? 0;
    for (const message of messages.slice(from)) {
      await this.memory.append(sessionId, message);
    }
    this.persisted.set(sessionId, messages.length);
  }
}

/**
 * 截断只能落在「一轮的开头」。留下一条没有归属的 `tool` 消息，模型侧会直接报错
 * ——那是个只在长会话里才出现的坑，所以在这里切齐。
 */
function trimToTurnBoundary(messages: readonly ChatMessage[]): ChatMessage[] {
  const start = messages.findIndex((message) => message.role === 'user');
  if (start === -1) return [];
  return messages.slice(start).map((message) => ({ ...message }));
}

function readHistoryLimit(value = process.env.AGENT_MEMORY_HISTORY): number {
  if (value === undefined || value.trim() === '') return DEFAULT_HISTORY_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`AGENT_MEMORY_HISTORY 必须是整数，收到 "${value}"（0 或负数表示不限）`);
  }
  return parsed;
}
