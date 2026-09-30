import { Body, Controller, Get, HttpException, HttpStatus, Post, Query, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { from, map, type Observable } from 'rxjs';
import { AgentService, type RuntimeInfo } from './agent.service.js';
import type { AgentEvent } from '../core/agent-loop.js';

interface RunRequest {
  input?: string;
  sessionId?: string;
}

@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  /** 运行时自检：当前用的是哪家供应商、挂了哪些工具。 */
  @Get('info')
  info(): RuntimeInfo {
    return this.agent.info();
  }

  /** 一次性执行，返回完整结果（含完整 tool call 轨迹）。 */
  @Post('run')
  async run(@Body() body: RunRequest) {
    const input = body?.input?.trim();
    if (!input) {
      throw new HttpException('input 不能为空', HttpStatus.BAD_REQUEST);
    }
    const result = await this.agent.run(input, body?.sessionId ?? 'default');
    return {
      content: result.content,
      stopReason: result.stopReason,
      steps: result.steps,
      toolCalls: result.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
      usage: result.usage,
    };
  }

  /**
   * SSE 流式接口。每个 AgentEvent 作为一个具名事件推送，
   * 前端可用 `source.addEventListener('text', ...)` 逐字渲染。
   *
   * 例：`curl -N "http://localhost:3000/agent/stream?input=算一下%202+3"`
   */
  @Sse('stream')
  stream(
    @Query('input') input?: string,
    @Query('sessionId') sessionId = 'default',
  ): Observable<MessageEvent> {
    const task = input?.trim();
    if (!task) {
      throw new HttpException('input 不能为空', HttpStatus.BAD_REQUEST);
    }
    return from(this.agent.stream(task, sessionId)).pipe(
      map((event: AgentEvent) => ({ type: event.type, data: event }) as MessageEvent),
    );
  }
}
