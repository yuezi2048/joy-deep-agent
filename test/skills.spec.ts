import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matches, parseSkill } from '../src/skills/skill.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceSandbox } from '../src/vfs/index.js';
import { skillDir, skillDoc } from './helpers/skill-fixture.js';

const parse = (text: string) => parseSkill(text, { source: 'demo/SKILL.md' });

describe('parseSkill（SKILL.md 解析）', () => {
  it('解析出 name / description / triggers / references 与正文', () => {
    const result = parse(
      skillDoc(
        'name: weekly-report\ndescription: 把零散材料整理成周报\ntriggers:\n  - 周报\n  - /weekly/i\nreferences:\n  - templates/report.md',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.name).toBe('weekly-report');
    expect(result.skill.description).toBe('把零散材料整理成周报');
    expect(result.skill.references).toEqual(['templates/report.md']);
    expect(result.skill.body).toContain('先列大纲');
    expect(result.skill.triggers.map((trigger) => trigger.kind)).toEqual(['keyword', 'pattern']);
  });

  it('triggers 的标量写法与列表写法等价，带引号的值会去掉引号', () => {
    const scalar = parse(skillDoc('name: a\ndescription: "带引号的说明"\ntriggers: 周报'));
    expect(scalar.ok).toBe(true);
    if (!scalar.ok) return;
    expect(scalar.skill.description).toBe('带引号的说明');
    expect(scalar.skill.triggers).toHaveLength(1);
  });

  it('各类非法输入都给出可读理由，且不抛异常', () => {
    const cases: Array<[string, RegExp]> = [
      ['没有 frontmatter 的文件', /文件第一行必须是 ---/],
      ['---\nname: a\ndescription: d\ntriggers: t', /缺少第二行 ---/],
      [skillDoc('description: d\ntriggers: t'), /缺少必填字段 name/],
      [skillDoc('name: a\ntriggers: t'), /缺少必填字段 description/],
      [skillDoc('name: a\ndescription: d'), /缺少必填字段 triggers/],
      [skillDoc('name: a\ndescription: d\ntriggers:\n  - ""'), /列表项是空的/],
      [skillDoc('name: a\ndescription: d\ntriggers: /[unclosed/'), /不是合法正则/],
      [skillDoc('name: a\ndescription: d\ntriggers: t\nowner: 我'), /字段 "owner" 不认识/],
      [skillDoc('name: a\nname: b\ndescription: d\ntriggers: t'), /写了两遍/],
      [skillDoc('name: 带空格 的名字\ndescription: d\ntriggers: t'), /只能由字母、数字/],
      [skillDoc('name: a\ndescription: d\ntriggers:\n  nested: value'), /有缩进但不是列表项/],
      [skillDoc('name: a\ndescription: d\ntriggers: x\n@@@'), /不是 "key: value" 也不是 "- item"/],
    ];

    for (const [text, expected] of cases) {
      const result = parse(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.detail).toMatch(expected);
    }
  });

  it('错误信息里带来源与行号，排查不用猜', () => {
    const result = parse(skillDoc('name: a\nnope: 1\ndescription: d\ntriggers: t'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('demo/SKILL.md');
    expect(result.detail).toContain('第 3 行');
  });
});

describe('matches（触发条件）', () => {
  const triggerOf = (frontmatter: string) => {
    const result = parse(skillDoc(frontmatter));
    if (!result.ok) throw new Error(result.detail);
    return result.skill;
  };

  it('关键词不区分大小写，未命中就是 false', () => {
    const skill = triggerOf('name: a\ndescription: d\ntriggers: WeeklyReport');

    expect(matches(skill, '帮我写一份 weeklyreport')).toBe(true);
    expect(matches(skill, '帮我写一份 WeeklyReport')).toBe(true);
    expect(matches(skill, '帮我写一份周报')).toBe(false);
  });

  it('支持正则，且写成 /x/g 也不会因为 lastIndex 串味', () => {
    const skill = triggerOf('name: a\ndescription: d\ntriggers: /周\\s*报/g');

    expect(matches(skill, '写个周 报')).toBe(true);
    expect(matches(skill, '写个周 报')).toBe(true);
    expect(matches(skill, '写个月报')).toBe(false);
  });

  it('首尾都是斜杠但尾段不是合法 flags 时，按普通关键词处理（/api/v2 不该被当成正则）', () => {
    const skill = triggerOf('name: a\ndescription: d\ntriggers: /api/v2');

    expect(skill.triggers[0]).toMatchObject({ kind: 'keyword', text: '/api/v2' });
    expect(matches(skill, '调一下 /API/V2 接口')).toBe(true);
  });

  it('多条触发条件是「或」的关系', () => {
    const skill = triggerOf('name: a\ndescription: d\ntriggers:\n  - 周报\n  - /retro/i');

    expect(matches(skill, '开个 retro')).toBe(true);
    expect(matches(skill, '随便聊聊')).toBe(false);
  });
});

describe('SkillRegistry（加载、热插拔、注入）', () => {
  it('目录不存在时当成「没有技能」，不是错误', async () => {
    const registry = new SkillRegistry({ dir: join(tmpdir(), 'joy-skills-nope') });
    expect(await registry.load()).toEqual({ skills: [], problems: [] });
    expect(await registry.promptFor('随便')).toBe('');
  });

  it('一个坏文件不影响其他技能加载，坏在哪看得见', async () => {
    const dir = await skillDir(
      ['good', skillDoc('name: good\ndescription: 好技能\ntriggers: 好')],
      ['broken', '这不是 frontmatter'],
    );
    // 没有 SKILL.md 的子目录不是技能包，也不该出现在 problems 里
    await mkdir(join(dir, 'not-a-skill'), { recursive: true });

    const { skills, problems } = await new SkillRegistry({ dir }).load();

    expect(skills.map((skill) => skill.name)).toEqual(['good']);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.source).toBe('broken/SKILL.md');
    expect(problems[0]!.detail).toContain('文件第一行必须是 ---');
  });

  it('重名的技能全部不加载（命中结果不能取决于扫描顺序）', async () => {
    const dir = await skillDir(
      ['one', skillDoc('name: same\ndescription: 一\ntriggers: 大')],
      ['two', skillDoc('name: same\ndescription: 二\ntriggers: 大')],
    );

    const { skills, problems } = await new SkillRegistry({ dir }).load();

    expect(skills).toEqual([]);
    expect(problems.map((problem) => problem.source).sort()).toEqual(['one/SKILL.md', 'two/SKILL.md']);
    expect(problems[0]!.detail).toContain('重名');
  });

  it('热插拔：改完文件不用重启，下一次读取就生效', async () => {
    const dir = await skillDir(['demo', skillDoc('name: demo\ndescription: 旧说明\ntriggers: 旧词')]);
    const registry = new SkillRegistry({ dir });

    expect((await registry.select('旧词')).map((skill) => skill.name)).toEqual(['demo']);
    expect(await registry.select('新词')).toEqual([]);

    await writeFile(
      join(dir, 'demo', 'SKILL.md'),
      skillDoc('name: demo\ndescription: 新说明\ntriggers: 新词'),
      'utf8',
    );

    expect((await registry.select('新词')).map((skill) => skill.name)).toEqual(['demo']);
    expect(await registry.select('旧词')).toEqual([]);
  });

  it('新增技能文件同样不用重启', async () => {
    const dir = await skillDir(['demo', skillDoc('name: demo\ndescription: 说明\ntriggers: 甲')]);
    const registry = new SkillRegistry({ dir });
    expect(await registry.promptFor('乙')).toBe('');

    await mkdir(join(dir, 'second'), { recursive: true });
    await writeFile(join(dir, 'second', 'SKILL.md'), skillDoc('name: second\ndescription: 说明二\ntriggers: 乙'), 'utf8');

    expect(await registry.promptFor('乙')).toContain('second');
  });

  it('命中才注入：没命中的技能一个字都不出现在注入文本里', async () => {
    const dir = await skillDir(
      ['weekly', skillDoc('name: weekly-report\ndescription: 把零散材料整理成周报\ntriggers: 周报', '周报正文：三段式。')],
      ['pdf', skillDoc('name: pdf-report\ndescription: 生成 PDF 风格分页报告\ntriggers: PDF', 'PDF 正文：分页。')],
    );
    const registry = new SkillRegistry({ dir });

    const prompt = await registry.promptFor('帮我写份周报');

    expect(prompt).toContain('weekly-report');
    expect(prompt).toContain('周报正文');
    expect(prompt).not.toContain('pdf-report');
    expect(prompt).not.toContain('PDF 正文');
    expect(await registry.promptFor('聊点别的')).toBe('');
  });

  it('references 只给清单与读法，不把参考资料的内容灌进提示词', async () => {
    const dir = await skillDir([
      'weekly',
      skillDoc('name: weekly-report\ndescription: 说明\ntriggers: 周报\nreferences:\n  - templates/report.md'),
    ]);

    const prompt = await new SkillRegistry({ dir }).promptFor('写周报');

    expect(prompt).toContain('templates/report.md');
    expect(prompt).toContain('read_file');
  });

  it('给了工作区根目录时，references 换算成工作区相对路径（read_file 的坐标系）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joy-skills-root-'));
    const dir = join(root, '.joy-agent', 'skills', 'weekly');
    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      skillDoc('name: weekly-report\ndescription: 说明\ntriggers: 周报\nreferences:\n  - templates/report.md'),
      'utf8',
    );
    await writeFile(join(dir, 'templates', 'report.md'), '模板正文', 'utf8');

    const prompt = await new SkillRegistry({ dir: join(root, '.joy-agent', 'skills'), root }).promptFor(
      '写周报',
    );

    const injected = '.joy-agent/skills/weekly/templates/report.md';
    expect(prompt).toContain(injected);
    // 注入的路径真的能被沙箱读到——两处坐标系一致，「按需 read_file」才不是空话
    expect(await new WorkspaceSandbox({ root }).read(injected)).toBe('模板正文');
  });

  it('单条超上限时截断并标注', async () => {
    const dir = await skillDir([
      'big',
      skillDoc('name: big\ndescription: 说明\ntriggers: 大', '内容'.repeat(2000)),
    ]);

    const prompt = await new SkillRegistry({ dir }).promptFor('大', { maxTokensPerSkill: 60 });

    expect(prompt).toContain('已按 60 token 截断');
    expect(prompt.length).toBeLessThan(1000);
  });

  it('总量超预算时按顺序保留前面的，并如实点名没注入的', async () => {
    const dir = await skillDir(
      ['a', skillDoc('name: alpha\ndescription: 说明\ntriggers: 任务', '甲'.repeat(300))],
      ['b', skillDoc('name: beta\ndescription: 说明\ntriggers: 任务', '乙'.repeat(300))],
    );

    const registry = new SkillRegistry({ dir });
    const prompt = await registry.promptFor('任务', { maxTokens: 120, maxTokensPerSkill: 60 });

    expect(prompt).toContain('### alpha');
    expect(prompt).not.toContain('### beta');
    expect(prompt).not.toContain('乙');
    expect(prompt).toContain('未注入：beta');

    // 预算紧到一条都塞不下时也要如实说，而不是返回空串装作没命中
    const tiny = await registry.promptFor('任务', { maxTokens: 1, maxTokensPerSkill: 60 });
    expect(tiny).toContain('未注入：alpha、beta');
  });
});

describe('仓库自带的示例技能', () => {
  it('examples/skills 能完整加载（README 里照着跑的路径不能是坏的）', async () => {
    const dir = fileURLToPath(new URL('../examples/skills', import.meta.url));

    const { skills, problems } = await new SkillRegistry({ dir }).load();

    expect(problems).toEqual([]);
    expect(skills.map((skill) => skill.name)).toContain('weekly-report');
  });
});
