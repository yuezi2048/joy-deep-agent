// 第7节：中断控制器
export type CleanupFn = () => void | Promise<void>
export class InterruptController {
  private abortController = new AbortController()
  private cleanupFns: CleanupFn[] = []
  private interrupted = false
  private reason = ''
  get signal(): AbortSignal { return this.abortController.signal }
  isInterrupted(): boolean { return this.interrupted }
  getReason(): string { return this.reason }
  interrupt(reason = '用户主动中断'): void {
    if (this.interrupted) return
    this.interrupted = true
    this.reason = reason
    this.abortController.abort()
    console.log(`[Interrupt] 收到中断信号：${reason}`)
  }
  onCleanup(fn: CleanupFn): void { this.cleanupFns.push(fn) }
  async cleanup(): Promise<void> {
    console.log(`[Interrupt] 开始清理 ${this.cleanupFns.length} 个资源...`)
    for (const fn of this.cleanupFns) {
      try { await fn() } catch (err) { console.error('[Interrupt] 清理出错：', err) }
    }
    console.log('[Interrupt] 清理完成')
  }
  throwIfInterrupted(): void {
    if (this.interrupted) throw new InterruptedError(this.reason)
  }
}
export class InterruptedError extends Error {
  constructor(reason: string) {
    super(`任务被中断：${reason}`)
    this.name = 'InterruptedError'
  }
}
