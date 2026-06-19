import { describe, it, expect } from 'vitest';
import { tokenizeMongoJson, jsonErrorLine, validateEjsonValues, lineOfIndex } from './mongo-editor-syntax';

describe('tokenizeMongoJson', () => {
  it('字符保真: 拼接所有 token === 原文', () => {
    const t = '{\n  "a": ObjectId("507f1f77bcf86cd799439011"),\n  "n": -3.5,\n  "ok": true\n}';
    expect(tokenizeMongoJson(t).map((x) => x.text).join('')).toBe(t);
  });

  it('区分 key 与 string', () => {
    const toks = tokenizeMongoJson('{"name": "bob"}');
    expect(toks.find((t) => t.text === '"name"')!.type).toBe('key');
    expect(toks.find((t) => t.text === '"bob"')!.type).toBe('string');
  });

  it('number / keyword / bson / punct 分类', () => {
    expect(tokenizeMongoJson('-42')[0]).toEqual({ text: '-42', type: 'number' });
    expect(tokenizeMongoJson('-3.5e2')[0]).toEqual({ text: '-3.5e2', type: 'number' });
    expect(tokenizeMongoJson('true')[0].type).toBe('keyword');
    expect(tokenizeMongoJson('null')[0].type).toBe('keyword');
    expect(tokenizeMongoJson('ObjectId')[0].type).toBe('bson');
    expect(tokenizeMongoJson('ISODate')[0].type).toBe('bson');
    expect(tokenizeMongoJson('NumberLong')[0].type).toBe('bson');
    expect(tokenizeMongoJson('UUID')[0].type).toBe('bson');
    expect(tokenizeMongoJson('BinData')[0].type).toBe('bson');
    expect(tokenizeMongoJson('Timestamp')[0].type).toBe('bson');
    expect(tokenizeMongoJson('{')[0].type).toBe('punct');
    expect(tokenizeMongoJson(',')[0].type).toBe('punct');
  });

  it('普通标识符 (非 BSON/keyword) -> plain', () => {
    expect(tokenizeMongoJson('foo')[0].type).toBe('plain');
  });

  it('转义引号的字符串完整成一个 token', () => {
    expect(tokenizeMongoJson('"a\\"b"')[0]).toEqual({ text: '"a\\"b"', type: 'string' });
  });

  it('裸减号 (非数字) 不误判为 number', () => {
    const toks = tokenizeMongoJson('- 1');
    expect(toks[0].type).not.toBe('number');
  });
});

describe('validateEjsonValues', () => {
  it('合法 EJSON 值 -> null', () => {
    expect(validateEjsonValues({
      a: { $date: '2026-04-07T02:56:51.053Z' },
      b: { $oid: '507f1f77bcf86cd799439011' },
      c: { $numberLong: '-42' },
    })).toBeNull();
  });
  it('非法日期 -> 报告 (含原值)', () => {
    const p = validateEjsonValues({ updatedAt: { $date: '2026-04-07sdT02:56:51.053Z' } });
    expect(p).not.toBeNull();
    expect(p!.value).toBe('2026-04-07sdT02:56:51.053Z');
    expect(p!.message).toMatch(/日期|date/i);
  });
  it('非法 ObjectId / 整数 / decimal', () => {
    expect(validateEjsonValues({ x: { $oid: 'xyz' } })).not.toBeNull();
    expect(validateEjsonValues({ x: { $numberLong: 'abc' } })).not.toBeNull();
    expect(validateEjsonValues({ x: { $numberDecimal: 'nope' } })).not.toBeNull();
  });
  it('嵌套 / 数组内也检查', () => {
    expect(validateEjsonValues({ arr: [{ $date: 'nope' }] })).not.toBeNull();
  });
  it('整数越界 (int32 / int64) 报告, 不静默回绕 — H1', () => {
    expect(validateEjsonValues({ x: { $numberInt: '2147483648' } })).not.toBeNull();
    expect(validateEjsonValues({ x: { $numberInt: '2147483647' } })).toBeNull();
    expect(validateEjsonValues({ x: { $numberLong: '9223372036854775808' } })).not.toBeNull();
    expect(validateEjsonValues({ x: { $numberLong: '9223372036854775807' } })).toBeNull();
  });
  it('EJSON 标记与兄弟字段共存 -> 畸形 wrapper 报告 — H5', () => {
    expect(validateEjsonValues({ x: { $date: '2024-01-01T00:00:00.000Z', extra: 1 } })).not.toBeNull();
    expect(validateEjsonValues({ x: { $oid: '507f1f77bcf86cd799439011', y: 2 } })).not.toBeNull();
    // 纯 query operator 多 key (无 EJSON 标记) 不误报
    expect(validateEjsonValues({ x: { $gt: 1, $lt: 5 } })).toBeNull();
  });
  it('$numberDecimal 严格语法: 拒 0x, 接受合法 — L3', () => {
    expect(validateEjsonValues({ x: { $numberDecimal: '0x10' } })).not.toBeNull();
    expect(validateEjsonValues({ x: { $numberDecimal: '1.5' } })).toBeNull();
    expect(validateEjsonValues({ x: { $numberDecimal: '1e10' } })).toBeNull();
  });
  it('$uuid 非法格式报告', () => {
    expect(validateEjsonValues({ x: { $uuid: 'not-a-uuid' } })).not.toBeNull();
    expect(validateEjsonValues({ x: { $uuid: 'b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a' } })).toBeNull();
  });
});

describe('lineOfIndex', () => {
  it('按 \\n 计数返回 1-based 行号', () => {
    expect(lineOfIndex('a\nbX\nc', 3)).toBe(2);
    expect(lineOfIndex('abc', 0)).toBe(1);
  });
});

describe('jsonErrorLine', () => {
  it('从 position 映射到行号', () => {
    expect(jsonErrorLine('a\nb\nc', 'Unexpected token at position 3')).toBe(2);
  });
  it('优先用 message 里的 line', () => {
    expect(jsonErrorLine('x', 'bad at line 5 column 2')).toBe(5);
  });
  it('无定位信息返回 null', () => {
    expect(jsonErrorLine('x', 'Invalid JSON')).toBeNull();
    expect(jsonErrorLine('x', '')).toBeNull();
  });
});
