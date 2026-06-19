import { describe, it, expect } from 'vitest';
import { tokenizeMongoJson, jsonErrorLine } from './mongo-editor-syntax';

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
