/**
 * 稳定序列化：键顺序不影响结果，用于把「同一次调用」映射成同一个 key。
 * 与 JSON.stringify 的区别：后者对 {a,b} 与 {b,a} 会给出不同字符串。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** 一次工具调用的稳定标识：名字 + 参数相同即同一次调用，参数键顺序不影响结果。 */
export function toolCallKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`;
}

/**
 * 确定性的 ToolCall id。
 *
 * 为什么不用模型给的 id：那是随机串，进程重启后就认不出来「这一步是不是已经执行过」了。
 * 续跑要靠它跟落盘的 tool 结果比对，所以 id 必须由（步号 / 组内序号 / 工具名 / 参数）唯一决定。
 * 步号与序号在位，保证同一轮里两次同名同参调用也能区分开。
 */
export function deterministicToolCallId(
  step: number,
  index: number,
  name: string,
  args: Record<string, unknown>,
): string {
  const label = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `call_${step}_${index}_${label}_${shortHash(toolCallKey(name, args))}`;
}

/** FNV-1a 32 位：只为把长参数压成短后缀，不做任何安全用途。 */
function shortHash(input: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}
