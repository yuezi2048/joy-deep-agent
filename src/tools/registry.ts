import type {
  ToolCall,
  ToolContext,
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
  /** 本次任务里成功执行过的工具，用于前置依赖判断；resetState() 会清空 */
  private readonly completed = new Set<string>();

  register(definition: ToolDefinition): this {
    if (this.definitions.has(definition.name)) {
      throw new Error(`工具 "${definition.name}" 已注册，名称必须唯一`);
    }
    this.definitions.set(definition.name, definition);
    try {
      this.assertAcyclic(definition.name);
    } catch (error) {
      // 注册失败不留半个工具在表里
      this.definitions.delete(definition.name);
      throw error;
    }
    return this;
  }

  registerAll(definitions: readonly ToolDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    this.validateDependencies();
    return this;
  }

  /**
   * 校验依赖图：`requires` 指向的工具必须存在。
   * 依赖成环在 `register()` 就会报错（见 assertAcyclic），这里补的是「名字写错 / 漏注册」。
   */
  validateDependencies(): void {
    const dangling: string[] = [];
    for (const definition of this.definitions.values()) {
      for (const required of definition.requires ?? []) {
        if (!this.definitions.has(required)) dangling.push(`${definition.name} → ${required}`);
      }
    }
    if (dangling.length > 0) {
      throw new Error(
        `工具依赖了未注册的工具：${dangling.join('、')}。请先注册被依赖的工具，或修正名称。`,
      );
    }
  }

  /** 记录某个工具已成功执行（供依赖判断）。续跑时由 AgentLoop 用检查点里的记录回填。 */
  markCompleted(name: string): void {
    this.completed.add(name);
  }

  /** 本次任务里已成功执行过的工具名。 */
  completedNames(): string[] {
    return [...this.completed];
  }

  /** 从 `name` 出发做一次深度优先搜索，回到自己就是成环。 */
  private assertAcyclic(start: string): void {
    const path: string[] = [];
    const visit = (name: string): void => {
      const loopAt = path.indexOf(name);
      if (loopAt !== -1) {
        const cycle = [...path.slice(loopAt), name];
        throw new Error(`工具依赖成环：${cycle.join(' → ')}。请拆掉环，否则这批工具永远无法被调用。`);
      }
      const definition = this.definitions.get(name);
      if (!definition?.requires?.length) return;
      path.push(name);
      for (const required of definition.requires) visit(required);
      path.pop();
    };
    visit(start);
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
    this.completed.clear();
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

  /** 传给模型的工具声明。远端工具自带的 `parameters` 优先于由 zod 推导的那份。 */
  schemas(): ToolSchema[] {
    return [...this.definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters ?? toJsonSchema(definition.schema),
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

    // 前置依赖先于参数校验：连该不该调用都没确定，就没必要谈参数对不对
    const missing = (definition.requires ?? []).filter((name) => !this.completed.has(name));
    if (missing.length > 0) {
      const list = missing.map((name) => `"${name}"`).join('、');
      return toErrorResult(
        `调用 "${call.name}" 之前必须先成功调用 ${list}，但本次任务里还没有它们的结果。` +
          `请先调用 ${list} 并拿到结果，再回来调用 "${call.name}"；不要跳过前置步骤。`,
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
    const chain = this.buildChain(definition, signal);
    let result: ToolResult;
    try {
      result = await chain(validated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toErrorResult(`工具 "${call.name}" 执行失败：${message}`);
    }
    // 只有成功才算「前置已满足」：失败的前置不该给后续动作放行
    if (!result.isError) this.completed.add(definition.name);
    return result;
  }

  private buildChain(definition: ToolDefinition, signal?: AbortSignal): ToolHandler {
    const base: ToolHandler = async (call) => {
      // 把取消信号透给工具本体：远端调用（MCP / A2A）与长命令都靠它被墙钟上限掐断
      const ctx: ToolContext = signal ? { callId: call.id, signal } : { callId: call.id };
      return toToolResult(await definition.handler(call.arguments, ctx));
    };
    return this.middleware.reduceRight<ToolHandler>((next, middleware) => middleware(next), base);
  }
}
