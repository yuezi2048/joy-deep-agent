import { resolve } from 'node:path';
import type { AgentLoopOptions } from './core/agent-loop.js';
import type { ToolDefinition } from './core/types.js';
import type { ChatModel } from './providers/chat-model.js';
import {
  FailoverChatModel,
  buildProviders,
  createFailoverModel,
  formatFailoverEvent,
  type ProviderState,
} from './providers/index.js';
import { createProtocolTools, type ProtocolWiringOptions } from './protocols/index.js';
import { applyDefaultToolMiddleware, withContextBudget } from './robust/index.js';
import { SkillRegistry } from './skills/index.js';
import { createBuiltinTools } from './tools/builtin/index.js';
import { ToolRegistry } from './tools/registry.js';
import { WorkspaceSandbox, type SandboxLimits } from './vfs/index.js';

/** 装配产物：编排层只依赖这两个抽象，不认识具体供应商与工具实现。 */
export interface AgentRuntime {
  model: ChatModel;
  tools: ToolRegistry;
  /** 故障转移下可查每个供应商的熔断状态；只有一家供应商时为 undefined */
  providerStates?: () => ProviderState[];
  /** 编排层选项（幻觉防护开关等），由 AgentService 透传给 AgentLoop */
  loopOptions?: AgentLoopOptions;
  /** 关掉协议层拉起的资源（MCP 子进程等）。没有接协议时为空。 */
  close?: () => Promise<void>;
  /** 工作区沙箱：挂载表、写盘配额与审计都在它身上，启动时可打印挂载点 */
  sandbox?: WorkspaceSandbox;
  /** 技能加载器：入口可以打印加载到的技能与 problems */
  skills?: SkillRegistry;
  /**
   * 派生一个只含白名单工具的注册表；不传就是全量。名字写错会立刻报错，不静默少工具。
   *
   * **中间件是新建的**，这一点不能省：`dedupe` 的缓存与 `budget` 的计数都是中间件实例上的状态，
   * 而 `AgentLoop` 每次执行前都会 `resetState()`。并发子智能体若共用同一批中间件实例，
   * 一个子智能体的 reset 会清掉另一个正在飞的状态。
   */
  forkTools?: (allow?: readonly string[]) => ToolRegistry;
}

export interface AgentRuntimeOptions {
  workspaceRoot?: string;
  /** 收窄写盘（相对工作区）；不传则读 `AGENT_WRITE_ROOT`，再没有就全工作区可写 */
  writeRoot?: string;
  /** 写盘配额；不传则读 AGENT_MAX_FILE_BYTES / AGENT_MAX_TOTAL_BYTES / AGENT_MAX_FILES */
  limits?: SandboxLimits;
  /** 技能目录（相对工作区）；不传则读 AGENT_SKILLS_DIR，再没有就用 .joy-agent/skills */
  skillsDir?: string;
  /**
   * HITL 确认钩子。入口自己持有输入通道（比如 CLI 的 readline）并从装配点传进来——
   * 谁拥有 stdin 谁提供 ask，工具层不再偷偷建第二个输入接口（原型复盘第 5 条）。
   */
  confirm?: AgentLoopOptions['confirm'];
  providerKey?: string;
  allowedCommands?: readonly string[];
  commandTimeoutMs?: number;
  /** 转移过程打印到控制台（默认开）。测试里关掉以免污染输出。 */
  logFailover?: boolean;
  /** 协议层装配参数（环境变量源、连接工厂），测试用来注入假远端。 */
  protocolOptions?: ProtocolWiringOptions;
}

/**
 * 把「模型供应商 + 工具 + 鲁棒性中间件」装配成一个运行时。
 * 换供应商只改 AGENT_PROVIDER，换工具只改这里——AgentLoop 完全不知情（见 ADR-0003、ADR-0002）。
 */
