/**
 * 自定义错误类型
 * 用来区分不同的失败，决定要不要重试
 */

// 可重试的错误（临时性故障）
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

// 不可重试的错误（永久性故障，重试无意义）
export class NonRetryableError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// 超时错误
export class TimeoutError extends Error {
  constructor(message = "调用超时") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * 判断一个错误该不该重试
 * 根据 HTTP 状态码和错误类型判断
 */
export function isRetryable(error: any): boolean {
  // 明确标记的可重试错误
  if (error instanceof RetryableError) return true;
  if (error instanceof NonRetryableError) return false;
  if (error instanceof TimeoutError) return true;

  // 根据 HTTP 状态码判断
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status) {
    // 429 限流、500+ 服务器错误，可重试
    if (status === 429 || status >= 500) return true;
    // 400 参数错误、401 认证失败、403 无权限，不可重试
    if (status === 400 || status === 401 || status === 403) return false;
  }

  // 网络层错误（连接被拒、超时、断开），可重试
  const code = error?.code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }

  // 默认不重试，避免对未知错误盲目重试
  return false;
}
