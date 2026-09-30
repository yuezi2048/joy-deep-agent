import type { StopReason } from '../core/agent-loop.js';
import type { Usage } from '../core/types.js';
import type { Plan } from './plan.js';

/** 一步的执行状态。`skipped` 专指「上游没成功，本步没跑」。 */
export type StepStatus = 'succeeded' | 'failed' | 'skipped';

export interface StepResult {
  stepId: string;
  role: string;
  task: string;
  status: StepStatus;
  /** 子智能体的最终文本；failed / skipped 时为空 */
  output: string;
  /** failed / skipped 的原因 */
  detail?: string;
  /** 子智能体为什么停的（步数用尽 / 超时 / 跑完…） */
  stopReason?: StopReason;
  usage: Usage;
  startedAt: number;
  durationMs: number;
}

export interface OrchestrationResult {
  goal: string;
  plan: Plan;
  /** 计划是模型给的还是降级出来的 */
  planSource: 'planned' | 'fallback';
  /** 降级原因或规范化痕迹，如实记录，不藏 */
  planNote?: string;
  steps: StepResult[];
  /** 汇总出来的 Markdown 报告 */
  report: string;
  /** 汇总是否退化成确定性拼接（模型那一步没跑成） */
  synthesisDegraded: boolean;
  /** 落盘的文件路径；没有配输出目录时为空 */
  files: string[];
  /** 规划那一次调用的账 */
  planUsage: Usage;
  /** 各子智能体的账逐项在 `steps[].usage`，这里是它们的合计 */
  subAgentUsage: Usage;
  /** 汇总那一次调用的账 */
  synthesisUsage: Usage;
  /** 上面三者相加的总账 */
  usage: Usage;
  startedAt: number;
  durationMs: number;
}
