import { describe, it, expect, vi } from 'vitest';
import { convertShellToJson, stripShellTypes, jsonToShell } from './mongo-shell-to-json';

describe('convertShellToJson', () => {
  it('ObjectId -> $oid Extended JSON', () => {
    expect(convertShellToJson('ObjectId("abc123456789012345678901")'))
      .toBe('{"$oid":"abc123456789012345678901"}');
  });

  it('ISODate with value -> $date Extended JSON', () => {
    expect(convertShellToJson('ISODate("2024-01-15T00:00:00.000Z")'))
      .toBe('{"$date":"2024-01-15T00:00:00.000Z"}');
  });

  it('ISODate() without arg -> $date with current timestamp', () => {
    const fakeNow = '2026-02-18T00:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fakeNow));
    const result = convertShellToJson('ISODate()');
    expect(result).toBe(`{"$date":"${fakeNow}"}`);
    vi.useRealTimers();
  });

  it('NumberLong with quoted arg -> $numberLong', () => {
    expect(convertShellToJson('NumberLong("123")'))
      .toBe('{"$numberLong":"123"}');
  });

  it('NumberLong with unquoted arg -> $numberLong', () => {
    expect(convertShellToJson('NumberLong(123)'))
      .toBe('{"$numberLong":"123"}');
  });

  it('NumberInt -> $numberInt', () => {
    expect(convertShellToJson('NumberInt(42)'))
      .toBe('{"$numberInt":"42"}');
  });

  it('负数 NumberLong / NumberInt 保留负号', () => {
    expect(convertShellToJson('NumberLong("-5")')).toBe('{"$numberLong":"-5"}');
    expect(convertShellToJson('NumberLong(-5)')).toBe('{"$numberLong":"-5"}');
    expect(convertShellToJson('NumberInt(-5)')).toBe('{"$numberInt":"-5"}');
  });

  it('NumberDecimal -> $numberDecimal', () => {
    expect(convertShellToJson('NumberDecimal("3.14")'))
      .toBe('{"$numberDecimal":"3.14"}');
  });

  it('Long/Int32/Decimal128 别名 (与后端对齐) — M1', () => {
    expect(convertShellToJson('Long(999)')).toBe('{"$numberLong":"999"}');
    expect(convertShellToJson('Long("999")')).toBe('{"$numberLong":"999"}');
    expect(convertShellToJson('Int32(42)')).toBe('{"$numberInt":"42"}');
    expect(convertShellToJson('Decimal128("3.14")')).toBe('{"$numberDecimal":"3.14"}');
  });

  it('UUID/BinData/Timestamp -> EJSON (与后端对齐) — H3', () => {
    expect(convertShellToJson('UUID("b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a")'))
      .toBe('{"$uuid":"b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a"}');
    expect(convertShellToJson('BinData(0,"AQIDBA==")'))
      .toBe('{"$binary":{"base64":"AQIDBA==","subType":0}}');
    expect(convertShellToJson('Timestamp(1700000000,5)'))
      .toBe('{"$timestamp":{"t":1700000000,"i":5}}');
  });

  it('MinKey() -> $minKey', () => {
    expect(convertShellToJson('MinKey()'))
      .toBe('{"$minKey":1}');
  });

  it('MaxKey() -> $maxKey', () => {
    expect(convertShellToJson('MaxKey()'))
      .toBe('{"$maxKey":1}');
  });

  it('new Date with value -> $date Extended JSON', () => {
    expect(convertShellToJson('new Date("2024-01-15T00:00:00.000Z")'))
      .toBe('{"$date":"2024-01-15T00:00:00.000Z"}');
  });

  it('new Date() without arg -> $date with current timestamp', () => {
    const fakeNow = '2026-02-18T00:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fakeNow));
    const result = convertShellToJson('new Date()');
    expect(result).toBe(`{"$date":"${fakeNow}"}`);
    vi.useRealTimers();
  });

  it('空输入 -> 空字符串', () => {
    expect(convertShellToJson('')).toBe('');
  });

  it('普通字符串原样返回', () => {
    expect(convertShellToJson('hello world')).toBe('hello world');
  });

  it('嵌套多类型混合文档', () => {
    const input = '{ "_id": ObjectId("aabbccddeeff00112233aabb"), "count": NumberInt(5), "date": ISODate("2024-01-15T00:00:00.000Z"), "big": NumberLong("999") }';
    const result = convertShellToJson(input);
    expect(result).toContain('{"$oid":"aabbccddeeff00112233aabb"}');
    expect(result).toContain('{"$numberInt":"5"}');
    expect(result).toContain('{"$date":"2024-01-15T00:00:00.000Z"}');
    expect(result).toContain('{"$numberLong":"999"}');
  });
});

