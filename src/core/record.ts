/**
 * `unknown` 收窄成普通对象。远端输入（MCP / A2A 响应、HTTP body）到处都是，
 * 每处各抄一份守卫必然会走样，所以留一个共用实现。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
