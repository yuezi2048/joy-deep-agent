import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { matchMount, resolveMounts, DEFAULT_MOUNTS, type Mount, type ResolvedMount } from './mount.js';

/**
 * 工作区沙箱：把「模型能让工具碰哪些文件」收成一条可判定的规则。
 *
 * 边界说明（别把它读成安全隔离）：这是**进程内的路径约束**，目的是拦住模型的误操作与越界写入。
 * 它挡不住恶意代码——能跑 `run_command` 的模型本来就有工作区权限。对抗恶意代码要靠容器 / 权限隔离。
 *
 * 相对原型（`prototypes/deep-agent-demo/src/sandbox.ts`）补了三处：
 * 1. 越界判定走相对路径，不用 `startsWith`（原型的 `/out-evil` 会被当成 `/out` 的子路径）；
 * 2. 对「最近的已存在祖先」做 `realpath` 后重判一次，拦住 `workspace/link -> /etc` 这类符号链接绕行；
 * 3. 写盘有配额（单文件 / 累计字节 / 文件数）与审计记录，且配额在**落盘之前**判定。
 */
export interface SandboxLimits {
  /** 单文件字节上限 */
  maxFileBytes?: number;
  /** 累计写入字节上限 */
  maxTotalBytes?: number;
  /** 写入文件数上限 */
  maxFiles?: number;
}

export interface WriteRecord {
  /** 相对工作区的路径 */
  path: string;
  bytes: number;
  at: number;
  /** 命中的挂载点（配置里写的原样前缀） */
  mount: string;
  /** 触发这次写入的工具调用 id；进程内没有「用户」概念，能确定的就是这个 */
  callId?: string;
}

export interface WorkspaceSandboxOptions {
  root: string;
  /** 显式挂载表；给了它就以它为准 */
  mounts?: readonly Mount[];
  /** 收窄写盘的口子：工作区只读 + 这个子目录可写。不传 = 按 `mounts` 或缺省全可写 */
  writeRoot?: string;
  limits?: SandboxLimits;
  /** 时间源，测试注入 */
  now?: () => number;
}

export interface SandboxEntry {
  name: string;
  directory: boolean;
}

const DEFAULT_LIMITS: Required<SandboxLimits> = {
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFiles: 200,
};

export class WorkspaceSandbox {
  readonly root: string;
  private readonly mounts: readonly ResolvedMount[];
  private readonly limits: Required<SandboxLimits>;
  private readonly now: () => number;
  private readonly records: WriteRecord[] = [];
  /** 已经写过的绝对路径；文件数配额按去重后的文件算，覆盖同一个文件不该重复占额 */
  private readonly written = new Set<string>();
  private totalBytes = 0;

