/**
 * 数学表达式求值。
 *
 * 刻意不用 `eval` / `new Function`——那等于把模型输出当代码执行。
 * 这里只认数字、四则运算、取余与括号，走递归下降解析，其余字符一律拒绝。
 */
type Token =
  | { type: 'number'; value: number }
  | { type: 'op'; value: string }
  | { type: 'lparen'; value: string }
  | { type: 'rparen'; value: string };

export function evaluateExpression(input: string): number {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new Error('表达式为空');

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token => {
    const token = tokens[pos];
    if (!token) throw new Error('表达式意外结束，可能有括号没闭合');
    pos++;
    return token;
  };

  function parseExpression(): number {
    let left = parseTerm();
    for (;;) {
      const token = peek();
      if (token?.type !== 'op' || (token.value !== '+' && token.value !== '-')) break;
      next();
      const right = parseTerm();
      left = token.value === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    for (;;) {
      const token = peek();
      if (
        token?.type !== 'op' ||
        (token.value !== '*' && token.value !== '/' && token.value !== '%')
      ) {
        break;
      }
      next();
      const right = parseFactor();
      if ((token.value === '/' || token.value === '%') && right === 0) {
        throw new Error('除数不能为 0');
      }
      if (token.value === '*') left = left * right;
      else if (token.value === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  function parseFactor(): number {
    const token = next();
    if (token.type === 'number') return token.value;
    if (token.type === 'op' && token.value === '-') return -parseFactor();
    if (token.type === 'op' && token.value === '+') return parseFactor();
    if (token.type === 'lparen') {
      const value = parseExpression();
      const closing = next();
      if (closing.type !== 'rparen') throw new Error('缺少右括号');
      return value;
    }
    throw new Error(`无法解析的符号："${token.value}"`);
  }

  const value = parseExpression();
  const leftover = peek();
  if (leftover) throw new Error(`表达式里有多余内容："${leftover.value}"`);
  if (!Number.isFinite(value)) throw new Error('计算结果不是有限数');
  return value;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let literal = '';
      while (index < input.length && /[0-9.]/.test(input[index] as string)) {
        literal += input[index];
        index++;
      }
      const value = Number(literal);
      if (!Number.isFinite(value)) throw new Error(`不是合法数字："${literal}"`);
      tokens.push({ type: 'number', value });
      continue;
    }
    if ('+-*/%'.includes(char)) {
      tokens.push({ type: 'op', value: char });
      index++;
      continue;
    }
    if (char === '(') {
      tokens.push({ type: 'lparen', value: char });
      index++;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen', value: char });
      index++;
      continue;
    }
    throw new Error(`表达式含不支持的字符："${char}"（只支持 + - * / % 与括号）`);
  }

  return tokens;
}
