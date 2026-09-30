/**
 * 命令行 REPL：把 Harness 真正跑起来的最小入口。
 * 用法：cp .env.example .env 填好 Key，然后 `pnpm run demo`。
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AgentLoop } from './core/agent-loop.js';
import { buildProviders, createFailoverModel, formatFailoverEvent } from './providers/index.js';
import { applyDefaultToolMiddleware } from './robust/index.js';
import { createBuiltinTools } from './tools/builtin/index.js';
import { ToolRegistry } from './tools/registry.js';

async function main(): Promise<void> {
  // 多家供应商按 priority 兜底：主供应商挂了自动换下一家，主循环无感
  const model = createFailoverModel(buildProviders(), {
    primaryKey: process.env.AGENT_PROVIDER,
    temperature: Number(process.env.AGENT_TEMPERATURE ?? 0.3),
    maxTokens: Number(process.env.AGENT_MAX_TOKENS ?? 4096),
    failover: {
      onEvent: (event) => {
        const line = formatFailoverEvent(event);
        if (line) console.warn(`⚠️  ${line}`);
      },
    },
  });

  // 整个进程只建这一个 readline：HITL 确认与 REPL 输入共用它。
  // 原型里「双 readline 抢 stdin → 确认后主循环卡死」的根因就出在各自建 rl 上。
  const rl = createInterface({ input, output });

  const tools = new ToolRegistry().registerAll(
    createBuiltinTools({ workspaceRoot: process.cwd() }),
  );
  applyDefaultToolMiddleware(tools, { timeoutMs: 30_000 });

  const loop = new AgentLoop({
    model,
    tools,
    options: {
      maxSteps: 8,
      // 幻觉防护：开了就要求结论标注来源，并在交付前多跑一次核查
      sourceConstraint: { enabled: process.env.AGENT_SOURCE_CONSTRAINT === 'true' },
      selfCheck: { enabled: process.env.AGENT_SELF_CHECK === 'true' },
      confirm: async (call, definition) => {
        const answer = await rl.question(
          `\n⚠️  需要确认：${definition.description}\n   参数：${JSON.stringify(call.arguments)}\n   执行？(y/N) `,
        );
        return answer.trim().toLowerCase() === 'y';
      },
    },
  });

  console.log(`🤖 ${model.name} · ${model.model}`);
  console.log(`🔧 工具：${tools.names().join(', ')}`);
  console.log('输入任务开始，/reset 清空上下文，/exit 退出。\n');

  for (;;) {
    const line = (await rl.question('你：')).trim();
    if (!line) continue;
    if (line === '/exit') break;
    if (line === '/reset') {
      loop.reset();
      console.log('（上下文已清空）\n');
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
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
