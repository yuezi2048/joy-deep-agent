import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resolveMounts } from '../src/vfs/mount.js';
import { WorkspaceSandbox } from '../src/vfs/sandbox.js';

const tempRoot = () => mkdtemp(join(tmpdir(), 'joy-vfs-'));
const exists = (path: string) => access(path).then(() => true, () => false);

describe('WorkspaceSandbox · 越界判定', () => {
  it('缺省挂载表下工作区内可读可写，并自动建子目录', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root });

    await sandbox.write('a/b/c.md', '你好');
    expect(await sandbox.read('a/b/c.md')).toBe('你好');
    expect(await sandbox.list('a/b')).toEqual([{ name: 'c.md', directory: false }]);
  });

  it('`../` 与根外绝对路径都被拒（读与写都一样）', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root });

    await expect(sandbox.read('../../etc/passwd')).rejects.toThrow(/越界/);
    await expect(sandbox.write('../escape.md', 'x')).rejects.toThrow(/越界/);
    await expect(sandbox.read('/etc/passwd')).rejects.toThrow(/越界/);
  });

  it('前缀相近的目录不算越界：`/root/output-evil` 不是 `/root/output` 的子路径', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root, writeRoot: 'output' });

    // 原型用 startsWith 判定，这一条会漏；这里必须挡住
    await expect(sandbox.write('output-evil/x.md', 'x')).rejects.toThrow(/只读挂载点/);
    await sandbox.write('output/x.md', 'ok');
  });

  it('只读挂载内不能写，但读得到', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'src.md'), '源码', 'utf8');
    const sandbox = new WorkspaceSandbox({ root, writeRoot: 'out' });

    expect(await sandbox.read('src.md')).toBe('源码');
    await expect(sandbox.write('src.md', '改一下')).rejects.toThrow(/只读挂载点/);
  });

  it('最长前缀优先：专门开的口子不会被执行更宽的只读挂载吃掉', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({
      root,
      mounts: [
        { prefix: '.', mode: 'ro' },
        { prefix: '.joy-agent', mode: 'rw' },
      ],
    });

    await sandbox.write('.joy-agent/reports/a.md', '报告');
    await expect(sandbox.write('docs/a.md', 'x')).rejects.toThrow(/只读挂载点/);
  });

  it('挂载点越出工作区、或同一路径挂两次，构造时就报错', () => {
    expect(() => resolveMounts('/workspace', [{ prefix: '../etc', mode: 'rw' }])).toThrow(/越出工作区/);
    expect(() =>
      resolveMounts('/workspace', [
        { prefix: '.joy-agent', mode: 'ro' },
        { prefix: '.joy-agent', mode: 'rw' },
      ]),
    ).toThrow(/配置了两次/);
  });

  it('符号链接指向工作区外时读写都被拒', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, 'secret.txt'), '外面', 'utf8');
    await symlink(outside, join(root, 'link'));

    const sandbox = new WorkspaceSandbox({ root });

    await expect(sandbox.read('link/secret.txt')).rejects.toThrow(/真实位置越出沙箱/);
    await expect(sandbox.write('link/planted.txt', 'x')).rejects.toThrow(/真实位置越出沙箱/);
    expect(await exists(join(outside, 'planted.txt'))).toBe(false);
  });

  it('指向工作区内的符号链接正常放行', async () => {
    const root = await tempRoot();
    await seedFile(root, 'inside.txt', '内容');
    await symlink(join(root, 'inside.txt'), join(root, 'alias.txt'));

    expect(await new WorkspaceSandbox({ root }).read('alias.txt')).toBe('内容');
  });
});

describe('WorkspaceSandbox · 写盘配额与审计', () => {
  it('单文件超限被拒，且磁盘上真的没有这个文件', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root, limits: { maxFileBytes: 8 } });

    await expect(sandbox.write('big.md', 'x'.repeat(9))).rejects.toThrow(/超过单文件上限 8 字节/);
    expect(await exists(join(root, 'big.md'))).toBe(false);
  });

  it('累计字节与文件数超限都被拒，理由写清差多少', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root, limits: { maxTotalBytes: 10, maxFiles: 2 } });

    await sandbox.write('a.md', 'x'.repeat(6));
    await expect(sandbox.write('b.md', 'x'.repeat(6))).rejects.toThrow(/超过累计上限 10 字节/);

    const files = new WorkspaceSandbox({ root, limits: { maxFiles: 2 } });
    await files.write('a.md', 'a');
    await files.write('b.md', 'b');
    await expect(files.write('c.md', 'c')).rejects.toThrow(/超过文件数上限 2/);
  });

  it('文件数按去重后的文件算：覆盖同一个文件不重复占额', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root, limits: { maxFiles: 1 } });

    await sandbox.write('a.md', 'v1', 'call_1');
    await sandbox.write('a.md', 'v2', 'call_2');
    await expect(sandbox.write('b.md', 'x', 'call_3')).rejects.toThrow(/超过文件数上限 1/);

    expect(sandbox.audit().map((record) => record.callId)).toEqual(['call_1', 'call_2']);
  });

  it('配额算的是字节而不是字符', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root, limits: { maxFileBytes: 5 } });

    // 「你好」是 2 个字符、6 个字节
    await expect(sandbox.write('cn.md', '你好')).rejects.toThrow(/6 字节/);
  });

  it('写工作区根目录被拒（那不是一个文件）', async () => {
    const root = await tempRoot();
    await expect(new WorkspaceSandbox({ root }).write('.', 'x')).rejects.toThrow(/文件路径/);
  });

  it('审计记录写清了路径、字节数与命中的挂载点', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({
      root,
      mounts: [
        { prefix: '.', mode: 'ro' },
        { prefix: 'out', mode: 'rw' },
      ],
      now: () => 42,
    });

    await sandbox.write('out/a.md', 'abc');

    expect(sandbox.audit()).toEqual([{ path: 'out/a.md', bytes: 3, at: 42, mount: 'out' }]);
  });

  it('被拒的写入不进审计——审计记的是真的落过盘的东西', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root, limits: { maxFileBytes: 1 } });

    await expect(sandbox.write('big.md', 'xx')).rejects.toThrow();
    expect(sandbox.audit()).toEqual([]);
  });

  it('覆盖写会再记一条（每次写都是独立的一次副作用）', async () => {
    const root = await tempRoot();
    const sandbox = new WorkspaceSandbox({ root });

    await sandbox.write('a.md', 'v1');
    await sandbox.write('a.md', 'v2');

    expect(sandbox.audit().map((record) => record.bytes)).toEqual([2, 2]);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('v2');
  });
});

async function seedFile(root: string, path: string, content: string): Promise<void> {
  await writeFile(join(root, path), content, 'utf8');
}
