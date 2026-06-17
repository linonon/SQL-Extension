import { describe, it, expect } from 'vitest';
import {
  getMongoAutocompleteContext,
  getMongoCompletionItems,
  type MongoAutocompleteContext,
} from './mongo-autocomplete';

describe('getMongoAutocompleteContext', () => {
  it('{ 后空格应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ ', 2);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it('{ "st 应触发 field 补全并带 prefix', () => {
    const ctx = getMongoAutocompleteContext('{ "st', 5);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('st');
  });

  it('逗号后应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "name": "x", ', 16);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it('逗号后带 prefix 应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "name": "x", "ag', 19);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('ag');
  });

  it('$ 应触发 operator 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "age": { $', 13);
    expect(ctx.triggerType).toBe('operator');
    expect(ctx.prefix).toBe('$');
  });

  it('$g 应触发 operator 补全并带 prefix', () => {
    const ctx = getMongoAutocompleteContext('{ "age": { $g', 14);
    expect(ctx.triggerType).toBe('operator');
    expect(ctx.prefix).toBe('$g');
  });

  it('字符串值内不应触发补全', () => {
    const ctx = getMongoAutocompleteContext('{ "name": "sta', 15);
    expect(ctx.triggerType).toBe(null);
  });

  it('空字符串不应触发补全', () => {
    const ctx = getMongoAutocompleteContext('', 0);
    expect(ctx.triggerType).toBe(null);
  });

  it('value 位置不应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "name": ', 11);
    expect(ctx.triggerType).toBe(null);
  });

  it('嵌套 object 的 key 位置应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "address": { "ci', 19);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('ci');
  });

  it('{" 紧跟双引号应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{"', 2);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it('{ " 空格后双引号应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "', 3);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it("{' 紧跟单引号应触发 field 补全", () => {
    const ctx = getMongoAutocompleteContext("{'", 2);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it("{ ' 空格后单引号应触发 field 补全", () => {
    const ctx = getMongoAutocompleteContext("{ '", 3);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it("{'na 单引号内输入应触发 field 补全并带 prefix", () => {
    const ctx = getMongoAutocompleteContext("{ 'na", 5);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('na');
  });

  it('转义引号不影响字符串检测', () => {
    const ctx = getMongoAutocompleteContext('{ "name": "he\\"llo", ', 22);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it('冒号后的 $ 应触发 operator 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "age": $', 11);
    expect(ctx.triggerType).toBe('operator');
    expect(ctx.prefix).toBe('$');
  });

  it('单独的 { 后 $ 应触发 operator 补全 (顶层 $and/$or)', () => {
    const ctx = getMongoAutocompleteContext('{ $', 3);
    expect(ctx.triggerType).toBe('operator');
    expect(ctx.prefix).toBe('$');
  });

  it('嵌套 object 内 key 位置的 $ 应触发 operator 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "a": { "$', 12);
    expect(ctx.triggerType).toBe('operator');
    expect(ctx.prefix).toBe('$');
  });

  it('$and 数组内 object 的 key 位置应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "$and": [ { "age": 5 }, { ', 29);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it('数组内裸位置不应触发 field 补全', () => {
    const ctx = getMongoAutocompleteContext('{ "$in": [ ', 12);
    expect(ctx.triggerType).toBe(null);
  });

  it('双重反斜杠后引号应正确判断字符串结束', () => {
    // "foo\\" 中 \\\\ 是两个反斜杠, 最后的 " 不是转义的
    const ctx = getMongoAutocompleteContext('{ "name": "foo\\\\", ', 20);
    expect(ctx.triggerType).toBe('field');
    expect(ctx.prefix).toBe('');
  });

  it('空 fieldNames 时 field 补全返回空数组', () => {
    const ctx = getMongoAutocompleteContext('{ ', 2);
    expect(ctx.triggerType).toBe('field');
    const items = getMongoCompletionItems(ctx, []);
    expect(items).toEqual([]);
  });
});

describe('getMongoCompletionItems', () => {
  const fields = ['name', 'age', 'email', 'address'];

  it('field + prefix 应过滤匹配的字段', () => {
    const ctx: MongoAutocompleteContext = { triggerType: 'field', prefix: 'na' };
    const items = getMongoCompletionItems(ctx, fields);
    expect(items).toEqual(['name']);
  });

  it('field 无 prefix 应返回所有字段', () => {
    const ctx: MongoAutocompleteContext = { triggerType: 'field', prefix: '' };
    const items = getMongoCompletionItems(ctx, fields);
    expect(items).toEqual(['name', 'age', 'email', 'address']);
  });

  it('operator + prefix 应过滤匹配的操作符', () => {
    const ctx: MongoAutocompleteContext = { triggerType: 'operator', prefix: '$gt' };
    const items = getMongoCompletionItems(ctx, fields);
    expect(items).toEqual(['$gt', '$gte']);
  });

  it('operator 只有 $ 应返回所有操作符', () => {
    const ctx: MongoAutocompleteContext = { triggerType: 'operator', prefix: '$' };
    const items = getMongoCompletionItems(ctx, fields);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((op) => op.startsWith('$'))).toBe(true);
  });

  it('补全集合含常用查询操作符 ($mod/$expr/$text/$options)', () => {
    const ctx: MongoAutocompleteContext = { triggerType: 'operator', prefix: '$' };
    const items = getMongoCompletionItems(ctx, fields);
    for (const op of ['$mod', '$expr', '$text', '$options', '$elemMatch', '$regex']) {
      expect(items).toContain(op);
    }
  });

  it('null triggerType 应返回空数组', () => {
    const ctx: MongoAutocompleteContext = { triggerType: null, prefix: '' };
    const items = getMongoCompletionItems(ctx, fields);
    expect(items).toEqual([]);
  });

  it('无匹配 field 应返回空数组', () => {
    const ctx: MongoAutocompleteContext = { triggerType: 'field', prefix: 'zzz' };
    const items = getMongoCompletionItems(ctx, fields);
    expect(items).toEqual([]);
  });

  it('field 匹配应该大小写不敏感', () => {
    const ctx: MongoAutocompleteContext = { triggerType: 'field', prefix: 'Na' };
    const items = getMongoCompletionItems(ctx, fields);
    expect(items).toEqual(['name']);
  });
});
