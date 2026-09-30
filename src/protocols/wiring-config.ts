import { errorMessage } from '../core/errors.js';

/**
 * 协议层的环境变量解析与校验，和「怎么装配」分开（见 ADR-0006）。
 * 配置错误（非法 JSON / 缺必填字段）一律抛错：工具来源缺失会静默改变 agent 的能力边界，
 * 宁可起不来，也别悄悄少几个工具——与 `security/preflight.ts` 同一姿态。
 */
export interface McpServerConfig {
  /** 可执行文件，例如 `npx` / `node` */
  command: string;
  args?: string[];
  /** 追加给子进程的环境变量 */
  env?: Record<string, string>;
  cwd?: string;
  /** 工具名前缀覆盖；默认 `mcp__<name>__` */
  prefix?: string;
}

export interface A2AAgentConfig {
  /** 能取到 Agent Card 的基地址 */
  url: string;
  cardPath?: string;
  timeoutMs?: number;
}

export const MCP_SERVERS_ENV = 'MCP_SERVERS';
export const A2A_AGENTS_ENV = 'A2A_AGENTS';

export function parseMcpServers(raw: string | undefined): Record<string, McpServerConfig> {
  const entries = parseEnvObject(raw, MCP_SERVERS_ENV);
  const result: Record<string, McpServerConfig> = {};

  for (const [name, value] of Object.entries(entries)) {
    const label = `${MCP_SERVERS_ENV}.${name}`;
    const record = requireObject(value, label);
    const config: McpServerConfig = { command: requireString(record.command, `${label}.command`) };

    if (record.args !== undefined) config.args = requireStringArray(record.args, `${label}.args`);
    if (record.env !== undefined) config.env = requireStringMap(record.env, `${label}.env`);
    if (record.cwd !== undefined) config.cwd = requireString(record.cwd, `${label}.cwd`);
    if (record.prefix !== undefined) config.prefix = requireString(record.prefix, `${label}.prefix`);

    result[name] = config;
  }

  return result;
}

export function parseA2AAgents(raw: string | undefined): Record<string, A2AAgentConfig> {
  const entries = parseEnvObject(raw, A2A_AGENTS_ENV);
  const result: Record<string, A2AAgentConfig> = {};

  for (const [name, value] of Object.entries(entries)) {
    const label = `${A2A_AGENTS_ENV}.${name}`;
    const record = requireObject(value, label);
    const config: A2AAgentConfig = { url: requireString(record.url, `${label}.url`) };

    if (record.cardPath !== undefined) config.cardPath = requireString(record.cardPath, `${label}.cardPath`);
    if (record.timeoutMs !== undefined) config.timeoutMs = requirePositiveNumber(record.timeoutMs, `${label}.timeoutMs`);

    result[name] = config;
  }

  return result;
}

function parseEnvObject(raw: string | undefined, name: string): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`环境变量 ${name} 不是合法 JSON：${errorMessage(error)}`);
  }
  return requireObject(parsed, name);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是一个 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} 必须是正数`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return value as string[];
}

function requireStringMap(value: unknown, label: string): Record<string, string> {
  const record = requireObject(value, label);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} 必须是字符串`);
  }
  return record as Record<string, string>;
}
