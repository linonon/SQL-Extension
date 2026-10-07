import { ObjectId, Long, Int32, Decimal128, MinKey, MaxKey, Binary, UUID, Timestamp } from 'mongodb';
import { INT64_MAX, INT64_MIN } from './mongo-shell-syntax.js';

// Extended JSON 标记转 BSON 实例. mongosh 写法转 EJSON 文本在 mongo-shell-syntax (宿主 / webview 共用)

// 整数 / 十进制范围与语法约束: 仅校验数值, 不依赖 driver 静默回绕兜底.
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
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
  { key: '$uuid', convert: (v) => new UUID(String(v)) },
  {
    key: '$binary',
    convert: (v) => {
      const o = v as { base64?: unknown; subType?: unknown };
      return new Binary(Buffer.from(String(o.base64 ?? ''), 'base64'), Number(o.subType ?? 0));
    },
  },
  {
    key: '$timestamp',
    convert: (v) => {
      const o = v as { t?: unknown; i?: unknown };
      return new Timestamp({ t: Number(o.t ?? 0), i: Number(o.i ?? 0) });
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
