/**
 * Demo1：基础 Skill 调用
 * 演示：Skill 加载 → DeepSeek 识别触发条件 → 输出结果
 * 运行命令：npm run demo:basic
 * 不需要 Tavily Key
 */

import "dotenv/config";
import { createDWAgent } from "./agent.js";
import type { AgentResult } from "./agent.js";

// Fallback：AI 没按 <file> 格式写文件，但回复里有代码块时，自动保存
function saveFallback(agent: Awaited<ReturnType<typeof createDWAgent>>, result: AgentResult) {
  if (result.filesWritten.length > 0) return;
  if (!result.content.includes("```")) return;

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  agent.getSandbox()?.writeFile(`output-${timestamp}.md`, result.content);
  console.log(`\n💾 已自动保存到 output/output-${timestamp}.md`);
}

async function main() {
  // 创建并初始化 Agent
  // hitl 关闭，演示时不需要每次确认
  const agent = await createDWAgent({
    name: "大伟 OpenCodex - 基础版",
    skillsDir: ".dw/skills",
    sandbox: {
      workspaceDir: process.cwd(),
      outputDir: "output",
      verbose: true,
    },
    hitl: { enabled: false },
    systemPrompt: "你是一个有趣的 AI 助手，擅长处理古诗词和技术问题。",
  });

  // 打印已加载的 Skill 列表
  console.log("📋 已加载的 Skill：");
  agent.getSkills().forEach((skill) => {
    console.log(`  - ${skill.name}（${skill.fileName}）`);
  });

  // 测试一：输入诗词，验证「唐宋诗词笑话生成器」Skill 触发
  console.log("\n🎭 测试一：诗词笑话生成\n");
  const result1 = await agent.invoke("飞流直下三千尺，疑是银河落九天");
  console.log("\n📝 AI 回复：");
  console.log(result1.content);
  saveFallback(agent, result1);

  // 测试二：另一首诗，验证同一个 Skill 对不同输入的处理
  console.log("\n🎭 测试二：另一首诗\n");
  const result2 = await agent.invoke("举头望明月，低头思故乡");
  console.log("\n📝 AI 回复：");
  console.log(result2.content);
  saveFallback(agent, result2);

  // 测试三：输入代码，验证「代码审查助手」Skill 触发
  console.log("\n🔍 测试三：代码审查\n");
  const result3 = await agent.invoke(`
    帮我审查这段代码：
    const data = await fetch('/api/users')
    const users = data.json()
    console.log(users)
  `);
  console.log("\n📝 AI 回复：");
  console.log(result3.content);
  saveFallback(agent, result3);

  // 展示沙箱状态
  const sandbox = agent.getSandbox();
  if (sandbox) {
    const files = sandbox.listFiles();
    if (files.length > 0) {
      console.log("\n📂 沙箱输出文件：");
      files.forEach((f) => console.log(`  - output/${f}`));
    } else {
      console.log("\n📂 本次演示没有生成文件（AI 没有输出 <file> 块，回复里也没有代码块）");
    }
  }
}

main().catch(console.error);
