/**
 * 重试机制（核心）
 * 失败自动重试，区分可重试错误，指数退避，限制最大次数
 */

import { isRetryable } from "./errors.js";

export interface RetryOptions {
  // 最大重试次数（不含第一次），默认 3
  maxRetries?: number;
  // 初始等待毫秒，默认 1000
  initialDelay?: number;
  // 退避倍数，默认 2（每次等待时间翻倍）
  backoffFactor?: number;
  // 最大等待毫秒，默认 30000（防止退避到天荒地老）
  maxDelay?: number;
  // 每次重试前的回调，用于打日志
  onRetry?: (error: any, attempt: number, delay: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的执行
 * @param fn 要执行的异步函数
 * @param options 重试配置
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    backoffFactor = 2,
    maxDelay = 30000,
    onRetry,
  } = options;

  let lastError: any;

  // 总共尝试 maxRetries + 1 次（第一次 + 重试次数）
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 尝试执行
      return await fn();
    } catch (error) {
      lastError = error;

      // 不可重试的错误，直接抛出，不浪费重试
      if (!isRetryable(error)) {
        throw error;
      }

      // 已经是最后一次了，不再重试，抛出
      if (attempt === maxRetries) {
        break;
      }

      // 计算这次的等待时间：指数退避
      // 第 0 次失败等 1s，第 1 次等 2s，第 2 次等 4s
      const delay = Math.min(
        initialDelay * Math.pow(backoffFactor, attempt),
        maxDelay,
      );

      // 回调打日志
      onRetry?.(error, attempt + 1, delay);

      // 等待后重试
      await sleep(delay);
    }
  }

  // 重试都用完了还失败，抛出最后一次的错误
  throw lastError;
}
