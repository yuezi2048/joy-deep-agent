/**
 * 超时控制
 * 给任意 Promise 包一层超时，超时就主动中断
 */

import { TimeoutError } from './errors.js'

/**
 * 给一个 Promise 加超时
 * @param promise 要执行的异步操作
 * @param ms 超时毫秒数
 * @param label 操作名称，用于错误信息
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = '操作',
): Promise<T> {
  // 用 Promise.race，谁先完成用谁的结果
  // 一个是真正的操作，一个是定时器
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new TimeoutError(`${label}超时（${ms}ms）`)),
        ms,
      ),
    ),
  ])
}