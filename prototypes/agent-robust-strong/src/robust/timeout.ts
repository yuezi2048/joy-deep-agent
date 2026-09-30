// 第1节：超时控制
import { TimeoutError } from './errors.js'
export function withTimeout<T>(promise: Promise<T>, ms: number, label = '操作'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new TimeoutError(`${label}超时（${ms}ms）`)), ms),
    ),
  ])
}
