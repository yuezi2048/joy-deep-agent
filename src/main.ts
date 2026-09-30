import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './nest/app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Joy-Deep-Agent Harness 已启动：http://localhost:${port}`);
  console.log(`  自检  GET  /agent/info`);
  console.log(`  执行  POST /agent/run        { "input": "...", "sessionId": "..." }`);
  console.log(`  流式  GET  /agent/stream?input=...`);
}

bootstrap().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
