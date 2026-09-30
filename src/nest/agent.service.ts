import { Inject, Injectable } from '@nestjs/common';
import { AgentLoop, type AgentEvent, type AgentRunResult } from '../core/agent-loop.js';
import type { ProviderState } from '../providers/index.js';
import type { AgentRuntime } from './runtime.js';

export const AGENT_RUNTIME = Symbol('AGENT_RUNTIME');

export interface RuntimeInfo {
  provider: string;
  model: string;
  tools: string[];
  sessions: number;
  /** 故障转移下每个供应商的熔断状态；只有一家供应商时为空数组 */
  providers: ProviderState[];
}

/**
 * 服务化外壳：把 AgentLoop 包成可注入的 Provider，并按会话隔离上下文。
 * 同一个 sessionId 复用同一个 AgentLoop（多轮对话），不同会话互不串味。
 */
@Injectable()
export class AgentService {
  private readonly sessions = new Map<string, AgentLoop>();

  constructor(@Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime) {}

  info(): RuntimeInfo {
    return {
      provider: this.runtime.model.name,
      model: this.runtime.model.model,
      tools: this.runtime.tools.names(),
      sessions: this.sessions.size,
      providers: this.runtime.providerStates?.() ?? [],
    };
  }

  run(input: string, sessionId = 'default'): Promise<AgentRunResult> {
    return this.loopFor(sessionId).run(input);
  }

  stream(input: string, sessionId = 'default'): AsyncGenerator<AgentEvent, AgentRunResult> {
    return this.loopFor(sessionId).runStream(input);
  }

  reset(sessionId = 'default'): void {
    this.sessions.get(sessionId)?.reset();
  }

  private loopFor(sessionId: string): AgentLoop {
    let loop = this.sessions.get(sessionId);
    if (!loop) {
      loop = new AgentLoop({
        model: this.runtime.model,
        tools: this.runtime.tools,
        ...(this.runtime.loopOptions ? { options: this.runtime.loopOptions } : {}),
      });
      this.sessions.set(sessionId, loop);
    }
    return loop;
  }
}
