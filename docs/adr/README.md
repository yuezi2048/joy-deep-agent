# 架构决策记录（ADR）

一条决策一个文件，命名 `NNNN-短标题.md`，内容包含：背景 / 决策 / 备选方案 / 后果。

## 已接受

- [ADR-0001](0001-package-layout.md) 包划分用单包 `src/`
- [ADR-0002](0002-robustness-assembly.md) 鲁棒性层用中间件链装配，不用装饰器包裹
- [ADR-0003](0003-model-provider-abstraction.md) 模型供应商抽象只做一层 OpenAI 兼容适配器
- [ADR-0004](0004-persistence.md) 持久化先定接口，默认内存 + JSON 落盘
- [ADR-0005](0005-mcp-a2a-layer.md) MCP 是工具来源，A2A 是子 agent 传输
- [ADR-0006](0006-protocol-layer-layout.md) 协议适配独立成 `src/protocols/`
- [ADR-0007](0007-orchestrator-layer.md) 多智能体编排独立成 `src/orchestrator/`
