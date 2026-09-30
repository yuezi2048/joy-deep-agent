# Joy-Deep-Agent

> 通用 Agent 运行时（Harness）——对标 Codex / Claude Code 的自研主循环，NestJS 服务化 + 8 类鲁棒性治理。

## 这个仓库是什么

把三份独立 demo（协议 / 鲁棒性 / 基础 agent）整合成一个可运行、可扩展的通用 Agent 运行时。

- **目标形态**：NestJS Module/Provider 依赖注入分层（编排 / 工具 / 模型 / 持久化），统一服务与 SSE 流式接口，DeepSeek / OpenAI 零改动切换；自研 ReAct AgentLoop、Planner、Memory 与工具注册表，Skill 热插拔、VFS 沙箱、HITL 确认；接入 MCP / A2A，主 Agent 拆解后由子 Agent 并发汇总。
- **鲁棒性**：失败调用、幻觉、工具误用、死循环、上下文溢出、供应商故障、用户中断、终端环境异常，共 8 类故障的治理层。

## 快速开始

```bash
pnpm install
cp .env.example .env        # 至少填一个供应商的 Key

pnpm test                   # 177 个单测，全部走假模型，不烧 API
pnpm start                  # 起 Harness：http://localhost:3000
pnpm run demo               # 或直接进命令行 REPL
```

```bash
curl localhost:3000/agent/info
curl -N "localhost:3000/agent/stream?input=算一下%20(2%2B3)*4"
```

## 当前状态

| 部分 | 位置 | 状态 |
| --- | --- | --- |
| AgentLoop（自研 ReAct 循环） | `src/core/agent-loop.ts` | **已实现**，含单测 |
| 工具注册表与 schema 校验 | `src/tools/registry.ts` | **已实现**，含单测 |
| 模型供应商抽象（DeepSeek / OpenAI / 通义千问 / Ollama 零改动切换） | `src/providers/` | **已实现**，含单测 |
| 鲁棒性中间件：失败调用 / 工具误用 / 供应商故障 / 终端异常 | `src/robust/`、`src/tools/builtin/` | **已实现**，含单测 |
| 供应商故障转移（熔断 + 按优先级自动切换，对主循环透明） | `src/providers/failover-model.ts` | **已实现**，含单测 |
| 幻觉防护（来源约束 + 交付前自我核查，默认关） | `src/robust/citation-guard.ts`、`src/robust/self-check.ts` | **已实现**，含单测 |
| 工具依赖顺序 + 启动环境预检 | `src/tools/registry.ts`、`src/security/preflight.ts` | **已实现**，含单测 |
| 死循环治理（步数上限 / 无进展指纹 / 横跳检测 / 墙钟上限） | `src/core/agent-loop.ts` | **已实现**，含单测 |
| HITL 高风险操作确认 | `src/core/agent-loop.ts` | **已实现**，含单测 |
| NestJS 服务化 + SSE 流式接口 | `src/nest/`、`src/main.ts` | **已实现**，含单测 |
| 上下文溢出治理（token 估算 / 滑动窗口 / 摘要压缩） | `src/robust/context-manager.ts` | **已实现**，含单测 |
| 用户中断（Checkpoint / Resume） | `src/memory/`、`src/core/agent-loop.ts` | **已实现**，含单测（取消落盘、续跑不重复副作用、原子写） |
| Skill 热插拔、VFS 沙箱 | 待迁（原型 `deep-agent-demo`） | 未开始 |
| MCP / A2A 接入 | 待迁（原型 `agent-protocols`） | 未开始 |
| Planner / Memory | 待建 | 未开始 |
| 故障注入评测（量化收益） | 待建 | **未开始** |
| 协议 / 鲁棒性 / 基础 agent 原型 | `prototypes/` | 已冻结，只读 |

`prototypes/` 是**只读的原始材料**（primary source）：保留现场，新实现从零写，不就地修改原型。

## 目录

```
joy-deep-agent/
├── AGENTS.md            # 给编码 agent 的工作说明
├── CONTEXT.md           # 领域词汇表（持续维护）
├── docs/adr/            # 架构决策记录（已定 5 条）
├── prototypes/          # 冻结的三份原始 demo，只读
└── src/
    ├── core/            # AgentLoop、消息类型、错误分类、异步队列
    ├── providers/       # ChatModel 抽象与 OpenAI 兼容实现、供应商配置
    ├── tools/           # 工具注册表、JSON 容错、内置工具（文件/命令/计算）
    ├── robust/          # 8 类故障的中间件实现
    ├── memory/          # Checkpoint / Memory 持久化接口与实现
    ├── security/        # 路径防护
    ├── nest/            # NestJS 模块、控制器、SSE、运行时装配
    └── cli.ts / main.ts # 两个入口：命令行 REPL 与 HTTP 服务
```

## 环境

- Node.js >= 20
- pnpm >= 10
- 真实 API Key 只放本地 `.env`，**永不提交**；配置模板写成 `.env.example`

## 路线

构建节奏：grill → spec → tickets → implement。术语先落 `CONTEXT.md`，架构决策先落 `docs/adr/`。
