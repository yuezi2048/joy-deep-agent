# ADR-0005：MCP 是工具来源，A2A 是子 agent 传输

- 状态：已接受
- 日期：2026-09-30

## 背景

`CONTEXT.md` 的「待定」里挂着「MCP 与 A2A 的接入层次（工具 vs 子 agent）」。原型里两者是分开的 demo：`mcp-demo/` 里客户端手动 `callTool`，`main-agent.ts` 里手写 `fetch` 调 A2A 端点，主循环并不知情。

问题：如果主循环直接感知 MCP 与 A2A 两套协议，它就得认识两种调用语义。

## 决策

压成一种概念——**工具**：

- **MCP → 工具来源**。`MCPToolAdapter` 把远端 MCP server 的每个 tool 转成 `ToolDefinition`，注册进同一个 `ToolRegistry`。主循环看到的和本地工具没有区别。
- **A2A → 子 agent 传输**。远端 agent 以 `delegate` 工具的形式暴露，入参是任务描述，内部走 A2A（Agent Card 发现 + 任务端点）。主循环同样只看到「调用一个工具」。

主循环对协议零感知，协议层的变化不渗进 `core/`。

## 备选方案

- **主循环内建 MCP 客户端与 A2A 客户端**：调用路径短，但主循环同时依赖两个协议 SDK，测试需要起真实 server。
- **子 agent 不走工具，走独立的并行调度器**：多智能体编排（`supervisor` 模式）确实需要独立调度器，但那是**编排层**的事；单个远端 agent 的调用仍然是「一次带副作用的工具调用」，语义一致。

## 后果

- 主循环只依赖 `ToolRegistry` 一个抽象。
- 代价：A2A 的流式与长任务语义（任务 ID、状态轮询、取消）会被压成同步的工具返回值。需要时由 `delegate` 工具内部处理轮询，对主循环仍表现为一次调用。
- MCP 相关代码必须遵守仓库约定：日志走 `console.error`，stdout 归 JSON-RPC 独占。
