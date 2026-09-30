/**
 * 熔断器
 * 某个供应商连续失败就"熔断"，一段时间不再尝试，避免浪费
 */

export type CircuitState = 'closed' | 'open' | 'half-open'
// closed: 正常，请求放行
// open: 熔断，请求直接拒绝
// half-open: 半开，试探性放行一个请求看是否恢复

export interface CircuitBreakerConfig {
  // 连续失败多少次触发熔断
  failureThreshold?: number
  // 熔断后多久进入半开状态（毫秒）
  resetTimeoutMs?: number
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private config: Required<CircuitBreakerConfig>

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 3,
      resetTimeoutMs: config.resetTimeoutMs ?? 60000, // 1 分钟
    }
  }

  /**
   * 检查当前是否允许请求通过
   */
  canRequest(): boolean {
    if (this.state === 'closed') return true

    if (this.state === 'open') {
      // 熔断中，看是否到了进入半开的时间
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open'
        return true // 放一个请求试探
      }
      return false // 还在熔断期，拒绝
    }

    // half-open，放行试探
    return true
  }

  /**
   * 记录一次成功
   */
  recordSuccess(): void {
    this.failureCount = 0
    this.state = 'closed' // 成功就恢复正常
  }

  /**
   * 记录一次失败
   */
  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.state === 'half-open') {
      // 半开状态下失败，重新熔断
      this.state = 'open'
    } else if (this.failureCount >= this.config.failureThreshold) {
      // 连续失败达到阈值，熔断
      this.state = 'open'
    }
  }

  getState(): CircuitState {
    return this.state
  }
}