  constructor(options: WorkspaceSandboxOptions) {
    this.root = resolve(options.root);
    const mounts =
      options.mounts ??
      (options.writeRoot
        ? [
            { prefix: '.', mode: 'ro' as const },
            { prefix: options.writeRoot, mode: 'rw' as const },
          ]
        : DEFAULT_MOUNTS);
    this.mounts = resolveMounts(this.root, mounts);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  /** 挂载表快照，用于启动时打印与排查。 */
  get mountPoints(): readonly ResolvedMount[] {
    return this.mounts;
  }

  /** 可写挂载点。启动时打印「模型到底能往哪儿写」用的就是它。 */
  writableMounts(): ResolvedMount[] {
    return this.mounts.filter((mount) => mount.mode === 'rw');
  }

  /** 写盘审计：每次成功写入一条。 */
  audit(): readonly WriteRecord[] {
    return [...this.records];
  }

  /** 解析一个读路径：必须落在任一挂载内，且真实位置也不能跑出去（符号链接）。 */
  async resolveRead(input: string): Promise<string> {
    return this.resolvePath(input, 'read');
  }

  /** 解析一个写路径：必须落在**可写**挂载内，真实位置同理。 */
  async resolveWrite(input: string): Promise<string> {
    return this.resolvePath(input, 'write');
  }

  async read(input: string): Promise<string> {
    return readFile(await this.resolveRead(input), 'utf8');
  }

  async list(input: string): Promise<SandboxEntry[]> {
    const entries = await readdir(await this.resolveRead(input), { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
  }

  /**
   * 只看不写：这次写入能不能过（挂载 + 真实位置 + 配额）。
   *
   * 给 HITL 用：写盘前先过一遍，超限/越界就别弹人工确认——让人去确认一件注定失败的事，
   * 既浪费人的注意力，也把「拒绝」伪装成了「等待授权」。
   */
  async canWrite(input: string, content: string): Promise<boolean> {
    try {
      await this.writeTarget(input, content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 写入。配额在落盘之前判——超限时磁盘上不该留下半个文件，
   * 也不该让人去确认一次注定失败的写操作（HITL 的确认是有成本的）。
   */
  async write(input: string, content: string, callId?: string): Promise<WriteRecord> {
    const { target, bytes } = await this.writeTarget(input, content);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');

    const record: WriteRecord = {
      path: relative(this.root, target),
      bytes,
      at: this.now(),
      mount: matchMount(this.mounts, target)?.label ?? '.',
      ...(callId ? { callId } : {}),
    };
    this.totalBytes += bytes;
    this.written.add(target);
    this.records.push(record);
    return record;
  }

  private async resolvePath(input: string, use: 'read' | 'write'): Promise<string> {
    const target = isAbsolute(input) ? resolve(input) : resolve(this.root, input);

    // 第一道：字面路径判定。挡 `../` 与根外绝对路径。
    const literal = matchMount(this.mounts, target);
    if (!literal) {
      throw new Error(`路径越界："${input}" 不在沙箱的挂载点内（工作区：${this.root}）`);
    }
    if (use === 'write' && literal.mode !== 'rw') {
      throw new Error(`路径 "${input}" 落在只读挂载点 "${literal.label}" 内，不能写`);
    }

    // 第二道：真实路径判定。`workspace/link -> /etc` 时字面看在工作区内，realpath 之后不在。
    const realMount = matchMount(await this.realMounts(), await resolveReal(target));
    if (!realMount) {
      throw new Error(`路径 "${input}" 的真实位置越出沙箱（符号链接指向了工作区外）`);
    }
    if (use === 'write' && realMount.mode !== 'rw') {
      throw new Error(`路径 "${input}" 的真实位置落在只读挂载点 "${realMount.label}" 内，不能写`);
    }

    return target;
  }

  /** 写路径的完整前置检查。`write` 与 `canWrite` 共用这一份口径，不许各判各的。 */
  private async writeTarget(input: string, content: string): Promise<{ target: string; bytes: number }> {
    const target = await this.resolveWrite(input);
    if (target === this.root) {
      throw new Error(`写入被拒："${input}" 指向工作区根目录，要写的是一个文件路径`);
    }

    const bytes = Buffer.byteLength(content, 'utf8');
    this.assertQuota(target, bytes);
    return { target, bytes };
  }

  /** 真实挂载表：挂载点自身也可能是符号链接，两道判定必须用同一套坐标。 */
  private async realMounts(): Promise<ResolvedMount[]> {
    const mounts = await Promise.all(
      this.mounts.map(async (mount) => ({ ...mount, path: await resolveReal(mount.path) })),
    );
    return mounts.sort((left, right) => right.path.length - left.path.length);
  }

  private assertQuota(target: string, bytes: number): void {
    const label = relative(this.root, target);

    if (bytes > this.limits.maxFileBytes) {
      throw new Error(
        `写入被拒：${label} 有 ${bytes} 字节，超过单文件上限 ${this.limits.maxFileBytes} 字节（超出 ${bytes - this.limits.maxFileBytes} 字节）`,
      );
    }
    if (this.totalBytes + bytes > this.limits.maxTotalBytes) {
      throw new Error(
        `写入被拒：本次写入后累计 ${this.totalBytes + bytes} 字节，超过累计上限 ${this.limits.maxTotalBytes} 字节（已用 ${this.totalBytes}）`,
      );
    }
    const nextFiles = this.written.has(target) ? this.written.size : this.written.size + 1;
    if (nextFiles > this.limits.maxFiles) {
      throw new Error(
        `写入被拒：本次写入后共 ${nextFiles} 个文件，超过文件数上限 ${this.limits.maxFiles}（同一个文件重复写不重复占额）`,
      );
    }
  }
}

/** 把「可能还不存在」的路径规范化成真实路径：对最近的已存在祖先做 realpath，再拼回剩余后缀。 */
async function resolveReal(target: string): Promise<string> {
  let ancestor = target;
  for (;;) {
    try {
      await stat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return target;
      ancestor = parent;
    }
  }
  const real = await realpath(ancestor);
  return ancestor === target ? real : join(real, relative(ancestor, target));
}
