import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PathGuard } from '../security/path-guard.js';
import type { OrchestrationResult, StepResult } from './types.js';

/**
 * 报告渲染与落盘。
 *
 * 落盘由**代码**执行，不让模型写 `<file path="...">` 这类自定义标签——
 * 原型复盘第 3 条：边界由模型自由书写时，解析器只能猜，而猜错的表现是「文件被悄悄截断」。
 * 模型只负责给出报告正文，写到哪、叫什么名字、写几个文件，都由这里决定。
 */
export interface WriteReportOptions {
  /** 写盘根目录（相对路径会被解析到 workspaceRoot 下） */
  workspaceRoot: string;
  /** 报告子目录，默认 `.joy-agent/reports` */
  outputDir?: string;
  /** 时间源，测试注入以固定文件名 */
  now?: () => Date;
}

export interface ReportFiles {
  markdown: string;
  json: string;
}

export function renderReportMarkdown(result: OrchestrationResult): string {
  const lines: string[] = [
    `# ${result.goal}`,
    '',
    `- 计划来源：${result.planSource === 'planned' ? '模型规划' : '降级单步'}${result.planNote ? `（${result.planNote}）` : ''}`,
    `- 步骤：${result.steps.filter((step) => step.status === 'succeeded').length}/${result.steps.length} 成功`,
    `- 汇总：${result.synthesisDegraded ? '确定性拼接（模型汇总未跑成）' : '模型汇总'}`,
    `- token：规划 ${result.planUsage.totalTokens ?? 0} · 子智能体 ${
      result.subAgentUsage.totalTokens ?? 0
    } · 汇总 ${result.synthesisUsage.totalTokens ?? 0}（总 ${result.usage.totalTokens ?? 0}）`,
    `- 耗时：${result.durationMs}ms`,
    '',
    result.report.trim(),
    '',
    '---',
    '',
    '## 执行明细',
    '',
  ];

  for (const step of result.steps) {
    lines.push(...renderStep(step), '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderStep(step: StepResult): string[] {
  const head = `### ${step.stepId} · ${step.role} · ${statusLabel(step.status)}（${step.durationMs}ms，${step.usage.totalTokens ?? 0} token）`;
  const lines = [head, '', `> 任务：${collapse(step.task)}`];
  if (step.detail) lines.push('', `> 备注：${collapse(step.detail)}`);
  if (step.stopReason) lines.push(`> 停止原因：${step.stopReason}`);
  if (step.output.trim()) lines.push('', step.output.trim());
  return lines;
}

function statusLabel(status: StepResult['status']): string {
  return status === 'succeeded' ? '成功' : status === 'failed' ? '失败' : '跳过';
}

function collapse(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** 结构化报告：机器读的那份。Markdown 里被折叠的原始输出，这里一份不少。 */
export function renderReportJson(result: OrchestrationResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function writeOrchestrationReport(
  result: OrchestrationResult,
  options: WriteReportOptions,
): Promise<ReportFiles> {
  const guard = new PathGuard(options.workspaceRoot);
  const dir = options.outputDir ?? '.joy-agent/reports';
  const stamp = timestamp(options.now?.() ?? new Date());

  const markdownPath = guard.resolve(`${dir}/report-${stamp}.md`);
  const jsonPath = guard.resolve(`${dir}/report-${stamp}.json`);

  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, renderReportMarkdown(result), 'utf8');
  await writeFile(jsonPath, renderReportJson(result), 'utf8');

  return { markdown: markdownPath, json: jsonPath };
}

/** 文件名用本地时间戳：同一秒跑两次会覆盖，但报告是产物不是状态，可接受（原型也是这么做的）。 */
export function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}
