import { Body, Controller, Get, Inject, Optional, Post } from '@nestjs/common';
import { AgentService } from './agent.service.js';
import { messageSendResult, parseMessageSend } from '../protocols/index.js';
import { errorMessage } from '../core/errors.js';

/** A2A 服务端选项由 AgentModule 按环境变量注入；不注入时走默认（本地 3000 端口）。 */
export const A2A_SERVER_OPTIONS = Symbol('A2A_SERVER_OPTIONS');

export interface A2AServerOptions {
  /** 对外可见的基地址，用来在名片里声明任务端点。默认 `http://localhost:${PORT ?? 3000}` */
  publicUrl?: string;
  name?: string;
  description?: string;
  version?: string;
}

export function resolveA2AServerOptions(env: NodeJS.ProcessEnv = process.env): A2AServerOptions {
  const options: A2AServerOptions = {};
  if (env.A2A_PUBLIC_URL) options.publicUrl = env.A2A_PUBLIC_URL;
  if (env.A2A_AGENT_NAME) options.name = env.A2A_AGENT_NAME;
  if (env.A2A_AGENT_DESCRIPTION) options.description = env.A2A_AGENT_DESCRIPTION;
  return options;
}

/** JSON-RPC 2.0 标准错误码。协议层只说「哪种错」，翻译成数字是 HTTP 适配层的事。 */
const RPC_CODES = {
  'invalid-request': -32600,
  'method-not-found': -32601,
  'invalid-params': -32602,
  internal: -32000,
} as const;

/**
 * 让 Harness 自己也能被别的 agent 调用（ADR-0005 的另一半）。
 *
 * 名片发布在 A2A 规定的 `/.well-known/agent-card.json`，任务端点挂在 `POST /a2a`，
 * 收到 `message/send` 后转给 `AgentService` 跑主循环，再按 A2A 格式回包。
 * 协议错误一律用 JSON-RPC 错误信封回，而不是 HTTP 500 —— 调用方需要的是结构化原因。
 */
@Controller()
export class A2AController {
  constructor(
    private readonly agent: AgentService,
    @Optional() @Inject(A2A_SERVER_OPTIONS) private readonly options: A2AServerOptions = {},
  ) {}

  @Get('.well-known/agent-card.json')
  agentCard(): Record<string, unknown> {
    const tools = this.agent.info().tools;
    return {
      name: this.options.name ?? 'Joy-Deep-Agent',
      description:
        this.options.description ??
        '通用 Agent 运行时（Harness）：自研 ReAct 主循环 + 工具注册表 + 8 类鲁棒性治理',
      url: `${this.baseUrl()}/a2a`,
      version: this.options.version ?? '0.1.0',
      // 只实现了同步的 message/send；流式没做就不宣称支持，别让调用方按 streaming 来试
      capabilities: { streaming: false },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [
        {
          id: 'task-execution',
          name: '任务执行',
          description: tools.length
            ? `用已注册的工具完成一步任务。当前工具：${tools.join('、')}`
            : '用已注册的工具完成一步任务（当前没有注册任何工具）',
          tags: ['agent', 'react', 'tools'],
          examples: ['算一下 (2+3)*4', '读一下 README.md 并总结'],
        },
      ],
    };
  }

  @Post('a2a')
  async handleTask(@Body() body: unknown): Promise<Record<string, unknown>> {
    const request = parseMessageSend(body);
    if (!request.ok) return rpcError(request.id, RPC_CODES[request.reason], request.message);

    try {
      const result = await this.agent.run(request.task, request.contextId ?? 'a2a');
      return messageSendResult(request.id, result.content);
    } catch (error) {
      return rpcError(request.id, RPC_CODES.internal, `执行失败：${errorMessage(error)}`);
    }
  }

  private baseUrl(): string {
    const fallback = `http://localhost:${process.env.PORT ?? 3000}`;
    return (this.options.publicUrl ?? fallback).replace(/\/+$/, '');
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
