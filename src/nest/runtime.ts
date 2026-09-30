import type { ChatModel } from '../providers/chat-model.js';
import { buildProviders, createChatModel, selectProvider } from '../providers/index.js';
import { applyDefaultToolMiddleware } from '../robust/index.js';
import { createBuiltinTools } from '../tools/builtin/index.js';
import { ToolRegistry } from '../tools/registry.js';

/** 装配产物：编排层只依赖这两个抽象，不认识具体供应商与工具实现。 */
export interface AgentRuntime {
  model: ChatModel;
  tools: ToolRegistry;
}

export interface AgentRuntimeOptions {
  workspaceRoot?: string;
  providerKey?: string;
  allowedCommands?: readonly string[];
  commandTimeoutMs?: number;
}

/**
 * 把「模型供应商 + 工具 + 鲁棒性中间件」装配成一个运行时。
 * 换供应商只改 AGENT_PROVIDER，换工具只改这里——AgentLoop 完全不知情（见 ADR-0003、ADR-0002）。
 */
export function createAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  const env = process.env;
  const provider = selectProvider(buildProviders(), options.providerKey ?? env.AGENT_PROVIDER);

  const model = createChatModel(provider, {
    temperature: Number(env.AGENT_TEMPERATURE ?? 0.3),
    maxTokens: Number(env.AGENT_MAX_TOKENS ?? 4096),
  });

  const builtin = createBuiltinTools({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    allowedCommands: options.allowedCommands,
    commandTimeoutMs: options.commandTimeoutMs,
  });

  const tools = new ToolRegistry().registerAll(builtin);
  applyDefaultToolMiddleware(tools, { timeoutMs: options.commandTimeoutMs ?? 30_000 });

  return { model, tools };
}
