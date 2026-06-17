import { describe, it, expect } from 'vitest';
import { detectLeafType } from './mongo-leaf-type';

describe('detectLeafType', () => {
  it('识别 shell-tag 字符串', () => {
    expect(detectLeafType('ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")')).toBe('ObjectId');
    expect(detectLeafType('ISODate("2020-05-11T02:56:02.131Z")')).toBe('Date');
    expect(detectLeafType('NumberLong("14")')).toBe('Long');
    expect(detectLeafType('NumberDecimal("1.5")')).toBe('Decimal128');
  });

  it('负数 Long / Int 仍识别 (与还原正则对齐)', () => {
    expect(detectLeafType('NumberLong("-5")')).toBe('Long');
    expect(detectLeafType('NumberInt(-5)')).toBe('Int');
  });

  it('形似 tag 但内容非法的字符串归为 string (避免误转/崩溃)', () => {
    expect(detectLeafType('ObjectId("xyz")')).toBe('string'); // 非 24-hex
    expect(detectLeafType('NumberInt(abc)')).toBe('string');
    expect(detectLeafType('ISODate("")')).toBe('string'); // 空参 (convertShellToJson 无法还原) - round2 LOW
    expect(detectLeafType('NumberDecimal("")')).toBe('string');
  });

  it('普通字符串/数字/布尔/null 归类', () => {
    expect(detectLeafType('hello')).toBe('string');
    expect(detectLeafType(42)).toBe('number');
    expect(detectLeafType(true)).toBe('boolean');
    expect(detectLeafType(null)).toBe('null');
  });
});
