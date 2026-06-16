import { describe, it, expect } from 'vitest';
import { detectLeafType } from './mongo-leaf-type';

describe('detectLeafType', () => {
  it('识别 shell-tag 字符串', () => {
    expect(detectLeafType('ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")')).toBe('ObjectId');
    expect(detectLeafType('ISODate("2020-05-11T02:56:02.131Z")')).toBe('Date');
    expect(detectLeafType('NumberLong("14")')).toBe('Long');
    expect(detectLeafType('NumberDecimal("1.5")')).toBe('Decimal128');
  });

  it('普通字符串/数字/布尔/null 归类', () => {
    expect(detectLeafType('hello')).toBe('string');
    expect(detectLeafType(42)).toBe('number');
    expect(detectLeafType(true)).toBe('boolean');
    expect(detectLeafType(null)).toBe('null');
  });
});
