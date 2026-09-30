// 第8节：安全命令执行
import { spawn } from 'child_process'
export interface ExecResult {
  success: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  message: string
}
export interface ExecOptions {
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string>
}
export function safeExec(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const { timeoutMs = 30000, cwd, env } = options
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let finished = false
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, shell: false })
    const timer = setTimeout(() => {
      if (!finished) {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000)
        finished = true
        resolve({ success: false, exitCode: null, stdout, stderr, message: `命令执行超时（${timeoutMs}ms），已强制终止：${command}` })
      }
    }, timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ success: code === 0, exitCode: code, stdout, stderr, message: translateExitResult(command, code, stderr) })
    })
    child.on('error', (err: any) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ success: false, exitCode: null, stdout, stderr, message: translateExecError(command, err) })
    })
  })
}
function translateExitResult(command: string, code: number | null, stderr: string): string {
  if (code === 0) return `命令执行成功：${command}`
  return `命令执行失败（退出码 ${code}）：${command}${stderr ? '，错误：' + stderr.slice(0, 200) : ''}`
}
function translateExecError(command: string, err: any): string {
  const code = err?.code
  const map: Record<string, string> = {
    ENOENT: `命令不存在：${command}（请检查命令是否安装、是否在 PATH 中）`,
    EACCES: `没有执行权限：${command}`,
    EPERM: `操作不被允许：${command}`,
  }
  return map[code] ?? `命令执行出错：${command}，${err?.message ?? '未知错误'}`
}
