import { z } from 'zod';
import type { ToolDefinition } from '../../core/types.js';
import { WorkspaceSandbox } from '../../vfs/index.js';
import { evaluateExpression } from './calculator.js';
import { DEFAULT_ALLOWED_COMMANDS, safeExec } from './shell.js';

export * from './calculator.js';
export * from './shell.js';

export interface BuiltinToolOptions {
  /** 直接注入沙箱（运行时装配走这条，配额与审计只有一份计数） */
  sandbox?: WorkspaceSandbox;
  /**
   * 现场建沙箱时的根目录；给了 `sandbox` 就忽略。
   * 这条路径用沙箱的**缺省**挂载与配额——要收窄写盘或调配额，请自己建好 `WorkspaceSandbox` 传进来，
   * 免得同一个开关在两处各有一套默认值。
   */
  workspaceRoot?: string;
  /** 写文件是否需要人工确认（默认需要——写操作会改变世界） */
  writeRequiresConfirmation?: boolean;
  allowedCommands?: readonly string[];
  commandTimeoutMs?: number;
}

/** 内置工具集：文件读写、目录列举、命令执行、算术。 */
export function createBuiltinTools(options: BuiltinToolOptions): ToolDefinition[] {
  const sandbox = options.sandbox ?? new WorkspaceSandbox({ root: options.workspaceRoot ?? process.cwd() });
  const allowedCommands = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;

  const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: '读取工作区内的文本文件',
    schema: z.object({ path: z.string().describe('相对工作区的路径') }),
    // 不做长度上限：工具结果占多少上下文，由上下文预算层统一决定（见 ADR-0002 同一思路），
    // 各工具自己设上限只会让「结果多大」这件事散落在几十处、口径还不一致。
    handler: async ({ path }: { path: string }) => sandbox.read(path),
  };

  const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: '把文本写入工作区内的文件（会覆盖同名文件）',
    schema: z.object({
      path: z.string().describe('相对工作区的路径'),
      content: z.string().describe('完整文件内容'),
    }),
    handler: async ({ path, content }: { path: string; content: string }, ctx) => {
      const record = await sandbox.write(path, content, ctx.callId);
      return `已写入 ${record.path}（${record.bytes} 字节）`;
    },
    // 越界 / 超配额时这次写入注定失败：直接返回可读拒绝，不必让人去确认一件不会成功的事（见 ADR-0008）。
    requiresConfirmation: async (args: Record<string, unknown>) =>
      (options.writeRequiresConfirmation ?? true) &&
      (await sandbox.canWrite(String(args.path ?? ''), String(args.content ?? ''))),
  };

  const listDirTool: ToolDefinition = {
    name: 'list_dir',
    description: '列出一个目录下的条目',
    schema: z.object({ path: z.string().describe('相对工作区的路径，根目录用 "."') }),
    handler: async ({ path }: { path: string }) => {
      const entries = await sandbox.list(path);
      if (entries.length === 0) return '（空目录）';
      return entries
        .map((entry) => `${entry.directory ? '[目录]' : '[文件]'} ${entry.name}`)
        .join('\n');
    },
  };

  const runCommandTool: ToolDefinition = {
    name: 'run_command',
    description: `执行白名单内的命令（不经过 shell，无注入风险）。允许：${allowedCommands.join(', ')}`,
    schema: z.object({
      command: z.string().describe('可执行文件名，不带路径分隔符'),
      args: z.array(z.string()).optional().describe('参数列表，按字面量传递'),
    }),
    handler: async ({ command, args }: { command: string; args?: string[] }) => {
      const result = await safeExec(command, args ?? [], {
        cwd: sandbox.root,
        timeoutMs: commandTimeoutMs,
        allowedCommands,
      });
      const parts = [
        `退出码：${result.code ?? '(被信号终止)'}`,
        result.timedOut ? '⚠️ 已超时并被强制终止' : null,
        result.truncated ? '⚠️ 输出过长已截断' : null,
        result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : null,
        result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : null,
      ].filter(Boolean);
      return parts.join('\n');
    },
  };

  const calculatorTool: ToolDefinition = {
    name: 'calculator',
    description: '计算数学表达式，支持 + - * / % 与括号',
    schema: z.object({ expression: z.string().describe('例如 (2 + 3) * 4') }),
    handler: async ({ expression }: { expression: string }) => {
      const value = evaluateExpression(expression);
      return `${expression} = ${value}`;
    },
  };

  return [calculatorTool, readFileTool, listDirTool, writeFileTool, runCommandTool];
}
