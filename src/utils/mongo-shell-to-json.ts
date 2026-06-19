import { ObjectId, Long, Int32, Decimal128, MinKey, MaxKey } from 'mongodb';

// --- MongoDB shell 语法转 Extended JSON ---

const SHELL_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replace: (...args: string[]) => string;
}> = [
  {
    pattern: /ObjectId\(\s*"([0-9a-fA-F]{24})"\s*\)/g,
    replace: (_, id) => `{"$oid":"${id}"}`,
  },
  {
    pattern: /ISODate\(\s*"([^"]+)"\s*\)/g,
    replace: (_, iso) => `{"$date":"${iso}"}`,
  },
  {
    pattern: /ISODate\(\s*\)/g,
    replace: () => `{"$date":"${new Date().toISOString()}"}`,
  },
  {
    pattern: /new\s+Date\(\s*"([^"]+)"\s*\)/g,
    replace: (_, iso) => `{"$date":"${iso}"}`,
  },
  {
    pattern: /new\s+Date\(\s*\)/g,
    replace: () => `{"$date":"${new Date().toISOString()}"}`,
  },
  {
    pattern: /NumberLong\(\s*"(-?\d+)"\s*\)/g,
    replace: (_, n) => `{"$numberLong":"${n}"}`,
  },
  {
    pattern: /NumberLong\(\s*(-?\d+)\s*\)/g,
    replace: (_, n) => `{"$numberLong":"${n}"}`,
  },
  {
    pattern: /Long\(\s*"(-?\d+)"\s*\)/g,
    replace: (_, n) => `{"$numberLong":"${n}"}`,
  },
  {
    pattern: /Long\(\s*(-?\d+)\s*\)/g,
    replace: (_, n) => `{"$numberLong":"${n}"}`,
  },
  {
    pattern: /NumberInt\(\s*(-?\d+)\s*\)/g,
    replace: (_, n) => `{"$numberInt":"${n}"}`,
  },
  {
    pattern: /Int32\(\s*(-?\d+)\s*\)/g,
    replace: (_, n) => `{"$numberInt":"${n}"}`,
  },
  {
    pattern: /NumberDecimal\(\s*"([^"]+)"\s*\)/g,
    replace: (_, n) => `{"$numberDecimal":"${n}"}`,
  },
  {
    pattern: /Decimal128\(\s*"([^"]+)"\s*\)/g,
    replace: (_, n) => `{"$numberDecimal":"${n}"}`,
  },
  {
    pattern: /MinKey\(\s*\)/g,
    replace: () => '{"$minKey":1}',
  },
  {
    pattern: /MaxKey\(\s*\)/g,
    replace: () => '{"$maxKey":1}',
  },
];

/**
 * 将 MongoDB shell 语法转换为 Extended JSON 格式.
 * 例如 ObjectId("abc...") -> {"$oid":"abc..."}
 */
export function convertShellToJson(input: string): string {
  let result = input;
  for (const { pattern, replace } of SHELL_PATTERNS) {
    result = result.replace(pattern, replace as (...args: string[]) => string);
  }
  return result;
}

// --- Extended JSON 标记转 BSON 实例 ---

// 整数 / 十进制范围与语法约束: 仅校验数值, 不依赖 driver 静默回绕兜底.
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
// Decimal128 字面量语法: 有限十进制 (可带指数), 或 Infinity / NaN.
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function assertInt32Range(s: string): void {
  const n = Number(s);
  if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) {
    throw new Error(`$numberInt out of int32 range: ${s}`);
  }
}

function assertInt64Range(s: string): void {
  let big: bigint;
  try { big = BigInt(s); } catch { throw new Error(`Invalid $numberLong value: ${s}`); }
  if (big < INT64_MIN || big > INT64_MAX) {
    throw new Error(`$numberLong out of int64 range: ${s}`);
  }
}

// 防御: 非法值显式抛错, 避免静默落库 (如非法日期 new Date(NaN) 被存成 epoch 0,
// 越界整数被 Long.fromString / Int32 回绕成另一个数).
const EJSON_CONVERTERS: ReadonlyArray<{
  readonly key: string;
  readonly convert: (value: unknown) => unknown;
}> = [
  { key: '$oid', convert: (v) => new ObjectId(v as string) },
  {
    key: '$date',
    convert: (v) => {
      const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
      if (Number.isNaN(d.getTime())) { throw new Error(`Invalid $date value: ${String(v)}`); }
      return d;
    },
  },
  {
    key: '$numberLong',
    convert: (v) => {
      const s = String(v);
      if (!/^-?\d+$/.test(s)) { throw new Error(`Invalid $numberLong value: ${s}`); }
      assertInt64Range(s);
      return Long.fromString(s);
    },
  },
  {
    key: '$numberInt',
    convert: (v) => {
      const s = String(v);
      if (!/^-?\d+$/.test(s)) { throw new Error(`Invalid $numberInt value: ${s}`); }
      assertInt32Range(s);
      return new Int32(Number(s));
    },
  },
  {
    key: '$numberDecimal',
    convert: (v) => {
      const s = String(v).trim();
      if (!(DECIMAL_RE.test(s) || /^[+-]?Infinity$/i.test(s) || /^NaN$/i.test(s))) {
        throw new Error(`Invalid $numberDecimal value: ${String(v)}`);
      }
      return new Decimal128(s);
    },
  },
  { key: '$minKey', convert: () => new MinKey() },
  { key: '$maxKey', convert: () => new MaxKey() },
];

/**
 * 递归将 Extended JSON 标记 ($oid, $date 等) 转换为 BSON 类型实例.
 * query operator (如 $gt, $in) 不受影响.
 */
export function convertEjsonToBson(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(convertEjsonToBson);

  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);

  // 单 key 对象才可能是 EJSON 标记
  if (keys.length === 1) {
    for (const { key, convert } of EJSON_CONVERTERS) {
      if (key in record) {
        return convert(record[key]);
      }
    }
  }

  // 递归处理所有 value. result 用 null 原型: 用户字段名恰为 __proto__ 时按自有数据写入,
  // 而非触发原型 setter 导致该字段被静默丢弃 (普通 {} 上 result['__proto__']=obj 会改原型).
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    result[key] = convertEjsonToBson(value);
  }
  return result;
}

/**
 * 校验已是 BSON 实例的文档/值 (import 路径经 EJSON.parse 得到, 不走 convertEjsonToBson),
 * 发现非法值即抛错, 阻止静默写库. 当前覆盖 Invalid Date (否则会落成 epoch 0).
 * EJSON.parse 对 $oid/$numberLong 等已会抛错, 仅 $date 静默产出 Invalid Date.
 */
export function assertValidBson(value: unknown): void {
  if (value === null || value === undefined) { return; }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) { throw new Error(`Invalid date value in document: ${String(value)}`); }
    return;
  }
  if (Array.isArray(value)) {
    for (const x of value) { assertValidBson(x); }
    return;
  }
  if (typeof value === 'object') {
    // BSON 实例 (ObjectId/Long/Decimal128 等) 合法性由 EJSON.parse 保证, 不递归其内部
    if ('_bsontype' in (value as Record<string, unknown>)) { return; }
    for (const v of Object.values(value as Record<string, unknown>)) { assertValidBson(v); }
  }
}
