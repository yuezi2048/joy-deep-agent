import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { errorMessage } from '../core/errors.js';
import { isWithin } from '../security/path-guard.js';
import { estimateTokens, truncateToolResult } from '../robust/index.js';
import { matches, parseSkill, type Skill } from './skill.js';

/** 加载不出来的东西也要有名字：坏文件不能被静默吞掉。 */
export interface SkillProblem {
  source: string;
  detail: string;
}

export interface LoadedSkills {
  skills: readonly Skill[];
  problems: readonly SkillProblem[];
}

export interface SkillRegistryOptions {
  /** 技能目录；其下每个子目录放一份 `SKILL.md` */
  dir: string;
  /**
   * 工作区根目录。给了它，就把 `SKILL.md` 里「相对技能目录」写的 `references`
   * 换算成**相对工作区**的路径——这正是 `read_file` 的坐标系，模型拿到就能直接读；
   * 不给就原样注入（调用方自己保证路径可用）。
   */
  root?: string;
}

export interface SkillPromptOptions {
  /** 单条技能正文的 token 上限 */
  maxTokensPerSkill?: number;
  /** 本次注入的总 token 上限 */
  maxTokens?: number;
}

const DEFAULTS = {
  maxTokensPerSkill: 400,
  maxTokens: 1200,
} as const;

/**
 * 技能加载器：扫描目录、解析、按输入选命中项、拼成要注入的提示片段。
 *
 * **热插拔**落在 `load()` 的签名缓存上：目录里每个 `SKILL.md` 的（mtime, size）组成签名，
 * 签名没变就用缓存，变了就重读。所以改完文件不用重启进程，下一次 `promptFor` 就生效。
 * 用 size 兜底是因为文件系统的 mtime 精度可能是秒级，同一个测试里改两次文件 mtime 会撞上。
 */
export class SkillRegistry {
  private cache: { signature: string; loaded: LoadedSkills } | null = null;

  constructor(private readonly options: SkillRegistryOptions) {}

  get dir(): string {
    return this.options.dir;
  }

  async load(): Promise<LoadedSkills> {
    const { signature, sources } = await this.signature();
    if (this.cache?.signature === signature) return this.cache.loaded;

    const parsed: Array<{ source: string; skill: Skill }> = [];
    const problems: SkillProblem[] = [];

    for (const source of sources) {
      let text: string;
      try {
        text = await readFile(join(this.options.dir, source), 'utf8');
      } catch (error) {
        problems.push({ source, detail: `读不出来：${errorMessage(error)}` });
        continue;
      }

      const result = parseSkill(text, { source });
      if (result.ok) parsed.push({ source, skill: result.skill });
      else problems.push({ source, detail: result.detail });
    }

    const sourcesByName = new Map<string, string[]>();
    for (const item of parsed) {
      sourcesByName.set(item.skill.name, [...(sourcesByName.get(item.skill.name) ?? []), item.source]);
    }

    const skills: Skill[] = [];
    for (const item of parsed) {
      const duplicates = sourcesByName.get(item.skill.name) ?? [];
      if (duplicates.length > 1) {
        problems.push({
          source: item.source,
          detail:
            `技能名 "${item.skill.name}" 与 ${duplicates.filter((source) => source !== item.source).join('、')} 重名：` +
            '重名会让命中结果取决于扫描顺序，重名的技能全部不加载',
        });
        continue;
      }
      skills.push(item.skill);
    }

    const loaded: LoadedSkills = { skills, problems };
    this.cache = { signature, loaded };
    return loaded;
  }

  /** 命中的技能，顺序按目录名稳定排序。没命中就是空数组——调用方据此决定「一个字都不注入」。 */
  async select(input: string): Promise<Skill[]> {
    const { skills } = await this.load();
    return skills.filter((skill) => matches(skill, input));
  }

  /**
   * 拼本次要注入的提示片段。没命中返回空字符串。
   *
   * 预算是硬的：单条按 `maxTokensPerSkill` 截断（截断了会说明），
   * 总量超过 `maxTokens` 时按顺序保留前面的、如实点名没注入的——不能悄悄把预算花超。
   */
  async promptFor(input: string, options: SkillPromptOptions = {}): Promise<string> {
    const selected = await this.select(input);
    if (selected.length === 0) return '';

    const maxTokensPerSkill = options.maxTokensPerSkill ?? DEFAULTS.maxTokensPerSkill;
    const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;

    const blocks: string[] = [];
    const skipped: string[] = [];
    let used = 0;

    for (const skill of selected) {
      const block = renderSkill(skill, this.referencePaths(skill), maxTokensPerSkill);
      const cost = estimateTokens(block);
      if (used + cost > maxTokens) {
        skipped.push(skill.name);
        continue;
      }
      used += cost;
      blocks.push(block);
    }

    // 命中但一条都塞不下时也要如实说，不能返回空串——那等于宣称「什么都没命中」
    const notes =
      skipped.length > 0
        ? [`（以下技能也命中了，但本次注入预算 ${maxTokens} token 已满，未注入：${skipped.join('、')}）`]
        : [];
    return ['', '## 针对本次任务的技能说明', '', ...blocks, ...notes].join('\n');
  }

  /**
   * `references` 在 `SKILL.md` 里相对**技能目录**写（作者不用关心技能装在哪），
   * 注入给模型的路径换成工作区相对（`read_file` 的坐标系）。落在工作区外就原样给——
   * 读不读得到由沙箱说了算，这里不替它放行。
   */
  private referencePaths(skill: Skill): string[] {
    const root = this.options.root;
    if (!root) return [...skill.references];
    return skill.references.map((reference) => {
      if (isAbsolute(reference)) return reference;
      // 以 `SKILL.md` 所在的目录为基准——frontmatter 的 name 可以和目录名不同，目录名才是真实位置
      const absolute = resolve(this.options.dir, dirname(skill.source), reference);
      return isWithin(root, absolute) ? relative(root, absolute) : reference;
    });
  }

  /** 目录里每个技能的（mtime, size）签名；变了就说明文件被改过。 */
  private async signature(): Promise<{ signature: string; sources: string[] }> {
    let entries;
    try {
      entries = await readdir(this.options.dir, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return { signature: 'absent', sources: [] };
      throw error;
    }

    const parts: string[] = [];
    const sources: string[] = [];
    for (const name of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const source = `${name}/SKILL.md`;
      try {
        const info = await stat(join(this.options.dir, source));
        parts.push(`${source}:${info.mtimeMs}:${info.size}`);
        sources.push(source);
      } catch {
        // 子目录里没有 SKILL.md：它只是个普通目录，不是技能包
      }
    }

    return { signature: parts.join('|'), sources };
  }
}

/** 注入文本的格式由代码固定（边界不让模型自由书写）：标题 + 说明 + 正文 + 参考资料清单。 */
function renderSkill(skill: Skill, references: readonly string[], maxTokensPerSkill: number): string {
  const head = `### ${skill.name}\n${skill.description}`;
  const bounded = truncateToolResult(skill.body ? `${head}\n\n${skill.body}` : head, {
    maxTokens: maxTokensPerSkill,
  });

  const truncation = bounded.truncated
    ? `\n\n（技能正文过长，已按 ${maxTokensPerSkill} token 截断）`
    : '';
  const referenceList =
    references.length > 0
      ? `\n\n参考资料（需要时用 read_file 按需读，不要一次性全读）：${references.join('、')}`
      : '';

  return `${bounded.content}${truncation}${referenceList}`;
}
