import { z, type ZodType } from 'zod';
import { isRecord } from '../../core/record.js';

/**
 * JSON Schema → zod（本地校验用）。
 *
 * 为什么需要这座桥：MCP server 声明参数用的是 JSON Schema，而 `ToolRegistry` 的本地校验走 zod
 * （校验失败回灌给模型自我修正，对应「幻觉」一类故障）。两边必须有个转换。
 *
 * 两条纪律：
 * - **只做子集**：认识 object / properties / required / string / number / integer / boolean /
 *   array / enum / additionalProperties，其余 keyword 一律退化。看不懂不等于要报错。
 * - **绝不抛异常**：远端 schema 是外部输入，畸形 schema 不该把注册流程带崩，
 *   最差退化成 `z.unknown()`——校验放行，交给远端自己拒绝。
 */

/** 递归深度上限：防远端用自引用 schema 把转换器拖进无底洞。 */
const MAX_DEPTH = 12;

/** MCP 工具的权威 JSON Schema；含 `$ref` 时返回 undefined，让调用方回退到 zod 推导版。 */
export function modelParameters(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  if (hasRefs(schema)) return undefined;
  if (schema.type !== 'object' && !isRecord(schema.properties)) return undefined;

  const cloned = structuredClone(schema);
  // `$schema` / `$id` 之类是文档元数据，模型侧的 function calling 不认，去掉更稳
  delete cloned.$schema;
  delete cloned.$id;
  delete cloned.$comment;
  return cloned;
}

/** 把远端 JSON Schema 转成可用于本地校验的 zod schema。畸形输入一律退化，不抛异常。 */
export function jsonSchemaToZod(schema: unknown): ZodType {
  return convert(schema, 0);
}

function convert(schema: unknown, depth: number): ZodType {
  if (depth > MAX_DEPTH) return z.unknown();
  if (schema === true || schema === undefined || schema === null) return z.unknown();
  if (schema === false) return z.never();
  if (!isRecord(schema)) return z.unknown();

  const fromEnum = convertEnum(schema.enum);
  if (fromEnum) return fromEnum;

  const types = readTypes(schema.type);
  if (types.length === 0) {
    // 没写 type 但写了 properties：按 object 处理，这是最常见的省略写法
    if (isRecord(schema.properties)) return convertObject(schema, depth);
    return z.unknown();
  }

  const nullable = types.includes('null');
  const concrete = types.filter((type) => type !== 'null');
  let base: ZodType;
  if (concrete.length === 0) base = z.null();
  else if (concrete.length === 1) base = convertTyped(concrete[0]!, schema, depth);
  else base = unionOf(concrete.map((type) => convertTyped(type, schema, depth)));

  return nullable && concrete.length > 0 ? base.nullable() : base;
}

function convertTyped(type: string, schema: Record<string, unknown>, depth: number): ZodType {
  switch (type) {
    case 'string':
      return z.string();
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return convertArray(schema, depth);
    case 'object':
      return convertObject(schema, depth);
    default:
      // 不认识的 type（含 JSON Schema 2020 的 union 变体）一律放行
      return z.unknown();
  }
}

function convertArray(schema: Record<string, unknown>, depth: number): ZodType {
  // 元组（items 是数组）在 function calling 里极罕见，退成不限元素类型的数组
  if (Array.isArray(schema.items)) return z.array(z.unknown());
  return z.array(convert(schema.items, depth + 1));
}

function convertObject(schema: Record<string, unknown>, depth: number): ZodType {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [],
  );

  const shape: Record<string, ZodType> = {};
  for (const [key, value] of Object.entries(properties)) {
    const child = convert(value, depth + 1);
    shape[key] = required.has(key) ? child : child.optional();
  }

  // additionalProperties: false 时收紧到 strict，其余一律 loose（默认宽松，别把模型多给的字面参数判死）
  return schema.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
}

function convertEnum(values: unknown): ZodType | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const literals = values.filter(isPrimitive);
  if (literals.length !== values.length) return undefined;

  if (literals.every((value): value is string => typeof value === 'string')) {
    return z.enum(literals as [string, ...string[]]);
  }
  if (literals.length === 1) return z.literal(literals[0] as string | number | boolean);
  return unionOf(literals.map((value) => z.literal(value as string | number | boolean)));
}

/** zod 的 union 要求至少两支；调用点都保证了 length ≥ 2，这里收口一次类型断言。 */
function unionOf(variants: ZodType[]): ZodType {
  return z.union(variants as unknown as [ZodType, ZodType, ...ZodType[]]);
}

function readTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === 'string');
  return [];
}

/** `$ref` / `$defs` 在 OpenAI 兼容的 function calling 里不被支持，出现就放弃直通、回退 zod 版。 */
function hasRefs(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => hasRefs(item, depth + 1));
  if (!isRecord(value)) return false;
  if (typeof value.$ref === 'string' || isRecord(value.$defs) || isRecord(value.definitions)) return true;
  return Object.values(value).some((item) => hasRefs(item, depth + 1));
}

function isPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
