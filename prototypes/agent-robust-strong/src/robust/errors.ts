// 第1节：自定义错误类型，区分可重试/不可重试
export class RetryableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message)
    this.name = 'RetryableError'
  }
}
export class NonRetryableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message)
    this.name = 'NonRetryableError'
  }
}
export class TimeoutError extends Error {
  constructor(message = '调用超时') {
    super(message)
    this.name = 'TimeoutError'
  }
}
export function isRetryable(error: any): boolean {
  if (error instanceof RetryableError) return true
  if (error instanceof NonRetryableError) return false
  if (error instanceof TimeoutError) return true
  const status = error?.status ?? error?.statusCode ?? error?.response?.status
  if (status) {
    if (status === 429 || status >= 500) return true
    if (status === 400 || status === 401 || status === 403) return false
  }
  const code = error?.code
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return true
  }
  return false
}
