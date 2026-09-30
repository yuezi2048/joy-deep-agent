// 第4节：Agent Loop 控制器（步数/超时/无进展/循环检测）
export interface LoopControllerConfig {
  maxSteps?: number
  maxDurationMs?: number
  noProgressThreshold?: number
}
export type StopReason = 'completed' | 'max_steps' | 'timeout' | 'no_progress' | 'loop_detected'
export class LoopController {
  private config: Required<LoopControllerConfig>
  private step = 0
  private startTime = Date.now()
  private stateFingerprints: string[] = []
  constructor(config: LoopControllerConfig = {}) {
    this.config = {
      maxSteps: config.maxSteps ?? 15,
      maxDurationMs: config.maxDurationMs ?? 5 * 60 * 1000,
      noProgressThreshold: config.noProgressThreshold ?? 3,
    }
  }
  shouldContinue(currentState: any): StopReason | null {
    if (this.step >= this.config.maxSteps) return 'max_steps'
    if (Date.now() - this.startTime > this.config.maxDurationMs) return 'timeout'
    const fingerprint = this.fingerprint(currentState)
    if (this.stateFingerprints.length >= this.config.noProgressThreshold) {
      const recent = this.stateFingerprints.slice(-this.config.noProgressThreshold)
      if (recent.every((f) => f === fingerprint)) return 'no_progress'
    }
    if (this.detectAlternating(fingerprint)) return 'loop_detected'
    this.stateFingerprints.push(fingerprint)
    this.step++
    return null
  }
  private fingerprint(state: any): string {
    return JSON.stringify(state)
  }
  private detectAlternating(current: string): boolean {
    const fps = [...this.stateFingerprints, current]
    if (fps.length < 4) return false
    const last4 = fps.slice(-4)
    return last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]
  }
  getStep(): number { return this.step }
  getElapsedMs(): number { return Date.now() - this.startTime }
  static explainStop(reason: StopReason): string {
    const map: Record<StopReason, string> = {
      completed: '任务已完成',
      max_steps: '已达到最大步数限制，任务可能未完全完成，返回当前进度',
      timeout: '任务执行超时，返回当前进度',
      no_progress: '检测到连续多步无实质进展，已停止，避免空转',
      loop_detected: '检测到反复横跳的循环模式，已停止',
    }
    return map[reason]
  }
  reset(): void {
    this.step = 0
    this.startTime = Date.now()
    this.stateFingerprints = []
  }
}
