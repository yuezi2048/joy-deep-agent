# Agent 协议实战 Demo：MCP + A2A + 串联

> 边写边讲录课配套代码
> MCP 用官方 SDK，A2A 用 NestJS 实现
> 全程 TypeScript / Node.js

---

## 项目结构

```
agent-protocols-demo/
├── mcp-demo/                    # 第一段：MCP 实操
│   ├── server.ts                # MCP Server（订单工具）
│   ├── client.ts                # MCP Client（手动调用）
│   ├── client-with-llm.ts       # 接大模型，AI 自己决策
│   ├── package.json
│   └── tsconfig.json
│
├── a2a-nestjs/                  # 第二段：A2A 实操（NestJS 版）
│   ├── src/
│   │   ├── main.ts              # NestJS 启动入口
│   │   ├── app.module.ts
│   │   └── translate/
│   │       ├── translate.module.ts
│   │       ├── translate.controller.ts   # Agent Card + 任务端点
│   │       └── translate.service.ts      # 翻译逻辑
│   ├── caller.ts                # A2A 调用方
│   ├── package.json
│   ├── tsconfig.json
│   └── nest-cli.json
│
└── main-demo/                   # 第三段：串联 MCP + A2A
    ├── main-agent.ts            # 主 Agent
    ├── package.json
    └── tsconfig.json
```

---

## 运行顺序

每个子项目独立，先各自 `npm install`。

### 第一段：MCP

```bash
cd mcp-demo
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY

npm run client            # 手动调用工具
npm run client:llm        # 接大模型，AI 自己决策
```

### 第二段：A2A（NestJS）

```bash
cd a2a-nestjs
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY

# 终端1：启动翻译 Agent
npm run start

# 终端2：运行调用方
npm run caller
```

### 第三段：串联

```bash
cd main-demo
npm install
cp .env.example .env

# 先确保 a2a-nestjs 的翻译 Agent 在运行（8888 端口）
# 订单 MCP Server 会被主 Agent 自动拉起
npm run start
```

---

## 环境要求

- Node.js 18+
- DeepSeek API Key（https://platform.deepseek.com/）

---

## 注意事项

1. MCP Server 里日志必须用 `console.error`，不能用 `console.log`，因为 stdout 被 JSON-RPC 协议占用
2. A2A 和串联部分需要多个终端
3. 各子项目的 `.env` 都要配 `DEEPSEEK_API_KEY`
4. MCP SDK 和 A2A 协议都在迭代，如遇 API 变化以当前官方文档为准
