// Agent核心模块，基于大模型（兼容OpenAI的DeepSeek）实现通用智能体
// 集成Skill的加载，沙箱的管理，HITL机制，流式输出
import OpenAI from "openai";
import {
  type SandboxConfig,
  SandboxContent,
  createSandbox,
} from "./sandbox.js";
import { type HitlConfig, hitlCheckpoint } from "./hitl.js";
import { type Skill, loadSkills, buildSkillsPrompt } from "./skill-loader.js";

export interface AgentConfig {
  // 智能体的名称
  name: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  skillsDir?: string;
  sandbox?: SandboxConfig;
  hitl?: HitlConfig;
  systemPrompt?: string; // 追加方式
  maxTokens?: number;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentResult {
  content: string;
  messages: AgentMessage[];
  filesWritten: string[];
}

export class DWAgent {
  private client: OpenAI;
  private config: Required<AgentConfig>;
  private skills: Skill[] = [];
  private sandbox: SandboxContent | null = null;
  private hitl: HitlConfig | null = null;
  private conversationHistory: AgentMessage[] = [];

  constructor(config: AgentConfig) {
    this.config = {
      name: config.name,
      baseURL: config.baseURL ?? (process.env.BASE_URL || "https://api.deepseek.com/v1"),
      model: config.model ?? (process.env.DEEPSEEK_MODEL || "deepseek-flash"),
      apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
      temperature:
        config.temperature ?? Number(process.env.DEEPSEEK_TEMPERATURE ?? 0.7),
      skillsDir: config.skillsDir ?? "./dw/skills",
      sandbox: config.sandbox ?? {
        workspaceDir: process.cwd(),
        outputDir: "output",
        verbose: true,
      },
      hitl: config.hitl ?? {
        enabled: true,
        extraKeywords: [],
        autoApprove: false,
      },
      systemPrompt: config.systemPrompt ?? "You are a helpful assistant.",
      maxTokens:
        config.maxTokens ?? Number(process.env.DEEPSEEK_MAX_TOKENS || 8192),
    };
    if (!this.config.apiKey) {
      throw new Error("缺少 DEEPSEEK_API_KEY，请在 .env 文件中配置");
    }

    // Deepseek兼容OpenAI
    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
    });
  }

  // 初始化
  // 加载skill文件，初始化沙箱
  async init(): Promise<void> {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🤖 ${this.config.name} 启动中...`);
    console.log(`${"=".repeat(50)}`);

    console.log("\n📂 [Agent] 正在加载 Skill 文件...");
    this.skills = loadSkills(this.config.skillsDir);
    console.log(`[Agent] 共加载 ${this.skills.length} 个 Skill`);

    console.log("\n🔒 [Agent] 正在初始化沙箱...");
    this.sandbox = createSandbox(this.config.sandbox);

    console.log(`\n✅ [Agent] 初始化完成，模型：${this.config.model}`);
    console.log(`${"=".repeat(50)}\n`);
  }

  // 提示词构建
  private buildSystemPrompt(): string {
    const skillsSection = buildSkillsPrompt(this.skills);
    const sandboxSection = this.sandbox
      ? `\n## 工作区信息\n当前输出路径：${this.sandbox.outputPath}\n所有文件操作都写入此目录。`
      : "";

    return `你是 ${this.config.name}，一个基于 DeepSeek 的通用型 AI 智能体。
    ## 核心能力
    - 理解用户的自然语言目标，自动规划执行步骤
    - 调用相应的 Skill 技能处理专项任务
    - 将结果写入本地文件系统
    ${skillsSection}
    ${sandboxSection}

    ## 行为准则
    - 每次回复说明你正在做什么（Planning → 执行 → 输出）
    - 需要写文件时，使用以下格式（用 file 标签，禁止用 \`\`\` 围栏包裹文件内容）：
    <file path="文件名.md">
    文件完整内容，内容里可以自由包含 \`\`\` 代码块，原样输出即可
    </file>
    - 用户要求代码审查、技术文档、调研报告这类可交付成果时，必须用上面的格式写入文件并在文件里写全内容，
      不要反问用户“是否需要保存”，也不要只把全文贴在聊天里
    - 只是口头问答、代码解释或中间分析结论，直接用文字回答即可，不必写文件
    - 如果超出能力范围，直接回复“抱歉，我无法完成这个请求。”
    - 使用中文回复

    ${this.config.systemPrompt}`;
  }

  // 普通调用（非流式）
  async invoke(userMessage: string): Promise<AgentResult> {
    const approved = await hitlCheckpoint(userMessage, this.config.hitl);
    if (!approved) {
      return { content: "操作已被用户取消。", messages: [], filesWritten: [] };
    }
    this.conversationHistory.push({ role: "user", content: userMessage });
    console.log(
      `\n📨 [Agent] 收到任务：${userMessage.slice(0, 80)}${userMessage.length > 80 ? "..." : ""}`,
    );
    console.log("[Agent] 正在思考...\n");

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      messages: [
        { role: "system", content: this.buildSystemPrompt() },
        ...this.conversationHistory.map((m) => ({
          role: (m.role as "user") || "assistant",
          content: m.content,
        })),
      ],
    });

    const assistantContent = response.choices[0].message.content ?? "";
    this.warnIfTruncated(response.choices[0].finish_reason);
    this.conversationHistory.push({
      role: "assistant",
      content: assistantContent,
    });
    const filesWritten = await this.processFileOperations(assistantContent);

    console.log("\n" + "─".repeat(50));
    console.log("🎯 [Agent] 执行完成");
    if (filesWritten.length > 0) {
      console.log(`📄 写入文件：${filesWritten.join(", ")}`);
    }

    return {
      content: assistantContent,
      messages: this.conversationHistory,
      filesWritten,
    };
  }

  // 流式调用
  async invokeStream(userMessage: string): Promise<AgentResult> {
    const approved = await hitlCheckpoint(userMessage, this.config.hitl);
    if (!approved) {
      return { content: "操作已被用户取消。", messages: [], filesWritten: [] };
    }

    this.conversationHistory.push({ role: "user", content: userMessage });

    console.log(
      `\n📨 [Agent] 收到任务：${userMessage.slice(0, 80)}${userMessage.length > 80 ? "..." : ""}`,
    );
    console.log("[Agent] 开始流式输出...\n");
    console.log("\n" + "─".repeat(50));

    let fullContent = "";
    let finishReason: string | null = null;

    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
      messages: [
        { role: "system", content: this.buildSystemPrompt() },
        ...this.conversationHistory.map((m) => ({
          role: (m.role as "user") || "assistant",
          content: m.content,
        })),
      ],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
      if (delta) {
        process.stdout.write(delta);
        fullContent += delta;
      }
    }

    this.warnIfTruncated(finishReason);
    console.log("\n" + "─".repeat(50));
    this.conversationHistory.push({ role: "assistant", content: fullContent });
    const filesWritten = await this.processFileOperations(fullContent);

    console.log("\n" + "🎯 [Agent] 执行完成");
    if (filesWritten.length > 0) {
      console.log(`📄 写入文件：${filesWritten.join(", ")}`);
    }

    return {
      content: fullContent,
      messages: this.conversationHistory,
      filesWritten,
    };
  }

  // 从AI回复中提取要写入的文件块
  // 主协议：<file path="文件名.md"> ... </file>，内容里的 ``` 不会干扰解析
  // 兼容旧协议：```filename:文件名.md ... ```
  private extractFileBlocks(
    content: string,
  ): Array<{ filename: string; body: string }> {
    const blocks: Array<{ filename: string; body: string }> = [];
    let match: RegExpExecArray | null;

    const tagBlockRegex =
      /<file\s+(?:path|name|filename)=["']([^"']+)["']\s*>\s*\n?([\s\S]*?)\n?\s*<\/file>/g;
    while ((match = tagBlockRegex.exec(content)) !== null) {
      blocks.push({ filename: match[1].trim(), body: match[2].trim() });
    }
    if (blocks.length > 0) return blocks.filter((b) => b.filename);

    // 模型漏写 </file> 时的兜底：一直取到回复结束
    const openTagRegex =
      /<file\s+(?:path|name|filename)=["']([^"']+)["']\s*>\s*\n?([\s\S]*)$/g;
    while ((match = openTagRegex.exec(content)) !== null) {
      blocks.push({ filename: match[1].trim(), body: match[2].trim() });
    }
    if (blocks.length > 0) return blocks.filter((b) => b.filename);

    // 旧围栏协议：结束围栏的反引号数量必须不短于开头，否则会被内层 ``` 提前截断
    const fenceBlockRegex =
      /(?:^|\n)(`{3,})(?:filename:|file:)[ \t]*([^\n]*)\n([\s\S]*?)(?:\n\1`*[ \t]*(?=\n|$)|$)/g;
    while ((match = fenceBlockRegex.exec(content)) !== null) {
      if (match[2].trim()) {
        blocks.push({ filename: match[2].trim(), body: match[3].trim() });
      }
    }
    return blocks.filter((b) => b.filename);
  }

  // 解析AI回复的写入指令并落盘
  private async processFileOperations(content: string): Promise<string[]> {
    if (!this.sandbox) return [];
    const filesWritten: string[] = [];

    const blocks = this.extractFileBlocks(content);
    for (const { filename, body } of blocks) {
      const fileContent = body.trim();

      try {
        const approved = await hitlCheckpoint(
          `写入文件：${filename}`,
          this.config.hitl,
        );
        if (approved) {
          const writtenPath = this.sandbox.writeFile(filename, fileContent);
          filesWritten.push(writtenPath);
          console.log(`[Agent] ✅ 已写入：${writtenPath}`);
        }
      } catch (err) {
        console.error(`[Agent] ❌ 写入失败 ${filename}:`, err);
      }
    }
    return filesWritten;
  }

  // 输出达到 max_tokens 上限时给出提示，避免把模型截断误判成解析丢内容
  private warnIfTruncated(finishReason: string | null | undefined): void {
    if (finishReason !== "length") return;
    console.warn(
      `\n⚠️  [Agent] 输出达到 max_tokens=${this.config.maxTokens} 被截断，文件内容可能不完整，可调大 DEEPSEEK_MAX_TOKENS`,
    );
  }

  // 手动在沙箱内写文件
  writeFile(filename: string, content: string): string {
    if (!this.sandbox) {
      throw new Error("沙箱未初始化");
    }
    return this.sandbox.writeFile(filename, content);
  }

  // 获取技能
  getSkills(): Skill[] {
    return this.skills;
  }

  // 获取沙箱
  getSandbox(): SandboxContent | null {
    return this.sandbox;
  }

  // 清空历史对话
  clearHistory(): void {
    this.conversationHistory = [];
    console.log("[Agent] 对话历史已清空");
  }
}

// 工厂函数创建并初始化agent
export async function createDWAgent(config: AgentConfig): Promise<DWAgent> {
  const agent = new DWAgent(config);
  await agent.init();
  return agent;
}
