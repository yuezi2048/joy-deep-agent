import { spawn } from 'node:child_process';

export interface SafeExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** 命令白名单。默认只放行常见的只读/构建命令，破坏性命令一律不放行。 */
  allowedCommands?: readonly string[];
}

export interface SafeExecResult {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'node',
  'npm',
  'pnpm',
  'git',
  'ls',
  'cat',
  'echo',
  'pwd',
  'date',
  'which',
];

/**
 * 安全命令执行（对应「终端环境异常」一类）。
 *
 * 要点：
 * - `shell: false`——参数以字面量传给子进程，`;`、`&&`、`|`、`$(...)` 全部失效，注入不成立。
 * - 命令白名单，默认拒绝一切破坏性命令（rm / curl / sh 等不在表里）。
 * - 硬超时，到点 SIGKILL，不让子进程挂死主循环。
 * - 输出截断，防止一条命令把上下文冲爆。
 */
export async function safeExec(
  command: string,
  args: readonly string[] = [],
  options: SafeExecOptions = {},
): Promise<SafeExecResult> {
  const {
    cwd,
    timeoutMs = 30_000,
    maxOutputBytes = 64 * 1024,
    signal,
    allowedCommands = DEFAULT_ALLOWED_COMMANDS,
  } = options;

  if (command.includes('/') || command.includes('\\')) {
    throw new Error(`命令必须是可执行名，不能带路径分隔符："${command}"`);
  }
  if (!allowedCommands.includes(command)) {
    throw new Error(
      `命令 "${command}" 不在白名单内。允许：${allowedCommands.join(', ')}`,
    );
  }

  return new Promise<SafeExecResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > maxOutputBytes) {
        truncated = true;
        return next.slice(0, maxOutputBytes);
      }
      return next;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      cleanup();
      rejectPromise(error);
    });

    child.on('close', (code) => {
      cleanup();
      resolvePromise({ command, args: [...args], code, stdout, stderr, timedOut, truncated });
    });
  });
}
