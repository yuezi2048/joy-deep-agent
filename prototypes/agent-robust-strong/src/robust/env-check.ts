// 第8节：环境预检
import { safeExec } from './safe-exec.js'
export interface EnvRequirement {
  commands?: string[]
  minNodeMajor?: number
}
export interface EnvCheckResult {
  passed: boolean
  issues: string[]
}
export async function checkEnvironment(req: EnvRequirement): Promise<EnvCheckResult> {
  const issues: string[] = []
  if (req.minNodeMajor) {
    const major = parseInt(process.versions.node.split('.')[0], 10)
    if (major < req.minNodeMajor) issues.push(`Node 版本过低：当前 ${process.versions.node}，需要 ${req.minNodeMajor}+`)
  }
  if (req.commands) {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which'
    for (const cmd of req.commands) {
      const result = await safeExec(checkCmd, [cmd], { timeoutMs: 5000 })
      if (!result.success) issues.push(`缺少命令：${cmd}（请先安装）`)
    }
  }
  return { passed: issues.length === 0, issues }
}
export function getEnvInfo() {
  return { platform: process.platform, nodeVersion: process.versions.node, cwd: process.cwd(), arch: process.arch }
}
