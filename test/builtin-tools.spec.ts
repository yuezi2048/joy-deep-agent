import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { PathGuard } from '../src/security/path-guard.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createBuiltinTools, evaluateExpression, safeExec } from '../src/tools/builtin/index.js';
import { WorkspaceSandbox } from '../src/vfs/index.js';
import { FakeChatModel, answerTurn, toolTurn } from './helpers/fake-model.js';

const toolCall = (name: string, args: Record<string, unknown>) => ({
  id: 'c1',
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

describe('calculator（不用 eval）', () => {
  it('四则运算与优先级', () => {
    expect(evaluateExpression('2+3*4')).toBe(14);
    expect(evaluateExpression('(2+3)*4')).toBe(20);
    expect(evaluateExpression('10 % 3')).toBe(1);
  });

  it('支持一元负号与小数', () => {
    expect(evaluateExpression('-3 + 1.5')).toBe(-1.5);
    expect(evaluateExpression('2 * -3')).toBe(-6);
  });

  it('除零报错而不是返回 Infinity', () => {
    expect(() => evaluateExpression('1/0')).toThrow(/除数不能为 0/);
  });

  it('拒绝表达式之外的字符——注入不成立', () => {
    expect(() => evaluateExpression('1+1; process.exit(1)')).toThrow(/不支持的字符/);
    expect(() => evaluateExpression('require("fs")')).toThrow(/不支持的字符/);
  });

  it('拒绝多余内容与未闭合括号', () => {
    expect(() => evaluateExpression('1+1 2')).toThrow(/多余内容|无法解析/);
    expect(() => evaluateExpression('(1+1')).toThrow(/括号/);
  });
});

describe('PathGuard（文件防护）', () => {
  it('允许根目录内的路径', () => {
    const guard = new PathGuard('/workspace');
    expect(guard.resolve('notes/a.md')).toBe('/workspace/notes/a.md');
    expect(guard.resolve('.')).toBe('/workspace');
  });

  it('拦截 ../ 越界', () => {
    const guard = new PathGuard('/workspace');
    expect(() => guard.resolve('../secrets.env')).toThrow(/越界/);
    expect(() => guard.resolve('a/../../etc/passwd')).toThrow(/越界/);
  });

  it('拦截根目录外的绝对路径', () => {
    const guard = new PathGuard('/workspace');
    expect(() => guard.resolve('/etc/passwd')).toThrow(/越界/);
  });

  it('前缀相近的目录不算越界（/workspaceX 不是 /workspace 的子路径）', () => {
    const guard = new PathGuard('/workspace');
    expect(guard.isInside('/workspaceX/a')).toBe(false);
  });
});

describe('safeExec（终端环境异常）', () => {
  // 说明：本仓库的沙箱环境捕获不到「嵌套 node 子进程」的 stdout（echo/cat/ls 均正常，
  // 退出码也正常传递），所以涉及输出的用例统一用非 node 命令，避免测到环境怪癖而非代码行为。
  it('正常执行并捕获输出', async () => {
    const result = await safeExec('echo', ['hi']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('退出码如实传递', async () => {
    const result = await safeExec('node', ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
  });

  it('非白名单命令直接拒绝', async () => {
    await expect(safeExec('rm', ['-rf', '/'])).rejects.toThrow(/白名单/);
    await expect(safeExec('sh', ['-c', 'echo hi'])).rejects.toThrow(/白名单/);
  });

  it('带路径分隔符的命令名被拒绝', async () => {
    await expect(safeExec('/bin/ls', [])).rejects.toThrow(/路径分隔符/);
  });

  it('shell 元字符按字面量传递，不构成注入', async () => {
    const result = await safeExec('echo', ['a; rm -rf /tmp/x && echo pwned']);
    expect(result.stdout.trim()).toBe('a; rm -rf /tmp/x && echo pwned');
  });

  it('超时后强制终止并如实标记', async () => {
    const result = await safeExec('node', ['-e', 'setTimeout(() => {}, 5000)'], {
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
  });

  it('输出过长时截断', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'joy-truncate-'));
    const file = join(dir, 'big.txt');
    await writeFile(file, 'x'.repeat(5000), 'utf8');
    try {
      const result = await safeExec('cat', [file], { maxOutputBytes: 100 });
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createBuiltinTools 与注册表集成', () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'joy-agent-test-'));
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('注册五个内置工具，写文件默认需要确认', async () => {
    const tools = createBuiltinTools({ workspaceRoot: workspace });
    const registry = new ToolRegistry().registerAll(tools);

    expect(registry.names().sort()).toEqual([
      'calculator',
      'list_dir',
      'read_file',
      'run_command',
      'write_file',
    ]);

    // 确认判定按参数延迟给：能写才问人，注定失败的写入不打扰人（见 ADR-0008）
    const gate = registry.get('write_file')?.requiresConfirmation;
    expect(typeof gate).toBe('function');
    const ask = gate as (args: Record<string, unknown>) => Promise<boolean>;
    expect(await ask({ path: 'a.md', content: 'x' })).toBe(true);
    expect(await ask({ path: '../escape.md', content: 'x' })).toBe(false);
  });

  it('写文件后能读回来', async () => {
    const registry = new ToolRegistry().registerAll(
      createBuiltinTools({ workspaceRoot: workspace }),
    );

    const written = await registry.execute(toolCall('write_file', { path: 'a/b.md', content: '你好' }));
    expect(written.isError).toBeUndefined();

    const read = await registry.execute(toolCall('read_file', { path: 'a/b.md' }));
    expect(read.content).toBe('你好');
  });

  it('越界路径被拦成可读反馈，不抛穿循环', async () => {
    const registry = new ToolRegistry().registerAll(
      createBuiltinTools({ workspaceRoot: workspace }),
    );

    const result = await registry.execute(toolCall('read_file', { path: '../../etc/passwd' }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('越界');
  });

  it('run_command 拒绝白名单外命令时给出提示', async () => {
    const registry = new ToolRegistry().registerAll(
      createBuiltinTools({ workspaceRoot: workspace }),
    );

    const result = await registry.execute(toolCall('run_command', { command: 'rm', args: ['-rf', '.'] }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('白名单');
  });
});

describe('createBuiltinTools · VFS 沙箱受限写盘（ADR-0008）', () => {
  let workspace: string;
  let outside: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'joy-vfs-tools-'));
    outside = await mkdtemp(join(tmpdir(), 'joy-vfs-outside-'));
    await writeFile(join(workspace, 'readable.md'), '读得到的源码', 'utf8');
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const exists = (path: string) => access(path).then(() => true, () => false);

  it('收窄写盘后：只能写该子目录，工作区其他地方读得到但写不了', async () => {
    const registry = new ToolRegistry().registerAll(
      createBuiltinTools({ sandbox: new WorkspaceSandbox({ root: workspace, writeRoot: 'out' }) }),
    );

    const written = await registry.execute(toolCall('write_file', { path: 'out/a.md', content: '好' }));
    expect(written.isError).toBeUndefined();

    const denied = await registry.execute(toolCall('write_file', { path: 'stray.md', content: 'x' }));
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('只读挂载点');

    const read = await registry.execute(toolCall('read_file', { path: 'readable.md' }));
    expect(read.content).toBe('读得到的源码');
  });

  it('写盘越界被拦成可读反馈，不抛穿循环', async () => {
    const registry = new ToolRegistry().registerAll(
      createBuiltinTools({ sandbox: new WorkspaceSandbox({ root: workspace, writeRoot: 'out' }) }),
    );

    const result = await registry.execute(toolCall('write_file', { path: '../escape.md', content: 'x' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('越界');
  });

  it('配额超限时给出可读理由，且文件真的没有落盘', async () => {
    const registry = new ToolRegistry().registerAll(
      createBuiltinTools({ sandbox: new WorkspaceSandbox({ root: workspace, limits: { maxFileBytes: 4 } }) }),
    );

    const result = await registry.execute(toolCall('write_file', { path: 'big.md', content: '12345' }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('超过单文件上限');
    expect(await exists(join(workspace, 'big.md'))).toBe(false);
  });

  it('符号链接指向工作区外时被拒', async () => {
    await symlink(outside, join(workspace, 'escape-hatch'));
    const registry = new ToolRegistry().registerAll(createBuiltinTools({ workspaceRoot: workspace }));

    const written = await registry.execute(
      toolCall('write_file', { path: 'escape-hatch/planted.md', content: 'x' }),
    );

    expect(written.isError).toBe(true);
    expect(written.content).toContain('真实位置越出沙箱');
    expect(await exists(join(outside, 'planted.md'))).toBe(false);
  });

  it('越界 / 超配额的写入不弹确认，直接把可读拒绝回灌给模型', async () => {
    const confirm = vi.fn(async () => true);
    const denied = new ToolRegistry().registerAll(
      createBuiltinTools({ sandbox: new WorkspaceSandbox({ root: workspace, writeRoot: 'out' }) }),
    );

    const strayModel = new FakeChatModel([
      toolTurn('write_file', { path: 'stray.md', content: 'x' }),
      answerTurn('那我写 out/ 里'),
    ]);
    await new AgentLoop({ model: strayModel, tools: denied, options: { confirm } }).run('写文件');
    expect(confirm).not.toHaveBeenCalled();
    expect(strayModel.calls[1]?.messages.find((m) => m.role === 'tool')?.content).toContain(
      '只读挂载点',
    );

    const overQuota = new ToolRegistry().registerAll(
      createBuiltinTools({ sandbox: new WorkspaceSandbox({ root: workspace, limits: { maxFileBytes: 4 } }) }),
    );
    const bigModel = new FakeChatModel([
      toolTurn('write_file', { path: 'big.md', content: '12345' }),
      answerTurn('收到'),
    ]);
    await new AgentLoop({ model: bigModel, tools: overQuota, options: { confirm } }).run('写文件');
    expect(confirm).not.toHaveBeenCalled();
    expect(bigModel.calls[1]?.messages.find((m) => m.role === 'tool')?.content).toContain(
      '超过单文件上限',
    );
  });

  it('能写成的写入仍然走确认：确认钩子点头才落盘，审计带上触发调用 id', async () => {
    const confirm = vi.fn(async () => true);
    const sandbox = new WorkspaceSandbox({ root: workspace, writeRoot: 'out' });
    const registry = new ToolRegistry().registerAll(createBuiltinTools({ sandbox }));
    const model = new FakeChatModel([
      toolTurn('write_file', { path: 'out/ok.md', content: '好' }),
      toolTurn('write_file', { path: 'out/again.md', content: '再来' }, 'call_2'),
      answerTurn('写完了'),
    ]);

    await new AgentLoop({ model, tools: registry, options: { confirm } }).run('连写两个文件');

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await exists(join(workspace, 'out/ok.md'))).toBe(true);
    const audited = sandbox.audit().map((record) => record.callId ?? '');
    expect(audited[0]).toContain('call_1');
    expect(audited[1]).toContain('call_2');
  });

  it('write_file 的返回写的是字节数，不是字符数', async () => {
    const registry = new ToolRegistry().registerAll(createBuiltinTools({ workspaceRoot: workspace }));

    const result = await registry.execute(toolCall('write_file', { path: 'cn.md', content: '你好' }));

    expect(result.content).toBe('已写入 cn.md（6 字节）');
  });
});
