/**
 * Agent Loop 控制器
 * 给智能体的主循环加上各种硬性边界
 */

export interface LoopControllerConfig {
  // 最大步数
  maxSteps?: number
  // 最大耗时（毫秒）
  maxDurationMs?: number
  // 连续多少步无进展就判定卡死
  noProgressThreshold?: number
}

export type StopReason =
  | 'completed'        // 正常完成
  | 'max_steps'        // 达到步数上限
  | 'timeout'          // 超时
  | 'no_progress'      // 无进展
  | 'loop_detected'    // 检测到循环模式

export class LoopController {
  private config: Required<LoopControllerConfig>
  private step = 0
  private startTime = Date.now()
  // 记录每一步的状态指纹，用于检测无进展和循环
  private stateFingerprints: string[] = []

  constructor(config: LoopControllerConfig = {}) {
    this.config = {
      maxSteps: config.maxSteps ?? 15,
      maxDurationMs: config.maxDurationMs ?? 5 * 60 * 1000, // 5 分钟
      noProgressThreshold: config.noProgressThreshold ?? 3,
    }
  }

  /**
   * 在每一步开始前调用，检查是否应该继续
   * @param currentState 当前状态的可序列化表示（用于检测变化）
   * 返回 null 表示可以继续，返回 StopReason 表示应该停止
   */
  shouldContinue(currentState: any): StopReason | null {
    // 检查1：步数上限
    if (this.step >= this.config.maxSteps) {
      return 'max_steps'
    }

    // 检查2：超时
    if (Date.now() - this.startTime > this.config.maxDurationMs) {
      return 'timeout'
    }

    // 生成当前状态的指纹
    const fingerprint = this.fingerprint(currentState)

    // 检查3：无进展（连续 N 步状态完全一样）
    if (this.stateFingerprints.length >= this.config.noProgressThreshold) {
      const recent = this.stateFingerprints.slice(-this.config.noProgressThreshold)
      if (recent.every((f) => f === fingerprint)) {
        return 'no_progress'
      }
    }

    // 检查4：循环模式检测（A-B-A-B 横跳）
    if (this.detectAlternating(fingerprint)) {
      return 'loop_detected'
    }

    // 记录这一步的指纹，步数加一
    this.stateFingerprints.push(fingerprint)
    this.step++
    return null
  }

  /**
   * 生成状态指纹（简单 hash）
   */
  private fingerprint(state: any): string {
    return JSON.stringify(state)
  }

  /**
   * 检测 A-B-A-B 这种横跳模式
   */
  private detectAlternating(current: string): boolean {
    const fps = [...this.stateFingerprints, current]
    if (fps.length < 4) return false
    const last4 = fps.slice(-4)
    // 检查是不是 A-B-A-B 模式
    return (
      last4[0] === last4[2] &&
      last4[1] === last4[3] &&
      last4[0] !== last4[1]
    )
  }

  getStep(): number {
    return this.step
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime
  }

  /**
   * 把停止原因转成给用户/模型的友好说明
   */
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