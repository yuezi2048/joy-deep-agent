import { isRecord } from '../../core/record.js';
import { A2A_METHOD_SEND } from './a2a-types.js';
import { extractMessageText } from './http-agent-client.js';

/**
 * `message/send` 这一条 A2A 消息的解析与构造。
 *
 * 放在协议层而不是控制器里：JSON-RPC 信封、`parts` 结构、`contextId` 都是协议知识，
 * nest 只该负责把它翻译成 HTTP 状态码（ADR-0006）。
 */
export type MessageSendParse =
  | { ok: true; id: unknown; task: string; contextId?: string }
  | { ok: false; id: unknown; reason: MessageSendErrorReason; message: string };

export type MessageSendErrorReason = 'invalid-request' | 'method-not-found' | 'invalid-params';

export function parseMessageSend(body: unknown): MessageSendParse {
  const id = isRecord(body) && body.id !== undefined ? body.id : null;

  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return {
      ok: false,
      id,
      reason: 'invalid-request',
      message: 'Invalid Request：需要 JSON-RPC 2.0 信封（jsonrpc/id/method）',
    };
  }

  if (body.method !== A2A_METHOD_SEND) {
    return {
      ok: false,
      id,
      reason: 'method-not-found',
      message: `Method not found：本端点只支持 ${A2A_METHOD_SEND}`,
    };
  }

  const task = extractMessageText(body.params);
  if (!task?.trim()) {
    return {
      ok: false,
      id,
      reason: 'invalid-params',
      message: 'Invalid params：params.message.parts 里没有可执行的文本',
    };
  }

  const contextId = readContextId(body.params);
  return contextId ? { ok: true, id, task, contextId } : { ok: true, id, task };
}

/** 按 A2A 的 JSON-RPC 响应格式回包。 */
export function messageSendResult(id: unknown, text: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      message: {
        role: 'agent',
        parts: [{ kind: 'text', text }],
      },
    },
  };
}

function readContextId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return typeof params.contextId === 'string' && params.contextId.trim() ? params.contextId : undefined;
}
