/**
 * 子进程管理
 * 追踪 Agent 启动的所有子进程，退出时统一清理，防僵尸进程
 */

import { ChildProcess } from 'child_process'

export class ProcessManager {
  private children: Set<ChildProcess> = new Set()

  /**
   * 注册一个子进程
   */
  track(child: ChildProcess): void {
    this.children.add(child)
    // 进程自己结束时，从追踪列表移除
    child.on('close', () => this.children.delete(child))
  }

  /**
   * 杀掉所有还在运行的子进程
   * Agent 退出或中断时调用
   */
  killAll(): void {
    console.log(`[ProcessManager] 清理 ${this.children.size} 个子进程`)
    for (const child of this.children) {
      if (!child.killed) {
        child.kill('SIGTERM')
        // 给点时间，不行强杀
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 2000)
      }
    }
    this.children.clear()
  }

  count(): number {
    return this.children.size
  }
}

// 全局实例
export const globalProcessManager = new ProcessManager()

// 进程退出时自动清理所有子进程，防僵尸
process.on('exit', () => globalProcessManager.killAll())
process.on('SIGINT', () => {
  globalProcessManager.killAll()
  process.exit(0)
})