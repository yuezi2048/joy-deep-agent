import { z } from 'zod';

/**
 * 把 zod schema 转成模型能读的 JSON Schema。
 * zod 4 自带 `z.toJSONSchema`；若运行环境缺失该 API，退回一个宽松 schema，
 * 让调用仍能进行（参数校验始终由 ToolRegistry 在本地执行，不依赖模型遵守 schema）。
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const candidate = (z as unknown as { toJSONSchema?: (s: unknown) => unknown }).toJSONSchema;
  if (typeof candidate === 'function') {
    try {
      return candidate(schema) as Record<string, unknown>;
    } catch {
      // 个别 schema 形态（如含 transform）无法转换，退回宽松 schema
    }
  }
  return { type: 'object', additionalProperties: true };
}
