import { resolve } from 'node:path';
import { isWithin } from '../security/path-guard.js';

/** 挂载模式：`ro` 只读、`rw` 可读写。 */
export type MountMode = 'ro' | 'rw';

/** 一条挂载：工作区内的某个路径前缀，以及它能被怎么用。 */
export interface Mount {
  /** 相对工作区根目录的前缀；`.` 表示根本身 */
  prefix: string;
  mode: MountMode;
}

/** 归一化之后的挂载：前缀已解析成绝对路径，按最长前缀优先排好序。 */
export interface ResolvedMount {
  /** 绝对路径 */
  path: string;
  /** 配置里写的原样前缀，只用于报错信息 */
  label: string;
  mode: MountMode;
}

/**
 * 把配置里的挂载点解析成绝对路径并按**最长前缀优先**排序。
 *
 * 为什么最长优先：同时挂了 `.`（只读）与 `.joy-agent`（可写）时，写在 `.joy-agent/reports/x.md`
 * 必须命中更具体的后者，否则「专门开的口子」永远轮不到。
 */
export function resolveMounts(root: string, mounts: readonly Mount[]): ResolvedMount[] {
  const resolved: ResolvedMount[] = [];
  const seen = new Map<string, MountMode>();

  for (const mount of mounts) {
    const label = mount.prefix.trim() === '' ? '.' : mount.prefix.trim();
    const path = resolve(root, label);
    if (!isWithin(root, path)) {
      throw new Error(`挂载点 "${label}" 越出工作区（${root}）：挂载不能把沙箱开到外面去`);
    }

    const previous = seen.get(path);
    if (previous !== undefined) {
      throw new Error(`挂载点 "${label}" 配置了两次（${previous} / ${mount.mode}）：同一路径只能有一种模式`);
    }
    seen.set(path, mount.mode);
    resolved.push({ path, label, mode: mount.mode });
  }

  return resolved.sort((left, right) => right.path.length - left.path.length);
}

/** 命中给定路径的挂载点（最长前缀优先）；没有命中返回 null。 */
export function matchMount(mounts: readonly ResolvedMount[], target: string): ResolvedMount | null {
  return mounts.find((mount) => isWithin(mount.path, target)) ?? null;
}

/** 缺省挂载表：整个工作区可读写（与接入沙箱之前的行为一致）。 */
export const DEFAULT_MOUNTS: readonly Mount[] = [{ prefix: '.', mode: 'rw' }];
