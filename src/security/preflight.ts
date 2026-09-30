import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage } from '../core/errors.js';

/**
 * 启动预检（对应「终端环境异常」一类的第一道闸）。
 *
 * 环境问题（Node 版本太老、工作区只读、命令白名单是空的）应该在**任务开始之前**暴露，
 * 而不是等任务跑到一半、模型已经烧了几万 token 才失败。每一项都给可操作的修复提示，
 * 因为「失败」本身没有价值，「知道怎么修」才有。
 */

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** 失败时怎么修；通过时为 undefined */
  hint?: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  workspaceRoot: string;
  allowedCommands: readonly string[];
  /** 最低 Node 版本，默认 20.0.0（与 package.json 的 engines 一致） */
  minNodeVersion?: string;
  /** 注入当前版本，测试用 */
  nodeVersion?: string;
  /** 是否真的往工作区写一个探针文件再删掉（默认写：能读能写才算可写） */
  probeWorkspace?: boolean;
}

export class PreflightError extends Error {
  constructor(public readonly report: PreflightReport) {
    super(formatPreflightReport(report));
    this.name = 'PreflightError';
  }
}

/** 逐段比较版本号，返回负数 / 0 / 正数。 */
export function compareVersions(left: string, right: string): number {
  const toParts = (value: string): number[] =>
    value
      .split('.')
      .map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ''), 10) || 0);
  const a = toParts(left);
  const b = toParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  const required = options.minNodeVersion ?? '20.0.0';
  const current = options.nodeVersion ?? process.versions.node;
  const nodeOk = compareVersions(current, required) >= 0;
  checks.push({
    name: 'runtime',
    ok: nodeOk,
    detail: `Node ${current}（要求 >= ${required}）`,
    ...(nodeOk
      ? {}
      : { hint: `升级 Node 到 ${required} 以上（建议当前 LTS），或用 nvm / fnm 切版本后重试` }),
  });

  const commands = options.allowedCommands.map((command) => command.trim()).filter(Boolean);
  checks.push({
    name: 'commands',
    ok: commands.length > 0,
    detail:
      commands.length > 0
        ? `命令白名单 ${commands.length} 条：${commands.join(', ')}`
        : '命令白名单是空的',
    ...(commands.length > 0
      ? {}
      : { hint: 'run_command 一个命令都放行不了：传入 allowedCommands，或使用内置的 DEFAULT_ALLOWED_COMMANDS' }),
  });

  checks.push(await checkWorkspace(options.workspaceRoot, options.probeWorkspace !== false));

  return { ok: checks.every((check) => check.ok), checks };
}

/** 预检不过就抛错，由入口决定怎么退出。 */
export function assertPreflight(report: PreflightReport): void {
  if (!report.ok) throw new PreflightError(report);
}

export function formatPreflightReport(report: PreflightReport): string {
  const failed = report.checks.filter((check) => !check.ok).length;
  const lines = [
    report.ok
      ? `启动预检通过（${report.checks.length} 项）`
      : `启动预检未通过（${failed}/${report.checks.length} 项）`,
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
    if (!check.ok && check.hint) lines.push(`    → ${check.hint}`);
  }
  return lines.join('\n');
}

async function checkWorkspace(root: string, probe: boolean): Promise<PreflightCheck> {
  const directory = resolve(root);

  if (!probe) {
    try {
      await access(directory, constants.W_OK);
      return { name: 'workspace', ok: true, detail: `工作区可写：${directory}` };
    } catch (error) {
      return {
        name: 'workspace',
        ok: false,
        detail: `工作区不可写：${directory}（${errorMessage(error)}）`,
        hint: '检查目录权限与磁盘空间；容器里常见是挂载成了只读，换一个可写目录或重新挂载',
      };
    }
  }

  const probeDir = join(directory, '.joy-agent');
  const probeFile = join(probeDir, `preflight-${process.pid}.tmp`);
  try {
    await mkdir(probeDir, { recursive: true });
    await writeFile(probeFile, 'ok', 'utf8');
    await rm(probeFile, { force: true });
    return { name: 'workspace', ok: true, detail: `工作区可写：${directory}` };
  } catch (error) {
    return {
      name: 'workspace',
      ok: false,
      detail: `工作区不可写：${directory}（${errorMessage(error)}）`,
      hint: '检查目录权限与磁盘空间；容器里常见是挂载成了只读，换一个可写目录或重新挂载',
    };
  }
}
