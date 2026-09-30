import { Body, Controller, Get, HttpException, HttpStatus, Post, Query, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { catchError, from, map, of, type Observable } from 'rxjs';
import { AgentService, type RuntimeInfo } from './agent.service.js';
import type { AgentEvent, AgentRunResult } from '../core/agent-loop.js';
import { errorMessage } from '../core/errors.js';
import { AllProvidersFailedError } from '../providers/index.js';

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
    let result: AgentRunResult;
    try {
      result = await this.agent.run(input, body?.sessionId ?? 'default');
    } catch (error) {
      throw toHttpError(error);
    }
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
      // 失败也要发一条可读的事件再收尾，别让前端只看到连接断掉
      catchError((error: unknown) =>
        of({ type: 'error', data: { message: errorMessage(error) } } as MessageEvent),
      ),
    );
  }
}

/** 供应商全挂是可预期的外部故障，回 503 并带上逐条原因；其余错误也别把信息吞掉。 */
function toHttpError(error: unknown): HttpException {
  if (error instanceof AllProvidersFailedError) {
    return new HttpException(
      { message: error.message, attempts: error.attempts },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  return new HttpException(errorMessage(error), HttpStatus.INTERNAL_SERVER_ERROR);
}
