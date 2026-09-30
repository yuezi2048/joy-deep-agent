/**
 * NestJS 启动入口
 * 翻译 Agent 监听 8888 端口
 */

import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  await app.listen(8888)
  console.log('翻译 Agent (A2A / NestJS) 启动：http://localhost:8888')
  console.log('Agent Card：http://localhost:8888/.well-known/agent-card.json')
}

bootstrap()
