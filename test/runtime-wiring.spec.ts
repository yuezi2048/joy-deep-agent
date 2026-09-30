import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/runtime.js';
import { skillDoc } from './helpers/skill-fixture.js';

/**
 * 装配层接线：环境变量 → 沙箱与技能。这里不碰模型，只验「配置真的落到了该落的地方」。
 */
const MANAGED = [
  'AGENT_SKILLS_DIR',
  'AGENT_SKILL_TOKENS',
  'AGENT_WRITE_ROOT',
  'AGENT_MAX_FILE_BYTES',
  'AGENT_MAX_TOTAL_BYTES',
  'AGENT_MAX_FILES',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) delete process.env[name];
  process.env.DEEPSEEK_API_KEY = 'test-key-not-used';
});

afterEach(() => {
  for (const name of MANAGED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function workspaceWithSkill(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'joy-runtime-'));
  await mkdir(join(root, 'my-skills', 'weekly'), { recursive: true });
  await writeFile(
    join(root, 'my-skills', 'weekly', 'SKILL.md'),
    skillDoc('name: weekly-report\ndescription: 整理周报\ntriggers: 周报'),
    'utf8',
  );
  return root;
}

describe('createAgentRuntime · 沙箱与技能接线', () => {
  it('缺省不收窄写盘：整个工作区可写（与接沙箱之前一致）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joy-runtime-'));
    const runtime = await createAgentRuntime({ logFailover: false, workspaceRoot: root });

    expect(runtime.sandbox!.mountPoints.map((mount) => [mount.label, mount.mode])).toEqual([['.', 'rw']]);
    await expect(runtime.sandbox!.write('anywhere.md', 'x')).resolves.toMatchObject({ path: 'anywhere.md' });
  });

  it('AGENT_WRITE_ROOT 收窄写盘：只有该子目录可写，别处读得到写不了', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joy-runtime-'));
    await writeFile(join(root, 'readme.md'), '材料', 'utf8');
    process.env.AGENT_WRITE_ROOT = 'out';

    const runtime = await createAgentRuntime({ logFailover: false, workspaceRoot: root });
    const sandbox = runtime.sandbox!;

    expect(sandbox.mountPoints.filter((mount) => mount.mode === 'rw').map((mount) => mount.label)).toEqual(['out']);
    await sandbox.write('out/a.md', 'ok');
    await expect(sandbox.write('readme.md', '改')).rejects.toThrow(/只读挂载点/);
    expect(await sandbox.read('readme.md')).toBe('材料');
  });

  it('写盘配额走环境变量，非法值直接报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joy-runtime-'));
    process.env.AGENT_MAX_FILE_BYTES = '4';

    const runtime = await createAgentRuntime({ logFailover: false, workspaceRoot: root });
    await expect(runtime.sandbox!.write('big.md', '五个字符')).rejects.toThrow(/超过单文件上限 4 字节/);

    process.env.AGENT_MAX_FILE_BYTES = '四';
    await expect(createAgentRuntime({ logFailover: false, workspaceRoot: root })).rejects.toThrow(
      /AGENT_MAX_FILE_BYTES 必须是正整数/,
    );
  });

  it('AGENT_SKILLS_DIR 指到技能目录，命中触发条件才注入', async () => {
    const root = await workspaceWithSkill();
    process.env.AGENT_SKILLS_DIR = 'my-skills';

    const runtime = await createAgentRuntime({ logFailover: false, workspaceRoot: root });

    expect((await runtime.skills!.load()).skills.map((skill) => skill.name)).toEqual(['weekly-report']);
    expect(await runtime.loopOptions!.augmentPrompt!('帮我写周报')).toContain('weekly-report');
    expect(await runtime.loopOptions!.augmentPrompt!('随便聊聊')).toBe('');
  });

  it('技能目录不存在时装配照常，注入为空串', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joy-runtime-'));
    const runtime = await createAgentRuntime({ logFailover: false, workspaceRoot: root });

    expect((await runtime.skills!.load()).skills).toEqual([]);
    expect(await runtime.loopOptions!.augmentPrompt!('周报')).toBe('');
  });

  it('AGENT_SKILL_TOKENS 控制注入总量', async () => {
    const root = await workspaceWithSkill();
    process.env.AGENT_SKILLS_DIR = 'my-skills';
    process.env.AGENT_SKILL_TOKENS = '1';

    const runtime = await createAgentRuntime({ logFailover: false, workspaceRoot: root });

    // 预算小到塞不下任何一条，也要如实说明没注入谁，而不是装作没命中
    expect(await runtime.loopOptions!.augmentPrompt!('写周报')).toContain('未注入：weekly-report');
  });
});
