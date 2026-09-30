/**
 * 命令行 REPL：把 Harness 真正跑起来的最小入口。
 * 用法：cp .env.example .env 填好 Key，然后 `pnpm run demo`。
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AgentLoop } from './core/agent-loop.js';
import { createAgentRuntime } from './runtime.js';
import { formatPreflightReport, runPreflight } from './security/preflight.js';
import { DEFAULT_ALLOWED_COMMANDS } from './tools/builtin/index.js';

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const preflight = await runPreflight({
    workspaceRoot,
    allowedCommands: DEFAULT_ALLOWED_COMMANDS,
  });
  if (!preflight.ok) {
    console.error(formatPreflightReport(preflight));
    process.exitCode = 1;
    return;
  }

  // 整个进程只建这一个 readline：HITL 确认与 REPL 输入共用它。
  // 原型里「双 readline 抢 stdin → 确认后主循环卡死」的根因就出在各自建 rl 上。
  const rl = createInterface({ input, output });

  // 装配走和其他入口同一条路：供应商兜底、上下文预算、工具中间件、沙箱、技能都在这里接上
  const runtime = await createAgentRuntime({
    workspaceRoot,
    confirm: async (call, definition) => {
      const answer = await rl.question(
        `\n⚠️  需要确认：${definition.description}\n   参数：${JSON.stringify(call.arguments)}\n   执行？(y/N) `,
      );
      return answer.trim().toLowerCase() === 'y';
    },
  });

  const loop = new AgentLoop({
    model: runtime.model,
    tools: runtime.tools,
    options: { ...runtime.loopOptions, maxSteps: 8 },
  });

  console.log(`🤖 ${runtime.model.name} · ${runtime.model.model}`);
  console.log(`🔧 工具：${runtime.tools.names().join(', ')}`);

  const mounts = runtime.sandbox?.mountPoints ?? [];
  if (mounts.length > 0) {
    const writable = runtime.sandbox?.writableMounts() ?? [];
    const label = writable.map((mount) => mount.label).join('、') || '（无）';
    console.log(`🔒 沙箱：可写 ${label}｜只读 ${mounts.length - writable.length} 处`);
  }

  const { skills, problems } = (await runtime.skills?.load()) ?? { skills: [], problems: [] };
  console.log(
    skills.length > 0
      ? `📚 技能 ${skills.length} 个：${skills.map((skill) => skill.name).join('、')}（命中触发条件才注入）`
      : '📚 未加载技能（放 .joy-agent/skills/<名字>/SKILL.md 即可热插拔）',
  );
  for (const problem of problems) {
    console.error(`⚠️  技能 ${problem.source} 没加载：${problem.detail}`);
  }

  console.log('输入任务开始，/reset 清空上下文，/skills 看技能，/exit 退出。\n');

  for (;;) {
    let line: string;
    try {
      line = (await rl.question('你：')).trim();
    } catch {
      // stdin 结束（Ctrl-D 或管道输入跑完）时 readline 会带着挂起的 question 一起关掉。
      // 这不是错误，是「用户不说话了」——当正常退出，别打栈、也别给非零退出码。
      process.stdout.write('\n');
      break;
    }
    if (!line) continue;
    if (line === '/exit') break;
    if (line === '/reset') {
      loop.reset();
      console.log('（上下文已清空）\n');
      continue;
    }
    if (line === '/skills') {
      const { skills: current, problems: currentProblems } = await runtime.skills!.load();
      for (const skill of current) {
        console.log(`- ${skill.name}：${skill.description}`);
      }
      for (const problem of currentProblems) console.log(`- （没加载）${problem.source}：${problem.detail}`);
      console.log('');
      continue;
    }

    for await (const event of loop.runStream(line)) {
      switch (event.type) {
        case 'text':
          process.stdout.write(event.delta);
          break;
        case 'tool_call':
          process.stdout.write(
            `\n🔧 ${event.call.name}(${JSON.stringify(event.call.arguments)})\n`,
          );
          break;
        case 'tool_result':
          process.stdout.write(
            `${event.result.isError ? '⚠️ ' : '📎 '}${event.result.content.slice(0, 300)}\n`,
          );
          break;
        case 'done':
          process.stdout.write(
            `\n[${event.result.stopReason} · ${event.result.steps} 步 · ${event.result.usage.totalTokens ?? 0} tokens]\n\n`,
          );
          break;
        default:
          break;
      }
    }
  }

  rl.close();
  await runtime.close?.();
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
