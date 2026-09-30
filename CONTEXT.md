# CONTEXT.md

本项目的领域词汇表。一个词只留一个定义；有争议先在这里定清楚，再进代码。

## 运行时

- **Harness** —— 承载 agent 主循环的服务外壳，分编排 / 工具 / 模型 / 持久化四层。
- **AgentLoop** —— 自研 ReAct 循环：模型思考 → 工具调用 → 观察 → 再思考，直到命中终止条件。
- **Planner** —— 任务拆解：把请求拆成可独立推进的子任务。
- **Memory** —— 跨步 / 跨会话状态存储（短期上下文 + 长期记忆）。
- **ToolRegistry** —— 工具注册表：注册、发现、按 schema 校验后调用。
- **Skill** —— 可热插拔的能力包（`SKILL.md` + 资源），运行时加载，不改主循环。
- **VFS 沙箱** —— 受限的虚拟文件系统视图，约束可读写路径。
- **HITL** —— Human-in-the-loop，危险操作前的人工确认。
- **Checkpoint / Resume** —— 中断时落盘的进度点，用于恢复执行。

## 协议

- **MCP** —— Model Context Protocol，把外部工具 / 数据源接进模型上下文。
- **A2A** —— Agent-to-Agent，agent 之间互相调用。

## 鲁棒性：8 类故障

1. 失败调用　2. 幻觉　3. 工具误用　4. 死循环
5. 上下文溢出　6. 供应商故障　7. 用户中断　8. 终端环境异常

每一类对应的具体机制与文件见 `prototypes/agent-robust-strong/README.md`。

## 待定

- Harness 的模块边界与包划分（单包 `src/` 还是 `packages/*`）—— 待 ADR。
- 鲁棒层与主循环的装配方式（装饰器包裹 vs 中间件链）—— 待 ADR。
