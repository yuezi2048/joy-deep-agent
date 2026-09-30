// 第6节：熔断器
export type CircuitState = 'closed' | 'open' | 'half-open'
export interface CircuitBreakerConfig {
  failureThreshold?: number
  resetTimeoutMs?: number
}
export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private config: Required<CircuitBreakerConfig>
  constructor(config: CircuitBreakerConfig = {}) {
    this.config = { failureThreshold: config.failureThreshold ?? 3, resetTimeoutMs: config.resetTimeoutMs ?? 60000 }
  }
  canRequest(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open'
        return true
      }
      return false
    }
    return true
  }
  recordSuccess(): void {
    this.failureCount = 0
    this.state = 'closed'
  }
  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
    if (this.state === 'half-open') {
      this.state = 'open'
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open'
    }
  }
  getState(): CircuitState { return this.state }
}
