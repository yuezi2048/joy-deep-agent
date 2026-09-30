import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 拼一份 SKILL.md 文本：frontmatter 与正文分开传，测试里改哪块都清楚。 */
export function skillDoc(frontmatter: string, body = '正文：先列大纲，再写三节。'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** 建一个临时技能目录，每个 `[名字, 内容]` 生成 `<名字>/SKILL.md`。 */
export async function skillDir(...docs: Array<[string, string]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'joy-skills-'));
  for (const [name, content] of docs) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, 'SKILL.md'), content, 'utf8');
  }
  return dir;
}
