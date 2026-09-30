# ADR-0004：持久化先定接口，默认内存 + JSON 落盘

- 状态：已接受
- 日期：2026-09-30

## 背景

`CONTEXT.md` 的「待定」里挂着「持久化选型（Memory / Checkpoint 存哪里）」。需要落盘的有两样东西：

- **Checkpoint**：中断时保存的进度点，用于 Resume。原型 `robust/checkpoint.ts` 已经是 JSON 文件实现。
- **Memory**：跨步 / 跨会话的状态，短期是对话上下文，长期是事实与偏好。

当前没有真实数据量，也没有并发写入场景，选型缺少依据。

## 决策

先定接口，实现后置：

```ts
interface CheckpointStore { save(id, state); load(id); list(); }
interface MemoryStore { append(sessionId, msg); history(sessionId, limit); }
```

默认实现两个：`InMemoryStore`（测试与单进程）与 `JsonFileStore`（落盘，沿用原型做法）。两者实现同一接口，用配置切换。

数据库（Postgres / SQLite）留到有明确的跨进程恢复或多实例需求时再引入，届时新增实现而不改调用方。

## 备选方案

- **直接上 Postgres / Redis**：为尚不存在的需求引入部署依赖，且违背仓库「先跑起来再加」的节奏。
- **不抽象，直接写文件**：原型就是这么干的。但 Resume 和 Memory 逻辑会因此绑死文件 IO，测试要碰真实文件系统。

## 后果

- 测试跑内存实现，不碰磁盘；本地长期运行用 JSON 落盘。
- JSON 落盘实现是**原子写**（临时文件 + rename），单进程内不会读到半个文件；代价是没有跨进程并发控制，多进程同时写仍会互相覆盖。单进程假设写进接口注释，多实例场景出现时用数据库实现替换。
