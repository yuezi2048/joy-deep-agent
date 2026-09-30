# CONTEXT.md

本项目的领域词汇表。一个词只留一个定义；有争议先在这里定清楚，再进代码。

## 运行时

- **Harness** —— 承载 agent 主循环的服务外壳，分编排 / 工具 / 模型 / 持久化四层。
- **AgentLoop** —— 自研 ReAct 循环：模型思考 → 工具调用 → 观察 → 再思考，直到命中终止条件。
- **Planner** —— 任务拆解：把请求拆成可独立推进的子任务。
- **Memory** —— 跨步 / 跨会话状态存储（短期上下文 + 长期记忆）。
- **ToolRegistry** —— 工具注册表：注册、发现、按 schema 校验后调用。
- **ToolMiddleware** —— 工具调用链上的鲁棒性中间件，形如 `(next) => (call) => Promise<Result>`；8 类故障各对应一条中间件。
- **ChatModel** —— 模型调用抽象（`chat` / `chatStream`），供应商差异由配置承载，不下渗到 AgentLoop。
- **ProviderConfig** —— 单个模型供应商的连接配置（name / baseURL / apiKey / model / priority）。
- **Skill** —— 可热插拔的能力包（`SKILL.md` + 资源），运行时加载，不改主循环。
- **VFS 沙箱** —— 受限的虚拟文件系统视图，约束可读写路径。
- **HITL** —— Human-in-the-loop，危险操作前的人工确认。
- **Checkpoint / Resume** —— 中断时落盘的进度点，用于恢复执行。
- **CheckpointStore / MemoryStore** —— 两者的持久化接口；默认实现为内存与 JSON 落盘。
- **SSE** —— Server-Sent Events，Harness 对外推送流式增量的传输方式。

## 协议

- **MCP** —— Model Context Protocol，把外部工具 / 数据源接进模型上下文。在 Harness 里表现为**工具来源**。
- **A2A** —— Agent-to-Agent，agent 之间互相调用。在 Harness 里表现为**子 agent 传输**，以 `delegate` 工具暴露。

## 鲁棒性：8 类故障

1. 失败调用　2. 幻觉　3. 工具误用　4. 死循环
5. 上下文溢出　6. 供应商故障　7. 用户中断　8. 终端环境异常

每一类对应的具体机制与文件见 `prototypes/agent-robust-strong/README.md`。

## 已定架构决策

见 `docs/adr/`：包划分（ADR-0001）、鲁棒层装配（ADR-0002）、供应商抽象（ADR-0003）、持久化（ADR-0004）、MCP/A2A 接入层次（ADR-0005）。
