/**
 * 环境预检
 * 启动或执行关键任务前，检查环境是否满足
 */

import { safeExec } from './safe-exec.js'

export interface EnvRequirement {
  // 需要的命令
  commands?: string[]
  // 需要的最低 Node 主版本
  minNodeMajor?: number
}

export interface EnvCheckResult {
  passed: boolean
  issues: string[]
}

/**
 * 检查环境是否满足要求
 */
export async function checkEnvironment(
  req: EnvRequirement,
): Promise<EnvCheckResult> {
  const issues: string[] = []

  // 检查 Node 版本
  if (req.minNodeMajor) {
    const major = parseInt(process.versions.node.split('.')[0], 10)
    if (major < req.minNodeMajor) {
      issues.push(
        `Node 版本过低：当前 ${process.versions.node}，需要 ${req.minNodeMajor}+`,
      )
    }
  }

  // 检查需要的命令是否存在
  if (req.commands) {
    // 不同系统查命令的方式不同
    const checkCmd = process.platform === 'win32' ? 'where' : 'which'
    for (const cmd of req.commands) {
      const result = await safeExec(checkCmd, [cmd], { timeoutMs: 5000 })
      if (!result.success) {
        issues.push(`缺少命令：${cmd}（请先安装）`)
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  }
}

/**
 * 获取当前环境信息（用于日志和排查）
 */
export function getEnvInfo() {
  return {
    platform: process.platform, // darwin / linux / win32
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    arch: process.arch,
  }
}