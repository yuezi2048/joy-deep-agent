# ADR-0006：协议适配独立成 `src/protocols/`

- 状态：已接受
- 日期：2026-09-30

## 背景

ADR-0005 定了语义：MCP 是工具来源、A2A 是子 agent 传输，两者最终都压成**工具**，主循环对协议零感知。
但 ADR-0001 给出的目录清单里没有协议层的位置：

```
src/{core,providers,tools,robust,memory,nest}
```

摆在面前的是「往哪儿放」：塞进 `tools/` 还是 `nest/`，还是新开一层。

## 决策

新增独立目录 `src/protocols/`，内部再分 `mcp/` 与 `a2a/`：

```
src/protocols/
├── mcp/   # McpConnection 端口、JSON Schema→zod 桥、MCPToolAdapter、官方 SDK 传输
├── a2a/   # A2AAgentClient 端口、HTTP 客户端、delegate 工具
├── wiring.ts   # 按环境变量装配
└── index.ts
```

依赖方向是单向的：

- `protocols/` → `core/types`（`ToolDefinition` 等）与 `tools/`；
- `protocols/` **不依赖** `core/agent-loop` —— 协议层只产出工具，不参与循环；
- `core/` 与 `tools/` **不依赖** `protocols/` —— 主循环与注册表对协议零感知（ADR-0005）。

一条硬纪律：**生产代码里，官方 SDK 的 import 只允许出现在 `protocols/mcp/sdk-connection.ts` 与 `protocols/a2a/http-agent-client.ts` 两个文件里**。
测试不受这条约束：用 SDK 自带的 in-memory transport 起一个真实 server、验证适配器与真实实现的契约，正是这层要守住的东西；禁掉它只会把测试逼成「自己实现一遍假 SDK」。
其余代码只依赖自定的端口（`McpConnection` / `A2AAgentClient`），这样规范与 SDK 迭代时改动面收敛在这两个文件，且测试可以注入假实现。

## 备选方案

- **塞进 `tools/`**：MCP 确实是工具来源，但 A2A 塞进去名不副实；而且 `tools/` 会因此依赖网络与子进程，测试边界被污染。
- **塞进 `nest/`**：协议接入与「是不是有一个 HTTP 服务」无关 —— CLI（`src/cli.ts`）同样要用协议工具。
- **直接写进 `core/`**：违反 ADR-0005 的核心诉求（主循环不该认识协议）。

## 后果

- 协议层可独立测试：假 `McpConnection` / 假 `A2AAgentClient` 就能覆盖适配逻辑，不必起子进程、不必联网。
- 代价：多一层目录；`src/index.ts` 需要多导出一个子模块。
- 触发条件：当协议层被第三个消费方复用时，按 ADR-0001 的出口规则拆包。
