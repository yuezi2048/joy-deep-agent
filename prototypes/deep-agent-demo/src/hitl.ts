// human in the loop
// 智能体出现高危操作时，主动中断，等待人的确认

import readLine from "readline";

// 高风险操作的关键词
const HIGH_RISK_KEYWORDS = [
  // Shell 危险命令
  "rm -rf",
  "chmod 777",
  "sudo",
  "dd if=",

  // SQL 危险操作
  "drop table",
  "drop database",
  "delete from",
  "truncate table",

  // 中文危险指令
  "删除所有",
  "清空数据库",
  "格式化",
  "删库",
  "强制删除",
];

export type HitlPrompt = (question: string) => Promise<string>;

export interface HitlConfig {
  // 是否开启 HITL 默认true
  enabled?: boolean;
  // 关键词
  extraKeywords?: string[];
  // 自动同意的选项，生产环境不开
  autoApprove?: boolean;
  // 复用宿主程序（如 REPL）的输入接口
  // 默认自己新建 readline，但同一个 stdin 上存在两个 readline 时，
  // 后关闭的那个会把共享的 stdin pause 掉，宿主就再也读不到输入了
  ask?: HitlPrompt;
}

// 检测操作内容是否包含高风险的关键词
export function isHighRiskOperation(
  content: string,
  extraKeywords: string[],
): boolean {
  const keywords = [...HIGH_RISK_KEYWORDS, ...extraKeywords];
  const lower = content.toLowerCase();

  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// 等待用户在终端输入确认
async function waitForUserConfirmation(
  prompt: string,
  ask?: HitlPrompt,
): Promise<boolean> {
  const answer = ask
    ? await ask(prompt)
    : await new Promise<string>((resolve) => {
        const rl = readLine.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(prompt, (input) => {
          rl.close();
          resolve(input);
        });
      });

  const normalizedAnswer = answer.trim().toLowerCase();
  return normalizedAnswer === "y" || normalizedAnswer === "yes";
}

// hitl 检查点：高风险操作前调用，返回是否继续执行
export async function hitlCheckpoint(
  operationDesc: string,
  config: HitlConfig = {},
): Promise<boolean> {
  const {enabled = true, extraKeywords = [], autoApprove = false} = config;

  if (!enabled) {
    return true;
  }

  if (!isHighRiskOperation(operationDesc, extraKeywords)) {
    return true;
  }

  // 高风险操作，触发HITL检查
  // 打印警告信息
  console.log('\n' + '='.repeat(50))
  console.log('⚠️  [HITL] 检测到高风险操作，需要人工确认')
  console.log('='.repeat(50))
  console.log(`操作描述：${operationDesc}`)
  console.log('='.repeat(50))

  if (autoApprove) {
    console.log('[HITL] 自动同意模式，继续执行...\n')
    return true
  }

  const approved = await waitForUserConfirmation(
    '\n请确认是否继续执行？（y/n）',
    config.ask,
  );
  if (approved) {
    console.log('[HITL] 用户同意，继续执行...\n')
  } else {
    console.log('[HITL] 用户拒绝，中断执行...\n')
  }

  return approved;
}
