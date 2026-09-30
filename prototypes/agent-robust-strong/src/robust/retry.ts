// 第1节：重试机制（指数退避）
import { isRetryable } from './errors.js'
export interface RetryOptions {
  maxRetries?: number
  initialDelay?: number
  backoffFactor?: number
  maxDelay?: number
  onRetry?: (error: any, attempt: number, delay: number) => void
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, backoffFactor = 2, maxDelay = 30000, onRetry } = options
  let lastError: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) throw error
      if (attempt === maxRetries) break
      const delay = Math.min(initialDelay * Math.pow(backoffFactor, attempt), maxDelay)
      onRetry?.(error, attempt + 1, delay)
      await sleep(delay)
    }
  }
  throw lastError
}
