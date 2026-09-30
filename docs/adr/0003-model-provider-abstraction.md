# ADR-0003：模型供应商抽象只做一层 OpenAI 兼容适配器

- 状态：已接受
- 日期：2026-09-30

## 背景

`CONTEXT.md` 的「待定」里挂着「模型供应商抽象的边界（DeepSeek / OpenAI 切换）」。

现状盘点：原型 `provider-config.ts` 配了 DeepSeek / 通义千问 / Ollama，**漏了 OpenAI**；`multi-provider.ts` 走的是 `openai` SDK 换 `baseURL`。而 DeepSeek、OpenAI、通义千问、Ollama 四家都提供 OpenAI 兼容的 `/chat/completions`。

## 决策

定义 `ChatModel` 接口（`chat()` / `chatStream()`），只提供**一个**实现 `OpenAIChatModel`，供应商差异全部落在配置：

```ts
interface ProviderConfig {
  name: string; baseURL: string; apiKey: string; model: string; priority: number;
}
```

默认配置补齐 OpenAI，保留 DeepSeek / 通义千问 / Ollama。多供应商按 priority 排序，配合熔断与故障转移。

不为每家用例写独立适配器；也不引入 LangChain 这类框架来抹平差异（那正是本项目要避免的黑盒）。

## 备选方案

- **每家一个适配器类**：只有供应商 API 不兼容时才值得。当前四家全兼容，属于凭空造接口。
- **直接用 openai SDK，不做抽象**：省一层，但 `AgentLoop` 会直接依赖 SDK 类型，将来接 Anthropic（非 OpenAI 兼容）时改动会渗进主循环。

## 后果

- 「DeepSeek / OpenAI 零改动切换」靠配置实现，可验证：切 `provider` 字段即可，代码零改动。
- 代价：接非 OpenAI 兼容供应商（Claude、Gemini 原生接口）时需新增 `ChatModel` 实现，接口按 `chat`/`chatStream`/`toolCalls` 设计，已预留。
