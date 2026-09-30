import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './nest/app.module.js';
import { formatPreflightReport, runPreflight } from './security/preflight.js';
import { DEFAULT_ALLOWED_COMMANDS } from './tools/builtin/index.js';

async function bootstrap(): Promise<void> {
  // 环境问题挡在启动之前：版本不对 / 工作区只读 / 白名单为空，都不该等任务跑到一半才炸
  const preflight = await runPreflight({
    workspaceRoot: process.cwd(),
    allowedCommands: DEFAULT_ALLOWED_COMMANDS,
  });
  console.log(formatPreflightReport(preflight));
  if (!preflight.ok) {
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.create(AppModule);
  // 退出时把协议层拉起的 MCP 子进程收干净（见 AgentService.onApplicationShutdown）
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Joy-Deep-Agent Harness 已启动：http://localhost:${port}`);
  console.log(`  自检  GET  /agent/info`);
  console.log(`  执行  POST /agent/run        { "input": "...", "sessionId": "..." }`);
  console.log(`  流式  GET  /agent/stream?input=...`);
  console.log(`  A2A   GET  /.well-known/agent-card.json   POST /a2a`);
}

bootstrap().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
