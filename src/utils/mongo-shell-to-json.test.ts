import { describe, it, expect, vi } from 'vitest';

// Mock mongodb, 需要在 import 被测模块之前
vi.mock('mongodb', () => {
  class FakeObjectId {
    private readonly id: string;
    constructor(id: string) { this.id = id; }
    toString() { return this.id; }
  }
  class FakeLong {
    private readonly value: string;
    private constructor(v: string) { this.value = v; }
    static fromString(v: string) { return new FakeLong(v); }
    toString() { return this.value; }
  }
  class FakeInt32 {
    readonly value: number;
    constructor(v: number) { this.value = v; }
  }
  class FakeDecimal128 {
    private readonly value: string;
    constructor(v: string) { this.value = v; }
    toString() { return this.value; }
  }
  class FakeMinKey {}
  class FakeMaxKey {}
  return {
    ObjectId: FakeObjectId,
    Long: FakeLong,
    Int32: FakeInt32,
    Decimal128: FakeDecimal128,
    MinKey: FakeMinKey,
    MaxKey: FakeMaxKey,
  };
});

import { convertShellToJson, convertEjsonToBson, assertValidBson } from './mongo-shell-to-json';
import { ObjectId, Long, Int32, Decimal128, MinKey, MaxKey } from 'mongodb';

describe('convertShellToJson', () => {
  it('ObjectId("...") 转为 {"$oid":"..."}', () => {
    const result = convertShellToJson('ObjectId("abc123456789012345678901")');
    expect(result).toBe('{"$oid":"abc123456789012345678901"}');
  });

  it('ISODate("...") 转为 {"$date":"..."}', () => {
    const result = convertShellToJson('ISODate("2024-01-15T00:00:00.000Z")');
    expect(result).toBe('{"$date":"2024-01-15T00:00:00.000Z"}');
  });

  it('ISODate() 转为当前时间的 {"$date":"..."}', () => {
    const result = convertShellToJson('ISODate()');
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('$date');
    // 验证是合法 ISO 格式
    const date = new Date(parsed.$date);
    expect(date.toISOString()).toBe(parsed.$date);
  });

  it('new Date("...") 转为 {"$date":"..."}', () => {
    const result = convertShellToJson('new Date("2024-01-15")');
    expect(result).toBe('{"$date":"2024-01-15"}');
  });

  it('new Date() 转为当前时间的 {"$date":"..."}', () => {
    const result = convertShellToJson('new Date()');
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('$date');
    const date = new Date(parsed.$date);
    expect(date.toISOString()).toBe(parsed.$date);
  });

  it('NumberLong("12345") 转为 {"$numberLong":"12345"}', () => {
    const result = convertShellToJson('NumberLong("12345")');
    expect(result).toBe('{"$numberLong":"12345"}');
  });

  it('NumberLong(12345) 转为 {"$numberLong":"12345"}', () => {
    const result = convertShellToJson('NumberLong(12345)');
    expect(result).toBe('{"$numberLong":"12345"}');
  });

  it('Long("999") 转为 {"$numberLong":"999"}', () => {
    const result = convertShellToJson('Long("999")');
    expect(result).toBe('{"$numberLong":"999"}');
  });

  it('Long(999) 转为 {"$numberLong":"999"}', () => {
    const result = convertShellToJson('Long(999)');
    expect(result).toBe('{"$numberLong":"999"}');
  });

  it('NumberInt(42) 转为 {"$numberInt":"42"}', () => {
    const result = convertShellToJson('NumberInt(42)');
    expect(result).toBe('{"$numberInt":"42"}');
  });

  it('Int32(42) 转为 {"$numberInt":"42"}', () => {
    const result = convertShellToJson('Int32(42)');
    expect(result).toBe('{"$numberInt":"42"}');
  });

  it('负数 NumberLong / Long / NumberInt / Int32 保留负号', () => {
    expect(convertShellToJson('NumberLong("-5")')).toBe('{"$numberLong":"-5"}');
    expect(convertShellToJson('NumberLong(-5)')).toBe('{"$numberLong":"-5"}');
    expect(convertShellToJson('Long(-7)')).toBe('{"$numberLong":"-7"}');
    expect(convertShellToJson('NumberInt(-5)')).toBe('{"$numberInt":"-5"}');
    expect(convertShellToJson('Int32(-9)')).toBe('{"$numberInt":"-9"}');
  });

  it('NumberDecimal("3.14") 转为 {"$numberDecimal":"3.14"}', () => {
    const result = convertShellToJson('NumberDecimal("3.14")');
    expect(result).toBe('{"$numberDecimal":"3.14"}');
  });

  it('Decimal128("3.14") 转为 {"$numberDecimal":"3.14"}', () => {
    const result = convertShellToJson('Decimal128("3.14")');
    expect(result).toBe('{"$numberDecimal":"3.14"}');
  });

  it('MinKey() 转为 {"$minKey":1}', () => {
    const result = convertShellToJson('MinKey()');
    expect(result).toBe('{"$minKey":1}');
  });

  it('MaxKey() 转为 {"$maxKey":1}', () => {
    const result = convertShellToJson('MaxKey()');
    expect(result).toBe('{"$maxKey":1}');
  });

  it('空字符串输入原样返回', () => {
    expect(convertShellToJson('')).toBe('');
  });

  it('不匹配的文本原样返回', () => {
    expect(convertShellToJson('hello world')).toBe('hello world');
    expect(convertShellToJson('{"name": "test"}')).toBe('{"name": "test"}');
  });

  it('ObjectId 内含空格也能正确解析', () => {
    const result = convertShellToJson('ObjectId(  "abc123456789012345678901"  )');
    expect(result).toBe('{"$oid":"abc123456789012345678901"}');
  });

  it('嵌套在 JSON 对象中正常工作', () => {
    const input = '{"_id": ObjectId("abc123456789012345678901"), "date": ISODate("2024-01-15T00:00:00.000Z")}';
    const result = convertShellToJson(input);
    const parsed = JSON.parse(result);
    expect(parsed._id).toEqual({ $oid: 'abc123456789012345678901' });
    expect(parsed.date).toEqual({ $date: '2024-01-15T00:00:00.000Z' });
  });

  it('数组中包含 shell 类型', () => {
    const input = '[ObjectId("abc123456789012345678901"), NumberLong(42)]';
    const result = convertShellToJson(input);
    const parsed = JSON.parse(result);
    expect(parsed[0]).toEqual({ $oid: 'abc123456789012345678901' });
    expect(parsed[1]).toEqual({ $numberLong: '42' });
  });
});

