/** joy-deep-agent 对外入口。L1 门面只暴露公开 API，内部结构不外泄。 */

export * from './core/types.js';
export * from './core/errors.js';
export {
  AgentLoop,
  DEFAULT_SYSTEM_PROMPT,
  type AgentEvent,
  type AgentLoopDeps,
  type AgentLoopOptions,
  type AgentRunResult,
  type StopReason,
} from './core/agent-loop.js';
export { AsyncQueue } from './core/async-queue.js';

export { ToolRegistry } from './tools/registry.js';
export { parseToolArguments, type ParsedArguments } from './tools/arguments.js';
export {
  createBuiltinTools,
  evaluateExpression,
  safeExec,
  DEFAULT_ALLOWED_COMMANDS,
  type BuiltinToolOptions,
  type SafeExecOptions,
  type SafeExecResult,
} from './tools/builtin/index.js';

export { PathGuard } from './security/path-guard.js';

export * from './providers/index.js';
export * from './robust/index.js';
