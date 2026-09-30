# Joy-Deep-Agent

> 通用 Agent 运行时（Harness）——对标 Codex / Claude Code 的自研主循环，NestJS 服务化 + 8 类鲁棒性治理。

## 这个仓库是什么

把三份独立 demo（协议 / 鲁棒性 / 基础 agent）整合成一个可运行、可扩展的通用 Agent 运行时。

- **目标形态**：NestJS Module/Provider 依赖注入分层（编排 / 工具 / 模型 / 持久化），统一服务与 SSE 流式接口，DeepSeek / OpenAI 零改动切换；自研 ReAct AgentLoop、Planner、Memory 与工具注册表，Skill 热插拔、VFS 沙箱、HITL 确认；接入 MCP / A2A，主 Agent 拆解后由子 Agent 并发汇总。
- **鲁棒性**：失败调用、幻觉、工具误用、死循环、上下文溢出、供应商故障、用户中断、终端环境异常，共 8 类故障的治理层。

## 当前状态

| 部分 | 位置 | 状态 |
| --- | --- | --- |
| 协议（MCP / A2A / 串联） | `prototypes/agent-protocols/` | 原型已冻结 |
| 鲁棒性 8 类 | `prototypes/agent-robust-strong/` | 原型已冻结 |
| 基础 agent（ReAct / Skill / HITL / 沙箱） | `prototypes/deep-agent-demo/` | 原型已冻结 |
| NestJS 服务化 Harness | 待建 | **未开始** |
| Planner / Memory | 待建 | **未开始** |
| 故障注入评测（量化收益） | 待建 | **未开始** |

`prototypes/` 是**只读的原始材料**（primary source）：保留现场，新实现从零写，不就地修改原型。

## 目录

```
joy-deep-agent/
├── AGENTS.md            # 给编码 agent 的工作说明
├── CONTEXT.md           # 领域词汇表（持续维护）
├── docs/adr/            # 架构决策记录
├── prototypes/          # 冻结的三份原始 demo
└── (待建) src/ 或 packages/
```

## 环境

- Node.js >= 20
- pnpm >= 10
- 真实 API Key 只放本地 `.env`，**永不提交**；配置模板写成 `.env.example`

## 路线

构建节奏：grill → spec → tickets → implement。术语先落 `CONTEXT.md`，架构决策先落 `docs/adr/`。
