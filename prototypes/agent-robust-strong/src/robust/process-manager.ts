// 第8节：子进程管理
import { ChildProcess } from 'child_process'
export class ProcessManager {
  private children: Set<ChildProcess> = new Set()
  track(child: ChildProcess): void {
    this.children.add(child)
    child.on('close', () => this.children.delete(child))
  }
  killAll(): void {
    console.log(`[ProcessManager] 清理 ${this.children.size} 个子进程`)
    for (const child of this.children) {
      if (!child.killed) {
        child.kill('SIGTERM')
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 2000)
      }
    }
    this.children.clear()
  }
  count(): number { return this.children.size }
}
export const globalProcessManager = new ProcessManager()
process.on('exit', () => globalProcessManager.killAll())
process.on('SIGINT', () => { globalProcessManager.killAll(); process.exit(0) })
