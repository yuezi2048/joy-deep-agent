# ADR-0002：鲁棒性层用中间件链装配，不用装饰器包裹

- 状态：已接受
- 日期：2026-09-30

## 背景

`CONTEXT.md` 的「待定」里挂着「鲁棒层与主循环的装配方式（装饰器包裹 vs 中间件链）」。

原型 `prototypes/agent-robust-strong/src/robust/` 已经把 8 类故障写成了**独立的纯函数**：`withRetry`、`withTimeout`、`CircuitBreaker`、`GuardedExecutor`、`LoopController`、`ContextManager` 等。注意它们全都不是类装饰器，也不依赖宿主类结构。

## 决策

中间件链，洋葱模型：

```ts
type ToolMiddleware = (next: ToolHandler, options) => ToolHandler;
```

工具调用链形如 `retry(timeout(dedupe(budget(validate(execute)))))`。每个中间件对应一类故障，一个文件，可单独测试、按配置增删、按环境切换。

## 备选方案

- **装饰器包裹**：`@WithRetry()` 写在工具类方法上，可读性好。但装饰器在**类定义时**求值，配置只能编译期定死；而重试次数、预算、熔断阈值这些都该来自运行期配置（不同工具不同策略）。此外原型代码是函数式的，改造成装饰器等于重写。
- **写死在 AgentLoop 里**：最省事，但会让主循环重新变成简历里批评的那个「黑盒」——正是这个项目要解决的问题。

## 后果

- 每类故障可独立单测，也方便做故障注入（直接替换链上某一环）。
- 中间件顺序成为显式配置，顺序错会出问题（例如熔断必须在重试外层），需要一份默认顺序常量并在文档里写清。
- AgentLoop 本身只负责「想 → 调 → 看 → 再想」，不掺杂防护逻辑。
