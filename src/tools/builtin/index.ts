import { readFile } from 'node:fs/promises';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../../core/types.js';
import { PathGuard } from '../../security/path-guard.js';
import { evaluateExpression } from './calculator.js';
import { DEFAULT_ALLOWED_COMMANDS, safeExec } from './shell.js';

export * from './calculator.js';
export * from './shell.js';

export interface BuiltinToolOptions {
  /** 文件读写被限制在这个根目录内 */
  workspaceRoot: string;
  /** 写文件是否需要人工确认（默认需要——写操作会改变世界） */
  writeRequiresConfirmation?: boolean;
  allowedCommands?: readonly string[];
  commandTimeoutMs?: number;
  /** 单次读文件回灌给模型的最大字符数，防止把上下文冲爆 */
  maxReadChars?: number;
}

/** 内置工具集：文件读写、目录列举、命令执行、算术。 */
export function createBuiltinTools(options: BuiltinToolOptions): ToolDefinition[] {
  const guard = new PathGuard(options.workspaceRoot);
  const allowedCommands = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  const maxReadChars = options.maxReadChars ?? 16_000;

  const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: `读取工作区内的文本文件（最多返回 ${maxReadChars} 字符）`,
    schema: z.object({ path: z.string().describe('相对工作区的路径') }),
    handler: async ({ path }: { path: string }) => {
      const absolute = guard.resolve(path);
      const content = await readFile(absolute, 'utf8');
      if (content.length <= maxReadChars) return content;
      return `${content.slice(0, maxReadChars)}\n…（已截断，原文共 ${content.length} 字符）`;
    },
  };

  const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: '把文本写入工作区内的文件（会覆盖同名文件）',
    schema: z.object({
      path: z.string().describe('相对工作区的路径'),
      content: z.string().describe('完整文件内容'),
    }),
    handler: async ({ path, content }: { path: string; content: string }) => {
      const absolute = guard.resolve(path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
      return `已写入 ${path}（${content.length} 字符）`;
    },
    requiresConfirmation: options.writeRequiresConfirmation ?? true,
  };

  const listDirTool: ToolDefinition = {
    name: 'list_dir',
    description: '列出一个目录下的条目',
    schema: z.object({ path: z.string().describe('相对工作区的路径，根目录用 "."') }),
    handler: async ({ path }: { path: string }) => {
      const absolute = guard.resolve(path);
      const entries = await readdir(absolute, { withFileTypes: true });
      if (entries.length === 0) return '（空目录）';
      return entries
        .map((entry) => `${entry.isDirectory() ? '[目录]' : '[文件]'} ${entry.name}`)
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
        cwd: guard.rootDir,
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
