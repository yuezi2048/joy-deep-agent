/**
 * A2A 协议里本项目真正用到的部分（ADR-0005：A2A 是子 agent 传输）。
 *
 * 只覆盖「发现 + 同步委派一次任务」：任务 ID、状态轮询、取消、流式这些
 * 长任务语义按 ADR-0005 的后果暂时压平——需要时由客户端内部处理，对主循环仍是一次工具调用。
 */

/** Agent Card 里声明的一项能力。调用方靠它决定把任务委派给谁。 */
export interface A2AAgentSkill {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

/** 远端 agent 的名片，发布在 `/.well-known/agent-card.json`。 */
export interface A2AAgentCard {
  name: string;
  description?: string;
  url?: string;
  version?: string;
  skills?: A2AAgentSkill[];
}

/** JSON-RPC 2.0 请求信封。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应里我们关心的部分。 */
export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export const A2A_METHOD_SEND = 'message/send';
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
