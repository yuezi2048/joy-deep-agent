import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeChatModel, answerTurn } from './helpers/fake-model.js';
import { skillDir, skillDoc } from './helpers/skill-fixture.js';

function loopWith(skills: SkillRegistry, model: FakeChatModel): AgentLoop {
  return new AgentLoop({
    model,
    tools: new ToolRegistry(),
    options: { augmentPrompt: (input) => skills.promptFor(input) },
  });
}

const systemPromptOf = (model: FakeChatModel, turn = 0): string =>
  model.calls[turn]?.messages.find((message) => message.role === 'system')?.content ?? '';

describe('AgentLoop · Skill 注入（ADR-0009）', () => {
  it('没命中就不注入：system prompt 里出现不了一点技能文本', async () => {
    const dir = await skillDir(['weekly', skillDoc('name: weekly-report\ndescription: 整理周报\ntriggers: 周报')]);
    const model = new FakeChatModel([answerTurn('好的')]);

    await loopWith(new SkillRegistry({ dir }), model).run('今天天气不错');

    const system = systemPromptOf(model);
    expect(system).not.toContain('weekly-report');
    expect(system).not.toContain('整理周报');
    expect(system).not.toContain('针对本次任务的技能说明');
  });

  it('命中才注入：带上 name / description / 正文，别的技能一个字都不出现', async () => {
    const dir = await skillDir(
      ['weekly', skillDoc('name: weekly-report\ndescription: 整理周报\ntriggers: 周报', '周报正文：三段式。')],
      ['pdf', skillDoc('name: pdf-report\ndescription: 生成分页报告\ntriggers: PDF', 'PDF 正文：分页。')],
    );
    const model = new FakeChatModel([answerTurn('好的')]);

    await loopWith(new SkillRegistry({ dir }), model).run('帮我写一份周报');

    const system = systemPromptOf(model);
    expect(system).toContain('weekly-report');
    expect(system).toContain('整理周报');
    expect(system).toContain('周报正文：三段式。');
    expect(system).not.toContain('pdf-report');
    expect(system).not.toContain('PDF 正文');
  });

  it('热插拔在同一实例上生效：改完 SKILL.md，下一次 run 的提示词就变了', async () => {
    const dir = await skillDir(['weekly', skillDoc('name: weekly-report\ndescription: 旧说明\ntriggers: 周报')]);
    const registry = new SkillRegistry({ dir });
    const model = new FakeChatModel([answerTurn('一'), answerTurn('二')]);
    const loop = loopWith(registry, model);

    await loop.run('写周报');
    expect(systemPromptOf(model, 0)).toContain('旧说明');

    await writeFile(
      join(dir, 'weekly', 'SKILL.md'),
      skillDoc('name: weekly-report\ndescription: 新说明\ntriggers: 周报'),
      'utf8',
    );

    await loop.run('再写周报');
    expect(systemPromptOf(model, 1)).toContain('新说明');
    expect(systemPromptOf(model, 1)).not.toContain('旧说明');
  });

  it('技能目录不存在、或有文件解析不了，任务照样跑完', async () => {
    const missing = new FakeChatModel([answerTurn('答')]);
    await loopWith(new SkillRegistry({ dir: join(tmpdir(), 'joy-skills-absent') }), missing).run('干活');
    expect(missing.calls[0]?.messages.at(-1)?.content).toBe('干活');

    const dir = await skillDir(['broken', '这不是 frontmatter']);
    const withBroken = new FakeChatModel([answerTurn('答')]);
    const registry = new SkillRegistry({ dir });
    const result = await loopWith(registry, withBroken).run('干活');

    expect(result.content).toBe('答');
    expect((await registry.load()).problems).toHaveLength(1);
  });

  it('技能加载真的炸了（配置/IO 错误）就让任务失败并带上原因，不静默降级', async () => {
    const model = new FakeChatModel([answerTurn('答')]);
    const loop = new AgentLoop({
      model,
      tools: new ToolRegistry(),
      options: {
        augmentPrompt: () => {
          throw new Error('技能目录读不了：EACCES');
        },
      },
    });

    await expect(loop.run('干活')).rejects.toThrow(/EACCES/);
    expect(model.calls).toHaveLength(0);
  });

  it('每轮输入各自算自己的注入，不会把上一轮的技能粘到这一轮', async () => {
    const dir = await skillDir(['weekly', skillDoc('name: weekly-report\ndescription: 整理周报\ntriggers: 周报')]);
    const model = new FakeChatModel([answerTurn('一'), answerTurn('二')]);
    const loop = loopWith(new SkillRegistry({ dir }), model);

    await loop.run('写周报');
    await loop.run('随便聊聊');

    expect(systemPromptOf(model, 0)).toContain('weekly-report');
    expect(systemPromptOf(model, 1)).not.toContain('weekly-report');
  });
});
