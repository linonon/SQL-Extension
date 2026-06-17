import { describe, it, expect } from 'vitest';
import { coerceValue, buildFilterFromConditions, type Condition } from './mongo-filter-builder';

function c(field: string, op: Condition['op'], value: string): Condition {
  return { field, op, value };
}

describe('coerceValue', () => {
  it('数字 -> number', () => {
    expect(coerceValue('30')).toBe(30);
    expect(coerceValue('-1.5')).toBe(-1.5);
  });
  it('布尔 -> boolean', () => {
    expect(coerceValue('true')).toBe(true);
    expect(coerceValue('false')).toBe(false);
  });
  it('其它 -> string', () => {
    expect(coerceValue('Alice')).toBe('Alice');
    expect(coerceValue('')).toBe('');
  });
  it('前导零 / 0x / 1e 保字符串 (不丢前导零/不误解析) — M4', () => {
    expect(coerceValue('007')).toBe('007');
    expect(coerceValue('0x10')).toBe('0x10');
    expect(coerceValue('1e3')).toBe('1e3');
  });
  it('超安全整数 -> {$numberLong} 不丢精度 — M4', () => {
    expect(coerceValue('9007199254740993')).toEqual({ $numberLong: '9007199254740993' });
  });
  it('普通整数/小数仍转数字', () => {
    expect(coerceValue('42')).toBe(42);
    expect(coerceValue('-1.5')).toBe(-1.5);
  });
});

describe('buildFilterFromConditions', () => {
  it('无有效条件 -> {}', () => {
    expect(buildFilterFromConditions([])).toBe('{}');
    expect(buildFilterFromConditions([c('', '$eq', 'x')])).toBe('{}');
  });

  it('单 $eq 数字', () => {
    expect(buildFilterFromConditions([c('age', '$eq', '30')])).toBe('{"age":30}');
  });

  it('单 $eq 字符串', () => {
    expect(buildFilterFromConditions([c('name', '$eq', 'Alice')])).toBe('{"name":"Alice"}');
  });

  it('比较操作符', () => {
    expect(buildFilterFromConditions([c('age', '$gt', '18')])).toBe('{"age":{"$gt":18}}');
  });

  it('$in 逗号分隔 -> 数组, 各元素按类型推断', () => {
    expect(buildFilterFromConditions([c('status', '$in', 'a, b, 3')]))
      .toBe('{"status":{"$in":["a","b",3]}}');
  });

  it('$regex -> 带 $options:i (contains 语义)', () => {
    expect(buildFilterFromConditions([c('name', '$regex', '^A')]))
      .toBe('{"name":{"$regex":"^A","$options":"i"}}');
  });

  it('$exists -> 布尔', () => {
    expect(buildFilterFromConditions([c('email', '$exists', 'true')]))
      .toBe('{"email":{"$exists":true}}');
  });

  it('多条件 -> $and 数组', () => {
    expect(buildFilterFromConditions([c('age', '$gte', '18'), c('status', '$eq', 'active')]))
      .toBe('{"$and":[{"age":{"$gte":18}},{"status":"active"}]}');
  });

  it('跳过空 field 的行', () => {
    expect(buildFilterFromConditions([c('age', '$gt', '1'), c('', '$eq', 'x')]))
      .toBe('{"age":{"$gt":1}}');
  });
});
