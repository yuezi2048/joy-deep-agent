import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/core/types.js';
import {
  InMemoryMemoryStore,
  JsonFileMemoryStore,
  createMemoryStore,
  type MemoryStore,
} from '../src/memory/memory-store.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

/**
 * 两个实现必须表现一致：换实现不该让调用方行为漂移（ADR-0004 的承诺）。
 * 所以共用一组用例，只在末尾补各自特有的部分。
 */
function sharedSuite(name: string, make: () => Promise<MemoryStore>): void {
  describe(`${name}（共用行为）`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await make();
    });

    it('按追加顺序读回会话历史', async () => {
      await store.append('s1', user('你好'));
      await store.append('s1', assistant('在的'));

      expect(await store.history('s1')).toEqual([user('你好'), assistant('在的')]);
    });

    it('不存在的会话读到空数组，不报错', async () => {
      expect(await store.history('没有这个会话')).toEqual([]);
    });

    it('limit 取最近若干条，而不是最旧的', async () => {
      for (const text of ['一', '二', '三', '四']) await store.append('s1', user(text));

      expect((await store.history('s1', 2)).map((m) => m.content)).toEqual(['三', '四']);
      expect((await store.history('s1', 99)).map((m) => m.content)).toEqual(['一', '二', '三', '四']);
      expect((await store.history('s1', 0)).map((m) => m.content)).toEqual(['一', '二', '三', '四']);
    });

    it('会话之间互不串味', async () => {
      await store.append('s1', user('甲的'));
      await store.append('s2', user('乙的'));

      expect((await store.history('s1')).map((m) => m.content)).toEqual(['甲的']);
      expect((await store.sessions()).sort()).toEqual(['s1', 's2']);
    });

    it('clear 只清掉指定会话', async () => {
      await store.append('s1', user('甲的'));
      await store.append('s2', user('乙的'));

      await store.clear('s1');

      expect(await store.history('s1')).toEqual([]);
      expect((await store.history('s2')).map((m) => m.content)).toEqual(['乙的']);
      expect(await store.sessions()).toEqual(['s2']);
    });

    it('长期记忆按时间倒序读回', async () => {
      await store.remember('proj', '第一次的做法');
      await store.remember('proj', '第二次的做法');
      await store.remember('proj', '第三次的做法');

      expect(await store.recall('proj')).toEqual(['第三次的做法', '第二次的做法', '第一次的做法']);
    });

    it('长期记忆的 limit 取最近的若干条', async () => {
      for (const text of ['a', 'b', 'c', 'd']) await store.remember('proj', text);

      expect(await store.recall('proj', 2)).toEqual(['d', 'c']);
    });

    it('scope 之间互不串味，未知 scope 读到空数组', async () => {
      await store.remember('a', '只属于 a');
      await store.remember('b', '只属于 b');

      expect(await store.recall('a')).toEqual(['只属于 a']);
      expect(await store.recall('b')).toEqual(['只属于 b']);
      expect(await store.recall('c')).toEqual([]);
    });

    it('读回的会话消息是副本，改它不影响存储', async () => {
      await store.append('s1', user('原文'));
      const history = await store.history('s1');
      history[0]!.content = '被改了';

      expect((await store.history('s1'))[0]?.content).toBe('原文');
    });
  });
}

sharedSuite('InMemoryMemoryStore', () => Promise.resolve(new InMemoryMemoryStore()));

async function tempStore(): Promise<JsonFileMemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'joy-memory-'));
  return new JsonFileMemoryStore(dir);
}

sharedSuite('JsonFileMemoryStore', tempStore);

describe('JsonFileMemoryStore（落盘特有）', () => {
  it('新实例能读回上一个实例写下的会话与长期记忆', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-memory-'));
    const first = new JsonFileMemoryStore(dir);
    await first.append('s1', user('上一轮说的话'));
    await first.remember('proj', '一条长期记忆');

    const second = new JsonFileMemoryStore(dir);

    expect((await second.history('s1')).map((m) => m.content)).toEqual(['上一轮说的话']);
    expect(await second.recall('proj')).toEqual(['一条长期记忆']);
    expect(await second.sessions()).toEqual(['s1']);
  });

  it('并发写不互相覆盖（读-改-写被串行化）', async () => {
    const store = await tempStore();

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => store.append('s1', user(`第 ${index} 条`))),
    );

    const contents = (await store.history('s1')).map((m) => m.content);
    expect(contents).toHaveLength(12);
    expect(new Set(contents).size).toBe(12);
  });

  it('版本不认识的落盘文件报错，不静默当成空历史', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-memory-'));
    const store = new JsonFileMemoryStore(dir);
    await writeFile(store.path, JSON.stringify({ version: 999, sessions: {}, facts: {} }), 'utf8');

    await expect(store.history('s1')).rejects.toThrow(/版本是 999/);
  });

  it('文件不存在时按空仓库处理，且不会提前落盘', async () => {
    const store = await tempStore();

    expect(await store.sessions()).toEqual([]);
    expect(await store.recall('proj')).toEqual([]);
  });

  it('写一个会话后文件真的存在，且没有残留临时文件', async () => {
    const store = await tempStore();
    await store.append('s1', user('落盘'));

    const files = await readdir(dirname(store.path));
    expect(files).toEqual(['memory.json']);
  });
});

describe('createMemoryStore（按配置选实现）', () => {
  it('缺省与 memory 都是内存实现', () => {
    expect(createMemoryStore()).toBeInstanceOf(InMemoryMemoryStore);
    expect(createMemoryStore({ kind: 'memory' })).toBeInstanceOf(InMemoryMemoryStore);
    expect(createMemoryStore({ kind: 'MEMORY' })).toBeInstanceOf(InMemoryMemoryStore);
  });

  it('file 是落盘实现，目录可指定', () => {
    const store = createMemoryStore({ kind: 'file', dir: '/tmp/joy-memory-test' });

    expect(store).toBeInstanceOf(JsonFileMemoryStore);
    expect((store as JsonFileMemoryStore).path).toBe('/tmp/joy-memory-test/memory.json');
  });

  it('不认识的取值直接报错，不悄悄退回内存', () => {
    expect(() => createMemoryStore({ kind: 'redis' })).toThrow(/memory.*file|file.*memory/);
  });
});