export async function createAgentRuntime(options: AgentRuntimeOptions = {}): Promise<AgentRuntime> {
  const env = process.env;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const providers = buildProviders();
  const logFailover = options.logFailover ?? true;
  const writeRoot = options.writeRoot ?? env.AGENT_WRITE_ROOT;
  const limits = readLimits(env, options.limits);

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

  // 协议工具（MCP 工具来源 / A2A delegate）与内置工具进同一个注册表：中间件、HITL、依赖序一视同仁
  const protocol = await createProtocolTools(options.protocolOptions ?? {});

  const sandbox = new WorkspaceSandbox({
    root: workspaceRoot,
    ...(writeRoot ? { writeRoot } : {}),
    ...(limits ? { limits } : {}),
  });

  const builtin = createBuiltinTools({
    sandbox,
    allowedCommands: options.allowedCommands,
    commandTimeoutMs: options.commandTimeoutMs,
  });

  const pool = [...builtin, ...protocol.tools];
  const middlewareOptions = { timeoutMs: options.commandTimeoutMs ?? 30_000 };
  const forkTools = (allow?: readonly string[]): ToolRegistry => {
    const picked = allow ? pickTools(pool, allow) : pool;
    const registry = new ToolRegistry().registerAll(picked);
    applyDefaultToolMiddleware(registry, middlewareOptions);
    return registry;
  };

  const tools = forkTools();

  // 技能：每轮按输入匹配触发条件，命中才注入提示词；目录不在就等于没有技能（不是错误）
  const skillTokens = readLimit('AGENT_SKILL_TOKENS', env);
  const skills = new SkillRegistry({
    dir: resolve(workspaceRoot, options.skillsDir ?? env.AGENT_SKILLS_DIR ?? '.joy-agent/skills'),
    root: workspaceRoot,
  });

  // 幻觉防护默认关：开了会要求模型给结论标注来源、交付前多一次核查，
  // 是「更可信但更慢更贵」的取舍，交给使用方明确开启（见 .env.example）。
  const loopOptions: AgentLoopOptions = {
    sourceConstraint: { enabled: env.AGENT_SOURCE_CONSTRAINT === 'true' },
    selfCheck: { enabled: env.AGENT_SELF_CHECK === 'true' },
    augmentPrompt: (input) =>
      skills.promptFor(input, skillTokens !== undefined ? { maxTokens: skillTokens } : {}),
    ...(options.confirm ? { confirm: options.confirm } : {}),
  };

  return { model, tools, providerStates, loopOptions, close: protocol.close, sandbox, skills, forkTools };
}

/** 写盘配额：环境变量打底，显式传入的覆盖它。没配的项交给 WorkspaceSandbox 的缺省值。 */
function readLimits(env: NodeJS.ProcessEnv, overrides?: SandboxLimits): SandboxLimits {
  const limits: SandboxLimits = {};
  const maxFileBytes = readLimit('AGENT_MAX_FILE_BYTES', env);
  if (maxFileBytes !== undefined) limits.maxFileBytes = maxFileBytes;
  const maxTotalBytes = readLimit('AGENT_MAX_TOTAL_BYTES', env);
  if (maxTotalBytes !== undefined) limits.maxTotalBytes = maxTotalBytes;
  const maxFiles = readLimit('AGENT_MAX_FILES', env);
  if (maxFiles !== undefined) limits.maxFiles = maxFiles;
  return { ...limits, ...overrides };
}

/** 读一个可选的正整数配置：没配返回 undefined，配错直接报错（不静默取默认值）。 */
function readLimit(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数，收到 "${raw}"`);
  }
  return parsed;
}

/** 按白名单挑工具。写错名字直接报错：静默少一个工具会变成很难查的「模型怎么不用它」。 */
function pickTools(pool: readonly ToolDefinition[], allow: readonly string[]): ToolDefinition[] {
  const byName = new Map(pool.map((tool) => [tool.name, tool]));
  const unknown = allow.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `工具白名单里有不存在的工具：${unknown.join('、')}。当前可用：${[...byName.keys()].join('、') || '（无）'}`,
    );
  }
  return allow.map((name) => byName.get(name)!);
}
