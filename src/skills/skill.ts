import { errorMessage } from '../core/errors.js';

/**
 * Skill：按触发条件注入 Prompt 的能力包，一个目录一份 `SKILL.md`。
 *
 * 与原型（`prototypes/deep-agent-demo/src/skill-loader.ts`）的分水岭是**谁来判断触发**：
 * 原型把所有 skill 的 description 全量塞进 system prompt，再靠提示词求模型「输入符合某个技能时请用它」——
 * 判断权在模型，token 还随 skill 数量线性膨胀。这里把判断权收回代码：**命中才注入，没命中一个字符都不注入**。
 *
 * frontmatter 只支持 `key: value` 与 `- item` 两种写法，不引 YAML 依赖：
 * 支持得少但**拼错了会报错**，而不是静默按 YAML 的某条冷门规则解析成别的东西。
 */
export interface Skill {
  /** 稳定标识，会出现在提示词里；全局唯一 */
  name: string;
  /** 一句话说清什么时候用、产出什么 */
  description: string;
  triggers: readonly CompiledTrigger[];
  /** 工作区内的参考资料路径；只注入清单，正文按需 read_file */
  references: readonly string[];
  /** 技能正文（frontmatter 之后的 Markdown） */
  body: string;
  /** 来源，形如 `weekly-report/SKILL.md`，报错与排查用 */
  source: string;
}

export type CompiledTrigger =
  | { kind: 'keyword'; text: string; raw: string }
  | { kind: 'pattern'; regex: RegExp; raw: string };

export interface ParseSkillOptions {
  /** 来源标识，写进错误信息 */
  source: string;
}

export type ParseSkillResult = { ok: true; skill: Skill } | { ok: false; detail: string };

/** frontmatter 认识的字段全集。写别的字段一律报错，不做「静默忽略」。 */
export const SKILL_FIELDS = ['name', 'description', 'triggers', 'references'] as const;

const KNOWN_KEYS = new Set<string>(SKILL_FIELDS);

export function parseSkill(text: string, options: ParseSkillOptions): ParseSkillResult {
  const fail = (detail: string): ParseSkillResult => ({ ok: false, detail: `${options.source}: ${detail}` });
  const lines = text.split(/\r?\n/);

  const start = lines.findIndex((line) => line.trim() === '---');
  if (start === -1) return fail('缺少 frontmatter：文件第一行必须是 ---');
  if (lines.slice(0, start).some((line) => line.trim() !== '')) return fail('frontmatter 之前只能是空行');

  const end = lines.findIndex((line, index) => index > start && line.trim() === '---');
  if (end === -1) return fail('frontmatter 没有结束：缺少第二行 ---');

  const parsed = parseFrontmatter(lines.slice(start + 1, end), start + 2);
  if ('detail' in parsed) return fail(parsed.detail);

  const name = parsed.scalars.get('name') ?? '';
  if (!name) return fail('缺少必填字段 name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return fail(`name "${name}" 只能由字母、数字、点、下划线、连字符组成（它直接出现在提示词里）`);
  }

  const description = parsed.scalars.get('description') ?? '';
  if (!description) return fail('缺少必填字段 description（一句话说清什么时候用、产出什么）');

  const rawTriggers = fieldValues(parsed, 'triggers');
  if (rawTriggers.length === 0) {
    return fail('缺少必填字段 triggers：没有触发条件就永远命不中（至少写一个关键词，或 /正则/）');
  }
  const triggers: CompiledTrigger[] = [];
  for (const raw of rawTriggers) {
    const compiled = compileTrigger(raw);
    if ('detail' in compiled) return fail(compiled.detail);
    triggers.push(compiled.trigger);
  }

  return {
    ok: true,
    skill: {
      name,
      description,
      triggers,
      references: fieldValues(parsed, 'references'),
      body: lines.slice(end + 1).join('\n').trim(),
      source: options.source,
    },
  };
}

/** 这个 skill 是否该被这次输入唤醒。关键词不区分大小写；正则按作者写的来。 */
export function matches(skill: Skill, input: string): boolean {
  const haystack = input.toLowerCase();
  return skill.triggers.some((trigger) =>
    trigger.kind === 'keyword' ? haystack.includes(trigger.text) : trigger.regex.test(input),
  );
}

interface Frontmatter {
  scalars: Map<string, string>;
  lists: Map<string, string[]>;
}

function parseFrontmatter(
  lines: readonly string[],
  firstLineNumber: number,
): { scalars: Map<string, string>; lists: Map<string, string[]> } | { detail: string } {
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let currentList: string | null = null;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const lineNumber = firstLineNumber + index;
    if (line.trim() === '') continue;

    const bullet = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (bullet) {
      if (currentList === null) {
        return { detail: `第 ${lineNumber} 行是列表项，但它上面没有列表字段` };
      }
      const value = unquote(bullet[1]!.trim());
      if (!value) return { detail: `第 ${lineNumber} 行的列表项是空的` };
      lists.get(currentList)!.push(value);
      continue;
    }

    if (/^[ \t]/.test(line)) {
      return { detail: `第 ${lineNumber} 行有缩进但不是列表项：frontmatter 只认 "key: value" 与 "- item"` };
    }

    const entry = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!entry) {
      return { detail: `第 ${lineNumber} 行不是 "key: value" 也不是 "- item"：${line.trim()}` };
    }

    const key = entry[1]!;
    if (!KNOWN_KEYS.has(key)) {
      return { detail: `第 ${lineNumber} 行的字段 "${key}" 不认识；可用：${[...KNOWN_KEYS].join('、')}` };
    }
    if (scalars.has(key) || lists.has(key)) {
      return { detail: `第 ${lineNumber} 行的字段 "${key}" 写了两遍` };
    }

    const value = unquote(entry[2]!.trim());
    if (value) {
      scalars.set(key, value);
      currentList = null;
    } else {
      lists.set(key, []);
      currentList = key;
    }
  }

  return { scalars, lists };
}

/** 标量写法与列表写法都接受：`triggers: 周报` 与 `triggers:\n  - 周报` 等价。 */
function fieldValues(data: Frontmatter, key: string): string[] {
  const list = data.lists.get(key);
  if (list) return list;
  const scalar = data.scalars.get(key);
  return scalar ? [scalar] : [];
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function compileTrigger(raw: string): { trigger: CompiledTrigger } | { detail: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { detail: '触发条件不能是空字符串' };

  // 只有「尾段全是合法 flags」才按正则解析：`/api/v2` 这类首尾都是 `/` 的普通关键词不该被误判成正则
  const pattern = /^\/(.+)\/([dgimsuvy]*)$/.exec(trimmed);
  if (pattern) {
    // g / y 是有状态的：test() 会推进 lastIndex，同一个正则第二次匹配就开始串味
    const flags = pattern[2]!.replace(/[gy]/g, '');
    try {
      return { trigger: { kind: 'pattern', regex: new RegExp(pattern[1]!, flags), raw: trimmed } };
    } catch (error) {
      return { detail: `触发条件 "${trimmed}" 不是合法正则：${errorMessage(error)}` };
    }
  }

  return { trigger: { kind: 'keyword', text: trimmed.toLowerCase(), raw: trimmed } };
}
