import { BSON, Decimal128, Double, Int32, Long, ObjectId, type Document } from 'mongodb';

// 文档编辑的写回: 按 dotted path 对比编辑前后, 只写用户改过的字段 ($set / $unset),
// 数值叶子沿用库里原值的 BSON 类型. 输入都是 BSON 值 (EJSON 已经 convertEjsonToBson 还原).

export interface DocumentDiff {
  readonly set: Readonly<Record<string, unknown>>;
  readonly unset: readonly string[];
}

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// 字段名必须能被 dotted path 唯一寻址: 含 '.' 或以 '$' 开头的名字会被 Mongo 解释成别的路径 / operator;
// 原型链名段会在 buildClone 逐段下钻时写到原型上
function pathOf(segments: readonly string[]): string {
  for (const s of segments) {
    if (s === '' || s.includes('.') || s.startsWith('$') || UNSAFE_SEGMENTS.has(s)) {
      throw new Error(`Field name "${s}" cannot be updated by path; change it in mongosh`);
    }
  }
  return segments.join('.');
}

// 子文档 (可递归 diff 的对象); BSON 实例 / Date / RegExp / 数组都是叶子
function isSubDocument(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || '_bsontype' in v) { return false; }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// canonical EJSON 比较: 区分 Int32 / Long / Double, 子文档字段顺序也算 (与 BSON 相等语义一致)
function sameValue(a: unknown, b: unknown): boolean {
  return BSON.EJSON.stringify(a, { relaxed: false }) === BSON.EJSON.stringify(b, { relaxed: false });
}

/** 编辑前后两份文档的差异. 子文档逐字段递归, 数组整体作叶子 (变了就整组 $set). */
export function diffDocuments(before: Record<string, unknown>, after: Record<string, unknown>): DocumentDiff {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const walk = (b: Record<string, unknown>, a: Record<string, unknown>, at: readonly string[]): void => {
    for (const k of Object.keys(b)) {
      if (!Object.hasOwn(a, k)) { unset.push(pathOf([...at, k])); }
    }
    for (const [k, v] of Object.entries(a)) {
      if (!Object.hasOwn(b, k)) {
        set[pathOf([...at, k])] = v;
      } else if (isSubDocument(b[k]) && isSubDocument(v)) {
        walk(b[k] as Record<string, unknown>, v, [...at, k]);
      } else if (!sameValue(b[k], v)) {
        set[pathOf([...at, k])] = v;
      }
    }
  };
  walk(before, after, []);
  return { set, unset };
}

export function isEmptyDiff(diff: DocumentDiff): boolean {
  return Object.keys(diff.set).length === 0 && diff.unset.length === 0;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * 用户输入的裸 number 沿用原值的 BSON 数值类型 (Int32 / Long / Double / Decimal128),
 * 装不下原类型时 (Int32 填小数, Long 超出安全整数) 保留输入值. 数组按下标, 子文档按字段名递归.
 * 显式类型 (NumberLong(..) 等已还原成 BSON 实例) 不是 number, 原样保留.
 */
export function castLike(original: unknown, value: unknown): unknown {
  if (typeof value === 'number') {
    switch ((original as { _bsontype?: string } | null)?._bsontype) {
      case 'Int32': return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX ? new Int32(value) : value;
      case 'Long': return Number.isSafeInteger(value) ? Long.fromNumber(value) : value;
      case 'Double': return new Double(value);
      case 'Decimal128': return Decimal128.fromString(String(value));
      default: return value;
    }
  }
  if (Array.isArray(value) && Array.isArray(original)) {
    return value.map((v, i) => castLike(original[i], v));
  }
  if (isSubDocument(value) && isSubDocument(original)) {
    // null 原型: 字段名恰为 __proto__ 时按普通字段写入 (与 convertEjsonToBson 一致)
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value)) { out[k] = castLike(original[k], v); }
    return out;
  }
  return value;
}

function valueAt(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') { return undefined; }
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** updateOne 的 update 文档. current 是按 _id 重读的库内文档 (promoteValues:false), 只用来取原值类型. */
export function buildUpdate(current: Document, diff: DocumentDiff): Document {
  const update: Document = {};
  const set = Object.entries(diff.set);
  if (set.length > 0) {
    update.$set = Object.fromEntries(set.map(([p, v]) => [p, castLike(valueAt(current, p), v)]));
  }
  if (diff.unset.length > 0) {
    update.$unset = Object.fromEntries(diff.unset.map((p) => [p, '']));
  }
  return update;
}

/**
 * Clone 要插入的文档: 在源文档 (按 _id 重读, promoteValues:false) 上原地套用 diff, 没改到的字段保持原 BSON 类型.
 * 用户没动 _id 时换新 ObjectId; 改了就用用户的; 删了则由 driver 生成.
 */
export function buildClone(source: Document, diff: DocumentDiff): Document {
  for (const p of diff.unset) {
    const segs = p.split('.');
    const last = segs.pop()!;
    const parent = segs.length > 0 ? valueAt(source, segs.join('.')) : source;
    if (parent !== null && typeof parent === 'object') { delete (parent as Record<string, unknown>)[last]; }
  }
  for (const [p, v] of Object.entries(diff.set)) {
    const segs = p.split('.');
    const last = segs.pop()!;
    let cur = source as Record<string, unknown>;
    for (const k of segs) {
      if (cur[k] === null || typeof cur[k] !== 'object') { cur[k] = {}; }
      cur = cur[k] as Record<string, unknown>;
    }
    cur[last] = castLike(cur[last], v);
  }
  const touchesId = [...Object.keys(diff.set), ...diff.unset].some((p) => p === '_id' || p.startsWith('_id.'));
  if (!touchesId) { source._id = new ObjectId(); }
  return source;
}
