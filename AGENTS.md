# AGENTS.md

给在本仓库工作的编码 agent 的说明。

## 这是什么

`joy-deep-agent` 是一个通用 Agent 运行时（Harness）。当前处于**从原型整合到产品**的阶段：三份 demo 已冻结在 `prototypes/`，真正的实现尚未开始。

## 硬性约束

- `prototypes/` 下的一切**只读**。它们是冻结的原始材料，要改行为请写新代码，不要就地改原型。
- **绝不提交 `.env`** 或任何真实 API Key。新配置一律先写 `.env.example`。
- 提交前用 `git status` 确认没有 `node_modules/`、`dist/`、`.env` 混进来。

## 流程

- 需求先落到文档再动代码：架构决策进 `docs/adr/`，术语进 `CONTEXT.md`。
- 构建节奏：grill → spec → tickets → implement；每个实现收尾跑 `/code-review`。
- 新增术语先更新 `CONTEXT.md`，不要在代码里造同义词。

## 约定

- 语言 TypeScript（ESM）。
- 命令执行走 `spawn` + `shell:false`；文件操作走受保护的封装（参考原型 `08_terminal`）。
- MCP server 内日志一律 `console.error`（stdout 归 JSON-RPC 独占）。
- 提交信息写清「现象 → 原因 → 改法」。

## Agent skills

### Issue tracker

Issue 与 spec 都作为 GitHub Issue 存放在本仓库（用 `gh` CLI 操作）。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个规范 triage 标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）：根目录 `CONTEXT.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
