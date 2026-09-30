import type { AgentLoopOptions } from '../core/agent-loop.js';
import type { ChatModel } from '../providers/chat-model.js';
import {
  FailoverChatModel,
  buildProviders,
  createFailoverModel,
  formatFailoverEvent,
  type ProviderState,
} from '../providers/index.js';
import { applyDefaultToolMiddleware, withContextBudget } from '../robust/index.js';
import { createBuiltinTools } from '../tools/builtin/index.js';
import { ToolRegistry } from '../tools/registry.js';

/** 装配产物：编排层只依赖这两个抽象，不认识具体供应商与工具实现。 */
export interface AgentRuntime {
  model: ChatModel;
  tools: ToolRegistry;
  /** 故障转移下可查每个供应商的熔断状态；只有一家供应商时为 undefined */
  providerStates?: () => ProviderState[];
  /** 编排层选项（幻觉防护开关等），由 AgentService 透传给 AgentLoop */
  loopOptions?: AgentLoopOptions;
}

export interface AgentRuntimeOptions {
  workspaceRoot?: string;
  providerKey?: string;
  allowedCommands?: readonly string[];
  commandTimeoutMs?: number;
  /** 转移过程打印到控制台（默认开）。测试里关掉以免污染输出。 */
  logFailover?: boolean;
}

/**
 * 把「模型供应商 + 工具 + 鲁棒性中间件」装配成一个运行时。
 * 换供应商只改 AGENT_PROVIDER，换工具只改这里——AgentLoop 完全不知情（见 ADR-0003、ADR-0002）。
 */
export function createAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  const env = process.env;
  const providers = buildProviders();
  const logFailover = options.logFailover ?? true;

  // 主供应商打头，其余按 priority 兜底；转移对 AgentLoop 透明
  const routed = createFailoverModel(providers, {
    primaryKey: options.providerKey ?? env.AGENT_PROVIDER,
    temperature: Number(env.AGENT_TEMPERATURE ?? 0.3),
    maxTokens: Number(env.AGENT_MAX_TOKENS ?? 4096),
    failover: logFailover
      ? {
          onEvent: (event) => {
            const line = formatFailoverEvent(event);
            if (line) console.warn(`[model] ${line}`);
          },
        }
      : undefined,
  });

  const providerStates =
    routed instanceof FailoverChatModel ? () => routed.states() : undefined;

  // 上下文预算层包在模型外层：轨迹在 AgentLoop 里保持完整，收缩的只是发给模型的视图
  const model = withContextBudget(routed, {
    maxTokens: Number(env.AGENT_CONTEXT_TOKENS ?? 32_000),
    maxToolResultTokens: Number(env.AGENT_TOOL_RESULT_TOKENS ?? 2_000),
  });

  const builtin = createBuiltinTools({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    allowedCommands: options.allowedCommands,
    commandTimeoutMs: options.commandTimeoutMs,
  });

  const tools = new ToolRegistry().registerAll(builtin);
  applyDefaultToolMiddleware(tools, { timeoutMs: options.commandTimeoutMs ?? 30_000 });

  // 幻觉防护默认关：开了会要求模型给结论标注来源、交付前多一次核查，
  // 是「更可信但更慢更贵」的取舍，交给使用方明确开启（见 .env.example）。
  const loopOptions: AgentLoopOptions = {
    sourceConstraint: { enabled: env.AGENT_SOURCE_CONSTRAINT === 'true' },
    selfCheck: { enabled: env.AGENT_SELF_CHECK === 'true' },
  };

  return { model, tools, providerStates, loopOptions };
}
