import type {
  ToolCall,
  ToolDefinition,
  ToolHandler,
  ToolMiddleware,
  ToolResult,
  ToolSchema,
} from '../core/types.js';
import { toErrorResult, toToolResult } from '../core/types.js';
import { toJsonSchema } from './json-schema.js';

/**
 * 工具注册表：注册、发现、按 schema 校验后调用。
 *
 * 校验发生在本地，且失败**不抛异常**——返回 isError 结果回灌给模型，
 * 让模型有机会自我修正（对应「幻觉」一类故障的参数校验）。
 * 中间件链在调用时组装，顺序由 `use()` 决定。
 */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly middleware: ToolMiddleware[] = [];

  register(definition: ToolDefinition): this {
    if (this.definitions.has(definition.name)) {
      throw new Error(`工具 "${definition.name}" 已注册，名称必须唯一`);
    }
    this.definitions.set(definition.name, definition);
    return this;
  }

  registerAll(definitions: readonly ToolDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  /** 追加一条中间件。越早追加越靠外层。 */
  use(middleware: ToolMiddleware): this {
    this.middleware.push(middleware);
    return this;
  }

  /**
   * 重置有状态中间件（去重缓存、调用预算等）。每轮任务开始前调用，
   * 避免上一轮的状态泄漏到下一轮。
   */
  resetState(): void {
    for (const middleware of this.middleware) {
      const reset = (middleware as { reset?: () => void }).reset;
      if (typeof reset === 'function') reset.call(middleware);
    }
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  names(): string[] {
    return [...this.definitions.keys()];
  }

  size(): number {
    return this.definitions.size;
  }

  /** 传给模型的工具声明。 */
  schemas(): ToolSchema[] {
    return [...this.definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: toJsonSchema(definition.schema),
    }));
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const definition = this.definitions.get(call.name);
    if (!definition) {
      const available = this.names().join(', ') || '（当前没有可用工具）';
      return toErrorResult(
        `工具 "${call.name}" 不存在。你只能使用以下工具：${available}。请重新选择，不要编造工具名。`,
      );
    }

    const parsed = definition.schema.safeParse(call.arguments);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `参数 "${issue.path.join('.') || '(根)'}"：${issue.message}`)
        .join('；');
      return toErrorResult(
        `调用 "${call.name}" 的参数有问题：${issues}。请修正后重新提供，不要编造参数。`,
      );
    }

    const validated: ToolCall = { ...call, arguments: parsed.data as Record<string, unknown> };
    const chain = this.buildChain(definition);
    try {
      return await chain(validated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toErrorResult(`工具 "${call.name}" 执行失败：${message}`);
    }
  }

  private buildChain(definition: ToolDefinition): ToolHandler {
    const base: ToolHandler = async (call) => {
      const ctx = { callId: call.id };
      return toToolResult(await definition.handler(call.arguments, ctx));
    };
    return this.middleware.reduceRight<ToolHandler>((next, middleware) => middleware(next), base);
  }
}
