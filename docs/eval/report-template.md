# 报告模板

`renderMarkdownReport()` 的输出形状如下（这里用一条示例数据填满，方便对照字段）。
场景库与真实数据见 #8；口径见 `metrics.md`。

---

# 故障注入评测报告

生成时间：2026-09-30T20:00:00+08:00

> 口径见 `docs/eval/metrics.md`：完成率看任务，恢复成功率看故障，
> 恢复时间必须与恢复尝试次数并列读——耗时是退避配置的函数，尝试次数不是。

## 场景清单

| 场景 | 样本量(基线/加固) | 完成率 基线 | 完成率 加固 | Δ(pp) | 恢复成功率 加固 | Δtoken | 缺口 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S-01 供应商 502 后转移 | 5 / 5 | 40% | 100% | +60pp | 100% | +35% | — |
| S-07 用户中断后续跑 | 5 / 0 | 20% | — | — | — | — | 加固侧没有样本：本场景尚未加固 |

## S-01 供应商 502 后转移

| 指标 | 基线 | 加固 | 差值 |
| --- | --- | --- | --- |
| 完成率 | 40%（2/5） | 100%（5/5） | +60pp |
| 恢复成功率 | —（0/0） | 100%（5/5） | — |
| 恢复时间 ms（P50 / max，n） | — | 1500 / 3000（n=5） | — |
| 恢复尝试次数（P50 / max，n） | — | 2 / 3（n=5） | — |
| token 均值（样本数） | 1200（n=5） | 1620（n=5） | +35% |

## S-07 用户中断后续跑

缺口：加固侧没有样本：本场景尚未加固

| 指标 | 基线 | 加固 | 差值 |
| --- | --- | --- | --- |
| 完成率 | 20%（1/5） | —（0/0） | — |
| 恢复成功率 | —（0/0） | —（0/0） | — |
| 恢复时间 ms（P50 / max，n） | — | — | — |
| 恢复尝试次数（P50 / max，n） | — | — | — |
| token 均值（样本数） | 900（n=5） | — | — |

## 说明

- 退避：initialDelayMs=500、backoffFactor=2、maxDelayMs=15000、maxRetries=3（生产值，未调整）
- 模型：deepseek-chat，temperature=0.3，maxSteps=8
- 每场景重复 5 次；基线 = 裸循环（不装中间件、单供应商、无检查点、无幻觉防护）

---

## 机器可读输出

`toJsonReport()` 与表格同源，字段与 `metrics.md` 一一对应：

```json
{
  "meta": {
    "generatedAt": "2026-09-30T20:00:00+08:00",
    "notes": ["退避：initialDelayMs=500、backoffFactor=2、maxDelayMs=15000、maxRetries=3（生产值，未调整）"]
  },
  "scenarios": [
    {
      "scenario": "S-01 供应商 502 后转移",
      "baseline": {
        "runs": 5, "completed": 2, "completionRate": 0.4,
        "faultsInjected": 5, "faultsAbsorbed": 0, "recoveryRate": 0,
        "recoveryMs": null, "recoveryAttempts": null,
        "usageSamples": 5, "totalTokens": 6000, "meanTokens": 1200
      },
      "hardened": {
        "runs": 5, "completed": 5, "completionRate": 1,
        "faultsInjected": 5, "faultsAbsorbed": 5, "recoveryRate": 1,
        "recoveryMs": { "samples": 5, "p50": 1500, "max": 3000 },
        "recoveryAttempts": { "samples": 5, "p50": 2, "max": 3 },
        "usageSamples": 5, "totalTokens": 8100, "meanTokens": 1620
      },
      "delta": { "completionRatePp": 60, "recoveryRatePp": 100, "meanTokensPercent": 35 },
      "gaps": []
    }
  ]
}
```

## 缺口标注位

报告的「缺口」有两处来源，缺一不可：

1. **场景声明**：`summarizeAll(runs, { 'S-07 用户中断后续跑': ['本类未加固：检查点未开启'] })`
   —— 场景作者知道哪一类故障还没做防护，写在这里，原样出现在清单列与场景标题下。
2. **样本缺失**：加固侧样本量为 0 时自动追加「加固侧没有样本：本场景尚未加固」，
   不允许静默省略——没有数据本身就是结论。
