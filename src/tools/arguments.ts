/**
 * 工具参数解析容错（对应「失败调用」一类里的 JSON 容错）。
 *
 * 模型吐出的 arguments 经常不是干净 JSON：包了 ```json 围栏、结尾多一句解释、
 * 或者干脆被 max_tokens 截断。直接 JSON.parse 会整条调用失败，所以这里做三级降级，
 * 并且**不抛异常**——解析不出来就把问题如实交给校验层，让模型自我修正。
 */
export interface ParsedArguments {
  value: Record<string, unknown>;
  repaired: boolean;
  error?: string;
}

export function parseToolArguments(raw: string): ParsedArguments {
  const text = raw?.trim() ?? '';
  if (text === '') return { value: {}, repaired: false };

  const direct = tryParseObject(text);
  if (direct) return { value: direct, repaired: false };

  const unfenced = stripCodeFence(text);
  if (unfenced !== text) {
    const parsed = tryParseObject(unfenced);
    if (parsed) return { value: parsed, repaired: true };
  }

  const extracted = extractBalancedObject(unfenced);
  if (extracted) {
    const parsed = tryParseObject(extracted);
    if (parsed) return { value: parsed, repaired: true };
  }

  return { value: {}, repaired: false, error: 'arguments 不是合法 JSON 对象，已按空参数处理' };
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 去掉 ```json ... ``` 围栏，只保留围栏内的内容。 */
function stripCodeFence(text: string): string {
  const match = /^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return match?.[1]?.trim() ?? text;
}

/** 从「解释性文字 + JSON」的混合输出里，截出第一个花括号平衡的对象。 */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
