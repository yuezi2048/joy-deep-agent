# 通用型智能体健壮性章节 — 完整代码

> 配套《健壮性进阶 1-8》全部章节的可运行代码
> 全程 TypeScript，对标 Codex / Claude Code 的智能体健壮性实现

---

## 八节内容与对应文件

### 第1节 失败调用
- `src/robust/errors.ts` 错误分类 + isRetryable
- `src/robust/timeout.ts` 超时控制
- `src/robust/retry.ts` 指数退避重试
- `src/robust/safe-json.ts` JSON 容错解析
- `src/robust/safe-llm.ts` 带保护的模型调用
- demo: `demo-retry-only` `demo-timeout` `demo-json` `demo-real-fail`

### 第2节 幻觉处理
- `src/robust/tool-validator.ts` 工具参数校验
- `src/robust/grounding.ts` 来源约束
- `src/robust/self-check.ts` 自我核查
- demo: `demo-validator` `demo-grounding` `demo-selfcheck`

### 第3节 工具误用
- `src/robust/tool-tracker.ts` 调用追踪/去重/卡死检测
- `src/robust/tool-budget.ts` 调用预算
- `src/robust/tool-dependency.ts` 依赖顺序
- `src/robust/guarded-executor.ts` 带防护的执行器
- demo: `demo-dedup` `demo-budget` `demo-dependency` `demo-stuck` `demo-tool-misuse`

### 第4节 死循环
- `src/robust/loop-controller.ts` 循环控制器（步数/无进展/横跳检测）
- `src/robust/safe-agent-loop.ts` 带防护的 loop
- `src/robust/task-budget.ts` 任务预算
- demo: `demo-loop-normal` `demo-loop-maxsteps` `demo-loop-noprogress` `demo-loop-alternating` `demo-deadloop`

### 第5节 上下文溢出
- `src/robust/token-counter.ts` token 估算
- `src/robust/sliding-window.ts` 滑动窗口
- `src/robust/compaction.ts` 摘要压缩
- `src/robust/result-truncate.ts` 工具结果截断
- `src/robust/context-manager.ts` 上下文管理器
- demo: `demo-token` `demo-window` `demo-truncate` `demo-compaction` `demo-context`

### 第6节 供应商故障
- `src/robust/provider-config.ts` 供应商配置
- `src/robust/circuit-breaker.ts` 熔断器
- `src/robust/multi-provider.ts` 多供应商管理
- demo: `demo-breaker` `demo-failover` `demo-allfail` `demo-provider`

### 第7节 用户中断
- `src/robust/interrupt-controller.ts` 中断控制器
- `src/robust/checkpoint.ts` 进度检查点
- `src/robust/interruptible-loop.ts` 可中断 loop
- `src/robust/resume.ts` 中断后恢复
- demo: `demo-interrupt` `demo-cleanup` `demo-resume`

### 第8节 终端环境异常
- `src/robust/safe-exec.ts` 安全命令执行
- `src/robust/fs-guard.ts` 文件操作防护
- `src/robust/env-check.ts` 环境预检
- `src/robust/process-manager.ts` 子进程管理
- demo: `demo-envcheck` `demo-exec` `demo-exec-timeout` `demo-fs` `demo-env`

---

## 安装

```bash
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
```

## 运行 demo

每个 demo 都配了 npm 脚本。纯模拟的（不烧 API）可以随便跑：

```bash
# 第1节 失败调用
npm run demo:retry      # 重试 + 指数退避（纯模拟）
npm run demo:timeout    # 超时（纯模拟）
npm run demo:json       # JSON 容错（纯模拟）
npm run demo:real       # 真实调用 + 错误key兜底（调API）

# 第2节 幻觉处理
npm run h:validator     # 工具校验（纯模拟）
npm run h:grounding     # 来源约束（调API）
npm run h:selfcheck     # 自我核查（调API）

# 第3节 工具误用（全纯模拟）
npm run m:dedup         # 去重
npm run m:budget        # 预算
npm run m:dependency    # 依赖顺序
npm run m:stuck         # 卡死检测

# 第4节 死循环（全纯模拟）
npm run d:normal        # 正常完成
npm run d:maxsteps      # 步数上限
npm run d:noprogress    # 无进展检测
npm run d:alternating   # 横跳检测

# 第5节 上下文溢出
npm run c:token         # token估算（纯模拟）
npm run c:window        # 滑动窗口（纯模拟）
npm run c:truncate      # 结果截断（纯模拟）
npm run c:compaction    # 摘要压缩（调API）

# 第6节 供应商故障
npm run p:breaker       # 熔断器（纯模拟）
npm run p:failover      # 故障转移（调API）
npm run p:allfail       # 全挂兜底（错误key，秒失败）

# 第7节 用户中断（全纯模拟）
npm run i:interrupt     # 中断+恢复
npm run i:cleanup       # 资源清理
npm run i:resume        # 检查点恢复

# 第8节 终端环境异常（不调大模型API）
npm run e:env           # 环境预检
npm run e:exec          # 命令执行
npm run e:timeout       # 命令超时
npm run e:fs            # 文件检查
```

---

## 环境要求

- Node.js 18+
- DeepSeek API Key（部分 demo 需要，纯模拟的不需要）

## 注意

- 标"纯模拟"的 demo 不调 API，跑得快不花钱，适合反复演示
- MCP/命令执行相关代码用 spawn + shell:false，避免注入风险
- 各模块设计成可独立使用，也可整合进基础篇的 DWAgent
