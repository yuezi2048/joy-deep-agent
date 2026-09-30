import { mkdir, readFile, rename, rm, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** 检查点的通用信封。`version` 用于将来做迁移，读到不认识的版本直接拒绝，不做硬解析。 */
export interface Checkpoint<State = unknown> {
  id: string;
  version: number;
  updatedAt: number;
  state: State;
}

/**
 * 检查点存储（ADR-0004）。
 * 只定接口，默认给内存与 JSON 落盘两种实现，数据库留到确有跨进程需求时再加。
 */
export interface CheckpointStore {
  save<State>(id: string, state: State): Promise<void>;
  /** 没有这个检查点时返回 null；版本不匹配时抛错（宁可报错，也不要静默当成冷启动）。 */
  load<State>(id: string): Promise<Checkpoint<State> | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

export const CHECKPOINT_VERSION = 1;

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly entries = new Map<string, Checkpoint>();

  async save<State>(id: string, state: State): Promise<void> {
    this.entries.set(id, {
      id,
      version: CHECKPOINT_VERSION,
      updatedAt: Date.now(),
      state,
    });
  }

  async load<State>(id: string): Promise<Checkpoint<State> | null> {
    const entry = this.entries.get(id);
    return entry ? (entry as Checkpoint<State>) : null;
  }

  async list(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

/**
 * JSON 落盘实现。写入是**原子**的：先写临时文件再 rename，
 * 这样即使进程在写入过程中被杀，磁盘上要么是旧的完整检查点、要么是新的完整检查点，
 * 不会留下半个文件导致下次续跑读到坏数据。
 */
export class JsonFileCheckpointStore implements CheckpointStore {
  private readonly dir: string;

  constructor(dir = '.joy-agent/checkpoints') {
    this.dir = resolve(dir);
  }

  get directory(): string {
    return this.dir;
  }

  async save<State>(id: string, state: State): Promise<void> {
    const payload: Checkpoint<State> = {
      id,
      version: CHECKPOINT_VERSION,
      updatedAt: Date.now(),
      state,
    };
    const target = this.pathFor(id);
    await mkdir(dirname(target), { recursive: true });

    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(temp, target);
  }

  async load<State>(id: string): Promise<Checkpoint<State> | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id), 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }

    const parsed = JSON.parse(raw) as Checkpoint<State>;
    if (parsed.version !== CHECKPOINT_VERSION) {
      throw new Error(
        `检查点 "${id}" 的版本是 ${parsed.version}，当前实现只认 ${CHECKPOINT_VERSION}：拒绝解析`,
      );
    }
    return parsed;
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  private pathFor(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }
}
