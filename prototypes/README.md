# Prototypes（冻结的原始材料）

这三份是项目开工前的独立 demo，**只读**，作为 primary source 保留现场，供实现时对照。

| 目录 | 提供什么 | 入口 |
| --- | --- | --- |
| `agent-protocols/` | MCP server/client、A2A（NestJS）、主 agent 串联 | 见各子目录 README |
| `agent-robust-strong/` | 8 类鲁棒性机制；`src/robust/` 教学完整版，`src/my_robust/` 自写分节版（01–08） | `pnpm run <script>` |
| `deep-agent-demo/` | 基础 agent：ReAct、Skill 热插拔、HITL、VFS 沙箱、多智能体 | `pnpm run dev` |

## 运行某个原型

```bash
cd prototypes/<name>
pnpm install
cp .env.example .env   # 填入真实 Key，仅本地，勿提交
```

仓库未携带 `node_modules/`、`dist/`、`.env`。