describe('stripShellTypes', () => {
  it('ObjectId -> 引号包裹的纯值', () => {
    expect(stripShellTypes('ObjectId("abc")')).toBe('"abc"');
  });

  it('ISODate -> 引号包裹的纯值', () => {
    expect(stripShellTypes('ISODate("2024-01-15T00:00:00.000Z")'))
      .toBe('"2024-01-15T00:00:00.000Z"');
  });

  it('NumberLong quoted -> 数字', () => {
    expect(stripShellTypes('NumberLong("123")')).toBe('123');
  });

  it('NumberLong unquoted -> 数字', () => {
    expect(stripShellTypes('NumberLong(42)')).toBe('42');
  });

  it('NumberInt -> 数字', () => {
    expect(stripShellTypes('NumberInt(42)')).toBe('42');
  });

  it('NumberDecimal -> 数字', () => {
    expect(stripShellTypes('NumberDecimal("3.14")')).toBe('3.14');
  });

  it('MinKey -> null', () => {
    expect(stripShellTypes('MinKey()')).toBe('null');
  });

  it('MaxKey -> null', () => {
    expect(stripShellTypes('MaxKey()')).toBe('null');
  });

  it('纯 JSON 无 shell 类型 -> 原样', () => {
    const input = '{"name": "test", "age": 25}';
    expect(stripShellTypes(input)).toBe(input);
  });

  it('混合类型文档', () => {
    const input = '{"_id": ObjectId("aabbccddeeff00112233aabb"), "date": ISODate("2024-01-15"), "count": NumberInt(5)}';
    const result = stripShellTypes(input);
    expect(result).toBe('{"_id": "aabbccddeeff00112233aabb", "date": "2024-01-15", "count": 5}');
  });
});

describe('jsonToShell', () => {
  it('还原 ObjectId', () => {
    const jsonStr = '"ObjectId(\\"abc123456789012345678901\\")"';
    expect(jsonToShell(jsonStr)).toBe('ObjectId("abc123456789012345678901")');
  });

  it('还原 ISODate', () => {
    const jsonStr = '"ISODate(\\"2024-01-15T00:00:00.000Z\\")"';
    expect(jsonToShell(jsonStr)).toBe('ISODate("2024-01-15T00:00:00.000Z")');
  });

  it('还原 NumberLong', () => {
    const jsonStr = '"NumberLong(\\"123\\")"';
    expect(jsonToShell(jsonStr)).toBe('NumberLong("123")');
  });

  it('还原 NumberInt', () => {
    const jsonStr = '"NumberInt(42)"';
    expect(jsonToShell(jsonStr)).toBe('NumberInt(42)');
  });

  it('还原负数 NumberLong / NumberInt', () => {
    expect(jsonToShell('"NumberLong(\\"-5\\")"')).toBe('NumberLong("-5")');
    expect(jsonToShell('"NumberInt(-5)"')).toBe('NumberInt(-5)');
  });

  it('还原 NumberDecimal', () => {
    const jsonStr = '"NumberDecimal(\\"3.14\\")"';
    expect(jsonToShell(jsonStr)).toBe('NumberDecimal("3.14")');
  });

  it('还原 UUID / BinData / Timestamp — H3', () => {
    expect(jsonToShell('"UUID(\\"b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a\\")"'))
      .toBe('UUID("b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a")');
    expect(jsonToShell('"BinData(0,\\"AQIDBA==\\")"')).toBe('BinData(0,"AQIDBA==")');
    expect(jsonToShell('"Timestamp(1700000000,5)"')).toBe('Timestamp(1700000000,5)');
  });

  it('还原 MinKey', () => {
    expect(jsonToShell('"MinKey()"')).toBe('MinKey()');
  });

  it('还原 MaxKey', () => {
    expect(jsonToShell('"MaxKey()"')).toBe('MaxKey()');
  });

  it('普通字符串值不变', () => {
    expect(jsonToShell('"hello"')).toBe('"hello"');
  });

  it('无 shell 类型的 JSON -> 原样', () => {
    const input = '{"name": "test", "age": 25}';
    expect(jsonToShell(input)).toBe(input);
  });

  it('JSON.stringify 后的 shell 值可以被还原', () => {
    const shellValue = 'ObjectId("abc123456789012345678901")';
    const stringified = JSON.stringify(shellValue);
    expect(jsonToShell(stringified)).toBe(shellValue);
  });

  it('P0: 完整 round-trip - shell -> json -> parse -> stringify -> shell', () => {
    // 模拟完整编辑流程:
    // 1. 用户在 textarea 看到 shell 语法
    // 2. save 时 convertShellToJson -> JSON.parse -> 发给后端
    // 3. 后端返回后 JSON.stringify -> jsonToShell -> 显示给用户
    const doc = {
      _id: 'ObjectId("507f1f77bcf86cd799439011")',
      name: 'test',
      created: 'ISODate("2024-01-15T00:00:00.000Z")',
      count: 'NumberLong("999")',
    };
    // step 1: JSON.stringify -> jsonToShell (展示)
    const shellDisplay = jsonToShell(JSON.stringify(doc, null, 2));
    expect(shellDisplay).toContain('ObjectId("507f1f77bcf86cd799439011")');
    expect(shellDisplay).toContain('ISODate("2024-01-15T00:00:00.000Z")');
    expect(shellDisplay).toContain('NumberLong("999")');

    // step 2: convertShellToJson -> JSON.parse (保存)
    const jsonText = convertShellToJson(shellDisplay);
    const parsed = JSON.parse(jsonText);
    expect(parsed._id).toEqual({ '$oid': '507f1f77bcf86cd799439011' });
    expect(parsed.created).toEqual({ '$date': '2024-01-15T00:00:00.000Z' });
    expect(parsed.count).toEqual({ '$numberLong': '999' });
    expect(parsed.name).toBe('test');
  });
});
