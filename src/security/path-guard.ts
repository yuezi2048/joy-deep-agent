import { isAbsolute, relative, resolve } from 'node:path';

/**
 * 路径防护：把工具的文件操作限制在一个根目录内。
 *
 * 注意局限：这里只做**字面路径**判定，不解析符号链接。
 * 若根目录内存在指向外部的 symlink，仍可绕过；真实部署应配合 realpath 校验。
 * 这一条已记在 docs/adr 的后续事项里（见 ADR-0002 的后果一节）。
 */
export class PathGuard {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get rootDir(): string {
    return this.root;
  }

  /** 把用户给的相对/绝对路径解析成根目录下的绝对路径；越界即抛错。 */
  resolve(input: string): string {
    const target = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
    if (!this.isInside(target)) {
      throw new Error(`路径越界："${input}" 不在允许的根目录（${this.root}）内`);
    }
    return target;
  }

  isInside(candidate: string): boolean {
    const rel = relative(this.root, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }
}
