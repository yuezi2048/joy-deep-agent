/**
 * 中断控制器
 * 基于标准 AbortController，管理任务的中断信号和清理
 */

export type CleanupFn = () => void | Promise<void>

export class InterruptController {
  private abortController = new AbortController()
  private cleanupFns: CleanupFn[] = []
  private interrupted = false
  private reason = ''

  /**
   * 获取信号，传给需要支持中断的操作（如 fetch）
   */
  get signal(): AbortSignal {
    return this.abortController.signal
  }

  /**
   * 是否已被中断
   */
  isInterrupted(): boolean {
    return this.interrupted
  }

  getReason(): string {
    return this.reason
  }

  /**
   * 触发中断
   */
  interrupt(reason = '用户主动中断'): void {
    if (this.interrupted) return
    this.interrupted = true
    this.reason = reason
    this.abortController.abort()
    console.log(`[Interrupt] 收到中断信号：${reason}`)
  }

  /**
   * 注册清理函数，中断时会依次执行
   */
  onCleanup(fn: CleanupFn): void {
    this.cleanupFns.push(fn)
  }

  /**
   * 执行所有清理
   */
  async cleanup(): Promise<void> {
    console.log(`[Interrupt] 开始清理 ${this.cleanupFns.length} 个资源...`)
    for (const fn of this.cleanupFns) {
      try {
        await fn()
      } catch (err) {
        console.error('[Interrupt] 清理出错：', err)
      }
    }
    console.log('[Interrupt] 清理完成')
  }

  /**
   * 在检查点调用：如果已中断，抛出中断异常
   * 用来在 loop 步骤之间检查是否该停
   */
  throwIfInterrupted(): void {
    if (this.interrupted) {
      throw new InterruptedError(this.reason)
    }
  }
}

export class InterruptedError extends Error {
  constructor(reason: string) {
    super(`任务被中断：${reason}`)
    this.name = 'InterruptedError'
  }
}