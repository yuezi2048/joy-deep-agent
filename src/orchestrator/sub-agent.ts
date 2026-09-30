import { AgentLoop, type AgentLoopOptions, type AgentRunResult } from '../core/agent-loop.js';
import type { ChatModel } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentRole } from './role.js';

/**
 * 子智能体：一个角色的可执行形态。
 *
 * 关键设计：**每次 `run()` 都新建一个 `AgentLoop`**。
 * 上下文（messages）是 AgentLoop 实例上的状态，复用实例就等于复用上下文——
 * 那不叫子智能体，那只是主循环多跑了几轮。新实例 = 干净的上下文窗口，
 * 这正是「避免单 Agent 长链路上下文溢出」的落点：子智能体烧掉的 token 不会累积回编排层。
 */
export interface SubAgentDeps {
  role: AgentRole;
  model: ChatModel;
  /** 已按角色裁剪过的工具集（见 `AgentRuntime.forkTools`） */
  tools: ToolRegistry;
  maxSteps?: number;
  maxDurationMs?: number;
  /** HITL 确认钩子；不传时需确认的工具会被拒绝（沿用 AgentLoop 的安全默认） */
  confirm?: AgentLoopOptions['confirm'];
  /** 每步子任务执行前注入的提示片段（技能命中才非空）；不传就不注入 */
  augmentPrompt?: AgentLoopOptions['augmentPrompt'];
  now?: () => number;
}

export interface SubAgentRunOptions {
  signal?: AbortSignal;
}

export class SubAgent {
  readonly role: AgentRole;

  constructor(private readonly deps: SubAgentDeps) {
    this.role = deps.role;
  }

  async run(task: string, options: SubAgentRunOptions = {}): Promise<AgentRunResult> {
    const loop = new AgentLoop({
      model: this.deps.model,
      tools: this.deps.tools,
      options: {
        systemPrompt: this.deps.role.systemPrompt,
        ...(this.deps.maxSteps !== undefined ? { maxSteps: this.deps.maxSteps } : {}),
        ...(this.deps.maxDurationMs !== undefined ? { maxDurationMs: this.deps.maxDurationMs } : {}),
        ...(this.deps.confirm ? { confirm: this.deps.confirm } : {}),
        ...(this.deps.augmentPrompt ? { augmentPrompt: this.deps.augmentPrompt } : {}),
        ...(this.deps.now ? { now: this.deps.now } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    });

    return loop.run(task);
  }
}

export function createSubAgent(deps: SubAgentDeps): SubAgent {
  return new SubAgent(deps);
}
