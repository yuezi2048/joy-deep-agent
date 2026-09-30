/** 可重试错误：网络抖动、限流、供应商 5xx 等。 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** 明确不该重试的错误：参数错误、鉴权失败。重试只会浪费预算。 */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class TimeoutError extends Error {
  constructor(message = '调用超时') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class CancelledError extends Error {
  constructor(message = '操作已被取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

function statusOf(error: unknown): number | undefined {
  const e = error as { status?: number; statusCode?: number; response?: { status?: number } };
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

/** 错误分类：决定是否重试。未知错误一律不重试，避免把确定性失败放大成 N 倍成本。 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof NonRetryableError) return false;
  if (error instanceof TimeoutError) return true;
  if (error instanceof CancelledError) return false;

  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 429 || status >= 500) return true;
    if (status === 400 || status === 401 || status === 403 || status === 404) return false;
  }

  const code = codeOf(error);
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return true;
  }

  return false;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
