/**
 * skill加载器
 * 扫描 .dw/skills 目录，读取所有 .skill.md 文件并解析成结构化数据
 * Agent 启动时调用，把解析结果拼入 System Prompt
 */

import fs from "fs";
import path from "path";

// skill结构
export interface Skill {
  name: string; // 技能名称
  fileName: string; // 文件名
  description: string; // 技能描述
  script: string; // 技能脚本
  examples?: string; // 示例
  references?: string; // 参考文献
  raw?: string; // 原始内容
}

/**
 * 解析单个 .skill.md 文件
 * 按 ## 章节切割，提取各部分内容
 */
export function parseSkill(filePath: string): Skill {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  // 提取技能名称，第一个#标题
  const nameMath = lines.find((l) => l.startsWith("# "));
  // 默认baseName取的是路径-1的名称
  const name = nameMath
    ? nameMath.replace("#", "").trim()
    : path.basename(filePath, ".skill.md");

  // 按照##章节分割
  const sections: Record<string, string> = {};
  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentSection) {
        sections[currentSection] = currentContent.join("\n").trim();
      }
      currentSection = line.replace("## ", "").trim();
    } else if (!line.startsWith("# ")) {
      currentContent.push(line);
    }
  }

  // 保存最后一个章节
  if (currentSection) {
    sections[currentSection] = currentContent.join("\n").trim();
  }

  return {
    name,
    fileName: path.basename(filePath),
    description: sections["Description"] || "",
    script: sections["Script"] || "",
    examples: sections["Examples"],
    references: sections["References"],
    raw,
  };
}

// 加载指定目录下所有.skill.md 文件
// 返回解析的skill数组
export function loadSkills(SkillsDir: string): Skill[] {
  const resolveDir = path.resolve(SkillsDir);
  if (!fs.existsSync(resolveDir)) {
    console.warn(`[skillLoader]技能目录 ${resolveDir} 不存在`);
    return [];
  }

  const files = fs.readdirSync(resolveDir);
  const skillFiles = files.filter((f) => f.endsWith(".skill.md"));

  if (skillFiles.length === 0) {
    console.warn(
      `[skillLoader]技能目录 ${resolveDir} 未找到任何 .skill.md 文件`,
    );
  }

  const skills = skillFiles.map((file) => {
    const filePath = path.join(resolveDir, file);
    const skill = parseSkill(filePath);
    console.log(`[skillLoader]加载技能 ${skill.name} (${file})`);
    return skill;
  });

  return skills;
}

/**
 * 把 Skill 列表格式化成注入 System Prompt 的文字
 * DeepSeek 读到这段文字，就知道什么时候触发哪个 Skill
 */
export function buildSkillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const skillDescriptions = skills
    .map((skill, index) => {
      let desc = `${index + 1}. **${skill.name}**\n触发条件： ${skill.description}`;
      if (skill.examples) {
        const firstExample = skill.examples.split("\n").slice(0, 3).join("\n");
        desc += firstExample;
      }
      return desc;
    })
    .join("\n\n");

  return `
    ## 你具备以下专项技能（Skill）

    ${skillDescriptions}

    当用户的输入符合某个技能的触发条件时，请主动调用该技能的 Script 中的执行逻辑来处理任务。
    如果输入同时符合多个技能，选择最匹配的那个。
  `;
}
