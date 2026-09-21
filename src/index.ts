/**
 * 主入口：交互式对话模式
 * 支持多轮对话，Agent 持续运行，随时输入任务
 * 运行命令：npm run dev
 */
import dotenv from "dotenv";
dotenv.config();
import readline from "readline";
import { createDWAgent } from "./agent.js";

async function main() {
  // 提前声明，供 HITL 复用同一个 readline，避免两个 readline 抢 stdin
  let ask: (prompt: string) => Promise<string>;

  // 创建并初始化 Agent
  const agent = await createDWAgent({
    name: "大伟 OpenCodex",
    skillsDir: ".dw/skills",
    sandbox: {
      workspaceDir: process.cwd(),
      outputDir: "output",
      verbose: true,
    },
    hitl: {
      enabled: true, // 开启 HITL，生产使用建议保持开启
      autoApprove: false, // 不自动同意，遇到高风险操作手动确认
      ask: (question) => ask(question),
    },
    systemPrompt: `
你是大伟 OpenCodex，一个专业的前端 + AI 全栈智能体，由 DeepSeek 驱动。
你擅长：
- TypeScript / Vue3 / React 前端开发
- LangChain / Deep Agent AI 应用开发
- 代码审查和架构设计建议
- 技术文档生成

回复要求：
- 使用中文回复
- 代码审查、技术文档、分析报告这类产出，必须用 <file path="文件名.md">...</file> 格式写入工作区，不要反问是否需要保存
- 每次先简单说明你打算怎么做，再给出结果
`,
  });

  // 显示启动信息
  console.log("\n🤖 大伟 OpenCodex 已就绪！");
  console.log("─".repeat(50));
  console.log("💡 已加载技能：");
  agent.getSkills().forEach((s) => {
    console.log(`   - ${s.name}`);
  });
  console.log("─".repeat(50));
  console.log("📝 使用说明：");
  console.log("   输入任意任务开始对话");
  console.log("   输入 clear  → 清空对话历史，开始新会话");
  console.log("   输入 files  → 查看已生成的文件列表");
  console.log("   输入 exit   → 退出程序");
  console.log("─".repeat(50));

  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 封装为 Promise，方便 async/await 使用
  ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  // 对话主循环
  while (true) {
    const userInput = await ask("\n你：");
    const trimmed = userInput.trim();

    // 空输入直接跳过，等待下次输入
    if (!trimmed) continue;

    // 退出命令
    if (trimmed.toLowerCase() === "exit") {
      console.log("\n👋 再见！");
      rl.close();
      break;
    }

    // 清空对话历史命令
    if (trimmed.toLowerCase() === "clear") {
      agent.clearHistory();
      console.log("✅ 对话历史已清空，开始新会话");
      continue;
    }

    // 查看已生成文件命令
    if (trimmed.toLowerCase() === "files") {
      const sandbox = agent.getSandbox();
      if (sandbox) {
        const files = sandbox.listFiles();
        if (files.length === 0) {
          console.log("📂 还没有生成任何文件");
        } else {
          console.log("📂 已生成的文件：");
          files.forEach((f) => console.log(`  - output/${f}`));
        }
      }
      continue;
    }

    // 正常对话，流式输出
    process.stdout.write("\n🤖 大伟：\n");
    const result = await agent.invokeStream(trimmed);

    // Fallback：AI 没按 <file> 格式写文件，但回复里有代码块时，自动保存
    if (result.filesWritten.length === 0 && result.content.includes("```")) {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      agent.getSandbox()?.writeFile(`output-${timestamp}.md`, result.content);
      console.log(`\n💾 已自动保存到 output/output-${timestamp}.md`);
    }
  }
}

main().catch(console.error);
