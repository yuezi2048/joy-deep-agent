import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ChatMessage } from '../core/types.js';

/**
 * Memory（ADR-0004）。两类东西分开存，因为它们的生命周期完全不同：
 *
 * - **短期**：会话消息，按 sessionId 累积，用来在做一次多轮对话时把上下文接回来。
 * - **长期**：跨会话的条目，按 scope 累积，用来记住「上次怎么做的」「用户偏好什么」。
 *
 * ADR-0004 只定了 `append` / `history`；实现补上 `clear` / `sessions`（会话管理必需）
 * 与 `remember` / `recall`（长期记忆），后者必须真被用上（Supervisor 写、Planner 读），
 * 不做没人调用的接口。
 */
export interface MemoryStore {
  /** 追加一条会话消息 */
  append(sessionId: string, message: ChatMessage): Promise<void>;
  /** 读回会话消息；`limit` 取**最近**的若干条 */
  history(sessionId: string, limit?: number): Promise<ChatMessage[]>;
  clear(sessionId: string): Promise<void>;
  sessions(): Promise<string[]>;
  /** 长期记忆：追加一条条目。按时间倒序读回。 */
  remember(scope: string, entry: string): Promise<void>;
  recall(scope: string, limit?: number): Promise<string[]>;
}

/** 读到不认识的版本直接拒绝，不做硬解析（与 CheckpointStore 同一姿态）。 */
export const MEMORY_VERSION = 1;

interface SessionRecord {
  messages: ChatMessage[];
  updatedAt: number;
}

interface FactRecord {
  text: string;
  createdAt: number;
}

interface MemoryData {
  version: number;
  sessions: Record<string, SessionRecord>;
  facts: Record<string, FactRecord[]>;
}

function emptyData(): MemoryData {
  return { version: MEMORY_VERSION, sessions: {}, facts: {} };
}

/** 最近 `limit` 条：历史太长时丢掉最旧的，保留最近的对话。 */
function tail<T>(items: readonly T[], limit?: number): T[] {
  if (limit === undefined || limit <= 0 || items.length <= limit) return [...items];
  return items.slice(items.length - limit);
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly data: MemoryData = emptyData();

  async append(sessionId: string, message: ChatMessage): Promise<void> {
    const record = this.data.sessions[sessionId] ?? { messages: [], updatedAt: 0 };
    record.messages.push({ ...message });
    record.updatedAt = Date.now();
    this.data.sessions[sessionId] = record;
  }

  async history(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    return tail(this.data.sessions[sessionId]?.messages ?? [], limit).map((message) => ({ ...message }));
  }

  async clear(sessionId: string): Promise<void> {
    delete this.data.sessions[sessionId];
  }

  async sessions(): Promise<string[]> {
    return Object.keys(this.data.sessions);
  }

  async remember(scope: string, entry: string): Promise<void> {
    const facts = this.data.facts[scope] ?? [];
    facts.push({ text: entry, createdAt: Date.now() });
    this.data.facts[scope] = facts;
  }

  async recall(scope: string, limit?: number): Promise<string[]> {
    const facts = this.data.facts[scope] ?? [];
    return tail(facts, limit).reverse().map((fact) => fact.text);
  }
}

/**
 * JSON 落盘实现。整个 store 一个文件，写入是**原子**的（临时文件 + rename），
 * 单进程内不会读到半个文件。并发写用一条 Promise 链串起来，避免后写的覆盖先写的。
 *
 * 代价：每条消息都重写整个文件，数据量大时会明显变慢。当前规模（单进程、会话量小）不值得
 * 引入数据库；真到了那一步，换一个 `MemoryStore` 实现即可，调用方零改动（ADR-0004）。
 */
export class JsonFileMemoryStore implements MemoryStore {
  private readonly file: string;
  private cache: MemoryData | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir = '.joy-agent/memory') {
    this.file = resolve(dir, 'memory.json');
  }

  get path(): string {
    return this.file;
  }

  async append(sessionId: string, message: ChatMessage): Promise<void> {
    await this.mutate((data) => {
      const record = data.sessions[sessionId] ?? { messages: [], updatedAt: 0 };
      record.messages.push({ ...message });
      record.updatedAt = Date.now();
      data.sessions[sessionId] = record;
    });
  }

  async history(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    const data = await this.load();
    return tail(data.sessions[sessionId]?.messages ?? [], limit).map((message) => ({ ...message }));
  }

  async clear(sessionId: string): Promise<void> {
    await this.mutate((data) => {
      delete data.sessions[sessionId];
    });
  }

  async sessions(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data.sessions);
  }

  async remember(scope: string, entry: string): Promise<void> {
    await this.mutate((data) => {
      const facts = data.facts[scope] ?? [];
      facts.push({ text: entry, createdAt: Date.now() });
      data.facts[scope] = facts;
    });
  }

  async recall(scope: string, limit?: number): Promise<string[]> {
    const data = await this.load();
    return tail(data.facts[scope] ?? [], limit).reverse().map((fact) => fact.text);
  }

  /** 串行化写：读-改-写是一个整体，并发进来会互相覆盖。 */
  private async mutate(change: (data: MemoryData) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const data = await this.load();
      change(data);
      await this.persist(data);
    });
    // 一次写失败不该把后续写全卡死，所以队列只吞掉错误、状态照旧前进
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<MemoryData> {
    if (this.cache) return this.cache;

    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        this.cache = emptyData();
        return this.cache;
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as MemoryData;
    if (parsed.version !== MEMORY_VERSION) {
      throw new Error(
        `记忆文件 ${this.file} 的版本是 ${parsed.version}，当前实现只认 ${MEMORY_VERSION}：拒绝解析`,
      );
    }
    this.cache = parsed;
    return parsed;
  }

  private async persist(data: MemoryData): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await rename(temp, this.file);
  }
}

export interface MemoryStoreOptions {
  /** 缺省 `memory`（进程内）。写错名字直接报错，不悄悄退回内存——那会让「会话怎么又没了」变成悬案。 */
  kind?: string;
  /** `file` 实现的落盘目录 */
  dir?: string;
}

/** 按配置选实现。换实现调用方零改动（ADR-0004）。 */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const kind = (options.kind ?? 'memory').trim().toLowerCase();
  if (kind === 'memory') return new InMemoryMemoryStore();
  if (kind === 'file') return new JsonFileMemoryStore(options.dir ?? '.joy-agent/memory');
  throw new Error(`记忆后端只认 "memory" 或 "file"，收到 "${options.kind}"（见 .env.example 的 AGENT_MEMORY）`);
}
