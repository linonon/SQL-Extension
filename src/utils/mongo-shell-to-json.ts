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

const EJSON_CONVERTERS: ReadonlyArray<{
  readonly key: string;
  readonly convert: (value: unknown) => unknown;
}> = [
  { key: '$oid', convert: (v) => new ObjectId(v as string) },
  { key: '$date', convert: (v) => new Date(v as string) },
  { key: '$numberLong', convert: (v) => Long.fromString(String(v)) },
  { key: '$numberInt', convert: (v) => new Int32(Number(v)) },
  { key: '$numberDecimal', convert: (v) => new Decimal128(String(v)) },
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

  // 递归处理所有 value
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = convertEjsonToBson(value);
  }
  return result;
}
