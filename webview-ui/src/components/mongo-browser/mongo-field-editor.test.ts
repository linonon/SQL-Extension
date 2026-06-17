import { describe, it, expect } from 'vitest';
import { isEditableLeaf, coerceToType, convertTags, documentToFields } from './mongo-field-editor';

describe('isEditableLeaf', () => {
  it('标量 string/number/boolean 可编辑', () => {
    expect(isEditableLeaf('Alice')).toBe(true);
    expect(isEditableLeaf(5)).toBe(true);
    expect(isEditableLeaf(true)).toBe(true);
  });
  it('shell-tag / object / array / null 只读', () => {
    expect(isEditableLeaf('ObjectId("507f1f77bcf86cd799439011")')).toBe(false);
    expect(isEditableLeaf({ a: 1 })).toBe(false);
    expect(isEditableLeaf([1, 2])).toBe(false);
    expect(isEditableLeaf(null)).toBe(false);
  });
});

describe('coerceToType', () => {
  it('按原值类型转换', () => {
    expect(coerceToType(5, '42')).toBe(42);
    expect(coerceToType(true, 'false')).toBe(false);
    expect(coerceToType('x', '30')).toBe('30'); // 原是字符串 -> 保持字符串
  });
  it('数字非法文本回退原值', () => {
    expect(coerceToType(5, 'abc')).toBe(5);
  });
});

describe('documentToFields', () => {
  it('展开顶层字段, 排除 _id, 标记可编辑性', () => {
    const fields = documentToFields({
      _id: 'ObjectId("507f1f77bcf86cd799439011")',
      name: 'Alice',
      ref: 'ObjectId("aabbccddeeff001122334455")',
      tags: ['a', 'b'],
    });
    expect(fields.map((f) => f.key)).toEqual(['name', 'ref', 'tags']);
    expect(fields.find((f) => f.key === 'name')!.editable).toBe(true);
    expect(fields.find((f) => f.key === 'ref')!.editable).toBe(false);
    expect(fields.find((f) => f.key === 'tags')!.editable).toBe(false);
  });
});

describe('convertTags (按叶子, 仅转真 shell-tag)', () => {
  it('真 shell-tag 叶子转 EJSON', () => {
    expect(convertTags('ObjectId("507f1f77bcf86cd799439011")')).toEqual({ $oid: '507f1f77bcf86cd799439011' });
  });
  it('标量原样', () => {
    expect(convertTags(5)).toBe(5);
    expect(convertTags('Alice')).toBe('Alice');
    expect(convertTags(true)).toBe(true);
  });
  it('形似 tag 但非法的字符串保持字符串 (不崩溃/不误转) — C2', () => {
    expect(convertTags('ObjectId("xyz")')).toBe('ObjectId("xyz")');
  });
  it('负数 Long / Int 正确转 EJSON — C1', () => {
    expect(convertTags('NumberInt(-5)')).toEqual({ $numberInt: '-5' });
    expect(convertTags('NumberLong("-5")')).toEqual({ $numberLong: '-5' });
  });
  it('递归嵌套结构', () => {
    expect(convertTags({ a: { b: 'ISODate("2024-01-01T00:00:00.000Z")' } }))
      .toEqual({ a: { b: { $date: '2024-01-01T00:00:00.000Z' } } });
    expect(convertTags(['ObjectId("507f1f77bcf86cd799439011")', 'plain']))
      .toEqual([{ $oid: '507f1f77bcf86cd799439011' }, 'plain']);
  });
});
