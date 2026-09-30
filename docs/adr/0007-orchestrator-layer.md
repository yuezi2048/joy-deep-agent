# ADR-0007：多智能体编排独立成 `src/orchestrator/`

- 状态：已接受
- 日期：2026-09-30

## 背景

简历与 README 都承诺了「主智能体规划与拆解 → 检索 / 分析 / 写作三类子智能体并发 → 主智能体汇总 → 落盘结构化报告」。
ADR-0005 已经声明「多智能体编排（supervisor 模式）需要独立调度器，那是编排层的事」，但没有定它住在哪、依赖谁。

原型 `prototypes/deep-agent-demo/src/demo-multi-agent.ts` 给了反例：角色写死、计划写死、并发靠手写 `Promise.all`、
落盘靠模型输出 `<file>` 标签。三处都是「约定」而不是「结构」，所以它只能演示一次，不能改成别的任务。

同时 `MemoryStore`（ADR-0004）落地后需要一个真实消费方：长期记忆如果没人写、没人读，就只是接口。

## 决策

### 1. 新开一层：`src/orchestrator/`

```
src/orchestrator/
├── role.ts        # AgentRole + 内置检索 / 分析 / 写作三角色
├── plan.ts        # Plan / PlanStep + parsePlan（纯函数，严格校验，不降级）
├── planner.ts     # 调模型产出计划 → 结构化 PlanOutcome
├── sub-agent.ts   # 角色 → 带独立上下文的 SubAgent
├── supervisor.ts  # 分波并发、上游注入、降级、汇总
├── report.ts      # Markdown / JSON 渲染与落盘
└── types.ts
```

依赖方向单向：

- `orchestrator/` → `core/`、`providers/`、`tools/`、`memory/`、`security/`；
- `core/`、`tools/` **不依赖** `orchestrator/` —— 主循环与注册表不认识「角色」「计划」这些概念；
- `protocols/` 也不依赖它：A2A 远端 agent 是**工具**，不是角色（自动注册远端角色留作后续，见 issue #15 非目标）。

装配函数 `createAgentRuntime` 顺势从 `src/nest/runtime.ts` 移到 `src/runtime.ts`：
它一行 NestJS 都不 import，而编排入口（`src/orchestrate.ts`）与 CLI 一样需要它。
入口文件（`cli.ts` / `orchestrate.ts` / `main.ts`）允许依赖任意层，其余文件按上面的方向走。

### 2. 一次任务 = 规划一次 + 分波执行 + 汇总一次

不做「边跑边改计划」的自由循环：谁跑什么、谁等谁，全由计划决定。
好处是行为可复现、时序可断言（并发真的重叠、依赖真的等上游），测试里能验，报告里能解释。
代价是计划错了只能整轮重来——真需要动态改计划时再引入，届时按新 ADR 走。

### 3. 计划用 JSON，解析与降级分开

模型自由书写的分隔符无法自证边界（原型复盘第 1、3 条）。所以：

- 计划是 JSON，抽取复用 `tools/arguments.ts` 的容错阶梯；
- `parsePlan` 只回答「合法吗」，不合法就如实说不合法；
- 「产出不出来怎么办」是 `Supervisor` 的策略：降级成单步计划 + `planSource: 'fallback'` + 原因入 `planNote`；
- `finishReason === 'length'` 单独归类为 `truncated`，不与 `unparseable` / `invalid` 混在一起——
  截断是「模型没写完」，修法（调大 `max_tokens` 或拆小计划）与「模型写歪了」完全不同。

### 4. 子智能体的工具注册表必须新建中间件实例

`AgentRuntime.forkTools(allow?)` 派生注册表时，**中间件是重新构造的**，不是从父注册表共享的。
`AgentLoop.driveInternal` 每次执行开头都会 `this.tools.resetState()`，而 `dedupe` 的缓存、`budget` 的计数
都是中间件实例上的状态。并发子智能体若共用同一批中间件实例，一个子智能体开跑就会清掉另一个正在飞的状态——
症状是「偶发地漏掉去重、预算算少」，极难复现。各持一份是唯一的正确答案。

同理，每个 `SubAgent.run()` 都新建 `AgentLoop`：`messages` 是实例状态，复用实例等于复用上下文，
那就不是子智能体，只是主循环多跑了几轮，「避免长链路上下文溢出」也就无从谈起。

### 5. 内置角色里没有一个能写盘

落盘由编排层单点执行（`report.ts`，经 `PathGuard`）。多个 agent 抢同一个文件是原型踩过的坑：
谁来写、写到哪里、覆盖了谁，全靠约定。写作角色的 `allowedTools` 是空数组，它只产出文字。

## 备选方案

- **写进 `core/agent-loop.ts`**：主循环会因此认识「计划」「角色」，单 agent 场景被迫背上编排的概念与依赖。
- **写进 `nest/`**：编排与「有没有 HTTP 服务」无关，CLI 入口（`src/orchestrate.ts`）也要用。
- **让模型自己写 `<file>` 标签落盘**：边界不可自证，解析失败的表现是「文件被悄悄截断」。
- **第一阶段就做动态重规划**：计划质量还没被验证过，先固定三段式，把可复现性拿到手。

## 后果

- 「完成率」这类指标第一次有了模型侧的消费方：长期记忆由 Supervisor 写、Planner 读，闭环成立。
- 评测与单测可以完全走假模型断言编排时序（并发重叠、依赖等待、降级路径），不联网、不烧 key。
- 代价：多一层目录与一次额外的规划 / 汇总模型调用（token 账在 `OrchestrationResult.usage` 里如实逐项列出）。
- 触发条件：当编排层被第二个入口复用时，按 ADR-0001 的出口规则拆包。