describe('convertEjsonToBson', () => {
  it('{"$oid":"..."} 转为 ObjectId 实例', () => {
    const result = convertEjsonToBson({ $oid: 'abc123456789012345678901' });
    expect(result).toBeInstanceOf(ObjectId);
  });

  it('{"$date":"..."} 转为 Date 实例', () => {
    const result = convertEjsonToBson({ $date: '2024-01-15T00:00:00.000Z' });
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('拒绝非法 $date, 不静默变 epoch 0 (防御)', () => {
    expect(() => convertEjsonToBson({ $date: '2026-04-07sdT02:56:51.053Z' })).toThrow(/date/i);
  });

  it('拒绝非法 $numberInt / $numberLong (防御)', () => {
    expect(() => convertEjsonToBson({ $numberInt: 'abc' })).toThrow();
    expect(() => convertEjsonToBson({ $numberLong: 'xyz' })).toThrow();
  });

  it('{"$numberLong":"123"} 转为 Long 实例', () => {
    const result = convertEjsonToBson({ $numberLong: '123' });
    expect(result).toBeInstanceOf(Long);
  });

  it('{"$numberInt":"42"} 转为 Int32 实例', () => {
    const result = convertEjsonToBson({ $numberInt: '42' });
    expect(result).toBeInstanceOf(Int32);
  });

  it('{"$numberDecimal":"3.14"} 转为 Decimal128 实例', () => {
    const result = convertEjsonToBson({ $numberDecimal: '3.14' });
    expect(result).toBeInstanceOf(Decimal128);
  });

  it('{"$minKey":1} 转为 MinKey 实例', () => {
    const result = convertEjsonToBson({ $minKey: 1 });
    expect(result).toBeInstanceOf(MinKey);
  });

  it('{"$maxKey":1} 转为 MaxKey 实例', () => {
    const result = convertEjsonToBson({ $maxKey: 1 });
    expect(result).toBeInstanceOf(MaxKey);
  });

  it('递归处理嵌套对象', () => {
    const input = {
      user: {
        createdAt: { $date: '2024-01-15T00:00:00.000Z' },
        score: { $numberLong: '999' },
      },
    };
    const result = convertEjsonToBson(input) as Record<string, Record<string, unknown>>;
    expect(result.user.createdAt).toBeInstanceOf(Date);
    expect(result.user.score).toBeInstanceOf(Long);
  });

  it('原始类型 (string/number/boolean) 原样返回', () => {
    expect(convertEjsonToBson('hello')).toBe('hello');
    expect(convertEjsonToBson(42)).toBe(42);
    expect(convertEjsonToBson(true)).toBe(true);
    expect(convertEjsonToBson(false)).toBe(false);
  });

  it('query operator ($gt, $set) 不被转换', () => {
    // $gt 不在 EJSON_CONVERTERS 中, 单 key 对象不会匹配任何 converter
    const queryWithGt = { $gt: 10 };
    const result = convertEjsonToBson(queryWithGt);
    expect(result).toEqual({ $gt: 10 });

    const setOp = { $set: { name: 'test' } };
    const setResult = convertEjsonToBson(setOp) as Record<string, unknown>;
    expect(setResult.$set).toEqual({ name: 'test' });
  });

  it('混合 query operator 和 EJSON: {"date": {"$gt": {"$date":"..."}}}', () => {
    const input = { date: { $gt: { $date: '2024-01-01T00:00:00.000Z' } } };
    const result = convertEjsonToBson(input) as Record<string, Record<string, unknown>>;
    // $gt 是 query op, 不被转换; 但内层 $date 是单 key EJSON 标记, 会被转换
    expect(result.date.$gt).toBeInstanceOf(Date);
  });

  it('多 key 对象含 $oid 不转换', () => {
    const input = { $oid: 'abc123456789012345678901', extra: 'x' };
    const result = convertEjsonToBson(input) as Record<string, unknown>;
    // 多 key 对象不是 EJSON 标记, 不转换
    expect(result.$oid).toBe('abc123456789012345678901');
    expect(result.extra).toBe('x');
  });

  it('空对象 {} 原样返回', () => {
    expect(convertEjsonToBson({})).toEqual({});
  });

  it('空数组 [] 原样返回', () => {
    expect(convertEjsonToBson([])).toEqual([]);
  });

  it('null 原样返回', () => {
    expect(convertEjsonToBson(null)).toBeNull();
  });

  it('undefined 原样返回', () => {
    expect(convertEjsonToBson(undefined)).toBeUndefined();
  });

  it('数组中的 EJSON 标记也被转换', () => {
    const input = [{ $oid: 'abc123456789012345678901' }, { $date: '2024-01-15T00:00:00.000Z' }];
    const result = convertEjsonToBson(input) as unknown[];
    expect(result[0]).toBeInstanceOf(ObjectId);
    expect(result[1]).toBeInstanceOf(Date);
  });

  it('$numberInt 越界 (超 int32 范围) 抛错, 不静默回绕', () => {
    expect(() => convertEjsonToBson({ $numberInt: '2147483648' })).toThrow(/int32|范围|range/i);
    expect(() => convertEjsonToBson({ $numberInt: '-2147483649' })).toThrow();
    expect(() => convertEjsonToBson({ $numberInt: '9999999999' })).toThrow();
    // 边界内正常
    expect(convertEjsonToBson({ $numberInt: '2147483647' })).toBeInstanceOf(Int32);
    expect(convertEjsonToBson({ $numberInt: '-2147483648' })).toBeInstanceOf(Int32);
  });

  it('$numberLong 越界 (超 int64 范围) 抛错, 不静默回绕/翻转符号', () => {
    expect(() => convertEjsonToBson({ $numberLong: '9223372036854775808' })).toThrow(/int64|范围|range/i);
    expect(() => convertEjsonToBson({ $numberLong: '-9223372036854775809' })).toThrow();
    expect(() => convertEjsonToBson({ $numberLong: '18446744073709551616' })).toThrow();
    // 边界内正常
    expect(convertEjsonToBson({ $numberLong: '9223372036854775807' })).toBeInstanceOf(Long);
    expect(convertEjsonToBson({ $numberLong: '-9223372036854775808' })).toBeInstanceOf(Long);
  });

  it('$numberDecimal 拒绝非十进制语法 (0x / 空白), 接受合法值含 Infinity', () => {
    expect(() => convertEjsonToBson({ $numberDecimal: '0x10' })).toThrow();
    expect(() => convertEjsonToBson({ $numberDecimal: '   ' })).toThrow();
    expect(() => convertEjsonToBson({ $numberDecimal: 'abc' })).toThrow();
    expect(convertEjsonToBson({ $numberDecimal: '3.14' })).toBeInstanceOf(Decimal128);
    expect(convertEjsonToBson({ $numberDecimal: '1e10' })).toBeInstanceOf(Decimal128);
    expect(convertEjsonToBson({ $numberDecimal: 'Infinity' })).toBeInstanceOf(Decimal128);
  });

  it('用户字段名 __proto__ 不污染原型, 作为自有数据保留 (H4)', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"name":"alice"}');
    const result = convertEjsonToBson(input) as Record<string, unknown>;
    // 无全局原型污染
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // __proto__ 字段作为自有 key 保留, 而非被静默丢弃
    expect(Object.keys(result).sort()).toEqual(['__proto__', 'name']);
    expect(result.name).toBe('alice');
  });
});

describe('assertValidBson (import 路径值校验)', () => {
  it('非法 Date (Invalid Date) 抛错, 阻止静默写 epoch 0', () => {
    expect(() => assertValidBson({ createdAt: new Date('2026-13-99') })).toThrow(/date|日期/i);
    expect(() => assertValidBson([{ d: new Date(NaN) }])).toThrow();
    expect(() => assertValidBson({ nested: { deep: { d: new Date('garbage') } } })).toThrow();
  });

  it('合法文档通过 (含合法 Date / 嵌套 / 数组)', () => {
    expect(() => assertValidBson({ createdAt: new Date('2024-01-15T00:00:00.000Z') })).not.toThrow();
    expect(() => assertValidBson([{ a: 1 }, { b: 'x', c: [1, 2, { d: new Date() }] }])).not.toThrow();
    expect(() => assertValidBson({ x: null, y: undefined, z: true })).not.toThrow();
  });
});
