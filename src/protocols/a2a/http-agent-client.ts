import { randomUUID } from 'node:crypto';
import { isRecord } from '../../core/record.js';
import {
  A2A_METHOD_SEND,
  AGENT_CARD_PATH,
  type A2AAgentCard,
  type A2AAgentSkill,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './a2a-types.js';

/**
 * 远端 agent 的端口（ADR-0006）。测试注入假实现，生产走 `HttpA2AAgentClient`。
 * `name` 是本地的稳定标识，用来在 `delegate` 工具里点名；名片上的 `card().name` 只用于展示。
 */
export interface A2AAgentClient {
  readonly name: string;
  card(options?: { signal?: AbortSignal }): Promise<A2AAgentCard>;
  send(task: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export interface HttpA2AAgentClientOptions {
  /** 远端 agent 的基地址（或任意可拼出 Agent Card 路径的前缀），例如 `http://localhost:8888` */
  url: string;
  /** Agent Card 路径，默认 A2A 规定的 `/.well-known/agent-card.json` */
  cardPath?: string;
  /** 单次请求的墙钟上限，默认 60s */
  timeoutMs?: number;
  /** 注入用；默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 用 `fetch` 实现 A2A 客户端。
 *
 * 任务端点遵循 A2A 规范：**以 Agent Card 里声明的 `url` 为准**，卡片没写才退回配置的基地址。
 * 这样「名片发布在站点根、任务端点挂在别处」的部署（正是本仓库自己的 Nest 服务）也能对上。
 */
export class HttpA2AAgentClient implements A2AAgentClient {
  private readonly baseUrl: string;
  private readonly cardPath: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** 发现一次就够；名片本身不会在会话中途变。 */
  private cardCache?: A2AAgentCard;

  constructor(
    readonly name: string,
    options: HttpA2AAgentClientOptions,
  ) {
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.cardPath = options.cardPath ?? AGENT_CARD_PATH;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async card(options: { signal?: AbortSignal } = {}): Promise<A2AAgentCard> {
    const url = `${this.baseUrl}${this.cardPath}`;
    const response = await this.request(url, { method: 'GET' }, options.signal);
    const payload = await readJson(response, url);
    this.cardCache = toCard(payload, this.name);
    return this.cardCache;
  }

  async send(task: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const card = this.cardCache ?? (await this.card(options));
    const endpoint = card.url ?? this.baseUrl;

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: A2A_METHOD_SEND,
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: task }],
          messageId: randomUUID(),
        },
      },
    };

    const response = await this.request(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      options.signal,
    );
    const payload = (await readJson(response, endpoint)) as JsonRpcResponse;

    if (payload?.error) {
      const message = payload.error.message ?? JSON.stringify(payload.error);
      throw new Error(`远端 agent "${this.name}" 返回 JSON-RPC 错误：${message}`);
    }

    const text = extractMessageText(payload?.result);
    if (text === undefined) {
      throw new Error(
        `远端 agent "${this.name}" 的响应里没有 result.message.parts[0].text：${preview(payload)}`,
      );
    }
    return text;
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: combined });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`连不上远端 agent "${this.name}"（${url}）：${reason}`);
    }

    if (!response.ok) {
      throw new Error(`远端 agent "${this.name}" 返回 HTTP ${response.status}（${url}）`);
    }
    return response;
  }
}

/** 从 `result.message.parts` 里取文本；结构不对就返回 undefined，由调用方决定怎么报错。 */
export function extractMessageText(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const message = isRecord(result.message) ? result.message : undefined;
  const parts = Array.isArray(message?.parts) ? message.parts : undefined;
  if (!parts) return undefined;

  const texts = parts
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : undefined))
    .filter((text): text is string => text !== undefined);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

async function readJson(response: Response, url: string): Promise<unknown> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`远端 ${url} 的响应不是合法 JSON：${preview(raw)}`);
  }
}

function toCard(payload: unknown, fallbackName: string): A2AAgentCard {
  if (!isRecord(payload)) throw new Error(`Agent Card 不是对象：${preview(payload)}`);
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name : fallbackName;
  const card: A2AAgentCard = { name };
  if (typeof payload.description === 'string') card.description = payload.description;
  if (typeof payload.url === 'string') card.url = payload.url;
  if (typeof payload.version === 'string') card.version = payload.version;

  if (Array.isArray(payload.skills)) {
    const skills = payload.skills.filter(isRecord).flatMap(toSkill);
    if (skills.length > 0) card.skills = skills;
  }

  return card;
}

function toSkill(skill: Record<string, unknown>): A2AAgentSkill[] {
  if (typeof skill.name !== 'string') return [];
  const mapped: A2AAgentSkill = { name: skill.name };
  if (typeof skill.id === 'string') mapped.id = skill.id;
  if (typeof skill.description === 'string') mapped.description = skill.description;
  if (Array.isArray(skill.tags)) mapped.tags = skill.tags.filter((tag): tag is string => typeof tag === 'string');
  if (Array.isArray(skill.examples)) {
    mapped.examples = skill.examples.filter((item): item is string => typeof item === 'string');
  }
  return [mapped];
}

function preview(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
