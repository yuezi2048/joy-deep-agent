import { describe, expect, it } from 'vitest';
import { parseToolArguments } from '../src/tools/arguments.js';

describe('parseToolArguments（JSON 容错）', () => {
  it('正常 JSON 原样解析', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ value: { a: 1 }, repaired: false });
  });

  it('空字符串按空参数处理', () => {
    expect(parseToolArguments('')).toEqual({ value: {}, repaired: false });
  });

  it('剥掉 ```json 围栏', () => {
    const raw = '```json\n{"city":"上海"}\n```';
    expect(parseToolArguments(raw)).toEqual({ value: { city: '上海' }, repaired: true });
  });

  it('从带解释文字的混合输出里截出对象', () => {
    const raw = '好的，我来调用工具：{"expression":"1+1"} 这样就完成了';
    expect(parseToolArguments(raw)).toEqual({ value: { expression: '1+1' }, repaired: true });
  });

  it('字符串里的花括号不会打断括号平衡', () => {
    const raw = '{"note":"这里有个 } 但不是结尾"}';
    expect(parseToolArguments(raw).value).toEqual({ note: '这里有个 } 但不是结尾' });
  });

  it('被截断的 JSON 解析失败但如实报告，不抛异常', () => {
    const result = parseToolArguments('{"expression":"1+1');
    expect(result.value).toEqual({});
    expect(result.error).toBeDefined();
  });

  it('数组不算合法参数对象（模型应传对象）', () => {
    expect(parseToolArguments('[1,2]').value).toEqual({});
  });
});
