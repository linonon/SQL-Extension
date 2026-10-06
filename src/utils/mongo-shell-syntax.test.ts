import { describe, it, expect, vi, afterEach } from 'vitest';
import { convertShellToJson, parseShellJson } from './mongo-shell-syntax';

describe('convertShellToJson', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('字符串值里形似 shell 写法的文本原样保留, 字符串外的照常转换', () => {
    const filter = '{"note": "see Long(5) and \\"ObjectId(\\"abc123456789012345678901\\")\\"", "uid": NumberLong(7)}';
    expect(JSON.parse(convertShellToJson(filter))).toEqual({
      note: 'see Long(5) and "ObjectId("abc123456789012345678901")"',
      uid: { $numberLong: '7' },
    });
  });

  it('ObjectId("...") 转为 {"$oid":"..."}, 括号内可有空格', () => {
    expect(convertShellToJson('ObjectId("abc123456789012345678901")')).toBe('{"$oid":"abc123456789012345678901"}');
    expect(convertShellToJson('ObjectId(  "abc123456789012345678901"  )')).toBe('{"$oid":"abc123456789012345678901"}');
  });

  it('ISODate("...") / new Date("...") 转为 {"$date":"..."}', () => {
    expect(convertShellToJson('ISODate("2024-01-15T00:00:00.000Z")')).toBe('{"$date":"2024-01-15T00:00:00.000Z"}');
    expect(convertShellToJson('new Date("2024-01-15")')).toBe('{"$date":"2024-01-15"}');
  });

  it('ISODate 不带时区的日期时间按 UTC (mongosh 语义); 带时区 / 纯日期 / new Date 不变', () => {
    expect(convertShellToJson('ISODate("2026-01-01 08:00:00")')).toBe('{"$date":"2026-01-01T08:00:00Z"}');
    expect(convertShellToJson('ISODate("2026-01-01T08:00")')).toBe('{"$date":"2026-01-01T08:00Z"}');
    expect(convertShellToJson('ISODate("2026-01-01T08:00:00.123")')).toBe('{"$date":"2026-01-01T08:00:00.123Z"}');
    expect(convertShellToJson('ISODate("2026-01-01T08:00:00+08:00")')).toBe('{"$date":"2026-01-01T08:00:00+08:00"}');
    expect(convertShellToJson('ISODate("2026-01-01")')).toBe('{"$date":"2026-01-01"}');
    expect(convertShellToJson('new Date("2026-01-01 08:00:00")')).toBe('{"$date":"2026-01-01 08:00:00"}');
  });

  it('ISODate() / new Date() 不带参数取当前时间', () => {
    const fakeNow = '2026-02-18T00:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fakeNow));
    expect(convertShellToJson('ISODate()')).toBe(`{"$date":"${fakeNow}"}`);
    expect(convertShellToJson('new Date()')).toBe(`{"$date":"${fakeNow}"}`);
  });

  it('NumberLong / Long 引号与不带引号都转 $numberLong, NumberInt / Int32 转 $numberInt', () => {
    expect(convertShellToJson('NumberLong("12345")')).toBe('{"$numberLong":"12345"}');
    expect(convertShellToJson('NumberLong(12345)')).toBe('{"$numberLong":"12345"}');
    expect(convertShellToJson('Long("999")')).toBe('{"$numberLong":"999"}');
    expect(convertShellToJson('Long(999)')).toBe('{"$numberLong":"999"}');
    expect(convertShellToJson('NumberInt(42)')).toBe('{"$numberInt":"42"}');
    expect(convertShellToJson('Int32(42)')).toBe('{"$numberInt":"42"}');
  });

  it('负数 NumberLong / Long / NumberInt / Int32 保留负号', () => {
    expect(convertShellToJson('NumberLong("-5")')).toBe('{"$numberLong":"-5"}');
    expect(convertShellToJson('NumberLong(-5)')).toBe('{"$numberLong":"-5"}');
    expect(convertShellToJson('Long(-7)')).toBe('{"$numberLong":"-7"}');
    expect(convertShellToJson('NumberInt(-5)')).toBe('{"$numberInt":"-5"}');
    expect(convertShellToJson('Int32(-9)')).toBe('{"$numberInt":"-9"}');
  });

  it('NumberDecimal / Decimal128 转 $numberDecimal', () => {
    expect(convertShellToJson('NumberDecimal("3.14")')).toBe('{"$numberDecimal":"3.14"}');
    expect(convertShellToJson('Decimal128("3.14")')).toBe('{"$numberDecimal":"3.14"}');
  });

  it('UUID / BinData / Timestamp / MinKey / MaxKey 转对应 EJSON', () => {
    expect(convertShellToJson('UUID("b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a")'))
      .toBe('{"$uuid":"b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a"}');
    expect(convertShellToJson('BinData(0,"AQIDBA==")')).toBe('{"$binary":{"base64":"AQIDBA==","subType":0}}');
    expect(convertShellToJson('Timestamp(1700000000,5)')).toBe('{"$timestamp":{"t":1700000000,"i":5}}');
    expect(convertShellToJson('MinKey()')).toBe('{"$minKey":1}');
    expect(convertShellToJson('MaxKey()')).toBe('{"$maxKey":1}');
  });

  it('空串 / 无 shell 写法的文本原样返回', () => {
    expect(convertShellToJson('')).toBe('');
    expect(convertShellToJson('hello world')).toBe('hello world');
    expect(convertShellToJson('{"name": "test"}')).toBe('{"name": "test"}');
  });

  it('对象 / 数组里的多种 shell 类型', () => {
    const input = '{ "_id": ObjectId("aabbccddeeff00112233aabb"), "count": NumberInt(5), "date": ISODate("2024-01-15T00:00:00.000Z"), "big": NumberLong("999"), "arr": [ObjectId("abc123456789012345678901"), NumberLong(42)] }';
    expect(JSON.parse(convertShellToJson(input))).toEqual({
      _id: { $oid: 'aabbccddeeff00112233aabb' },
      count: { $numberInt: '5' },
      date: { $date: '2024-01-15T00:00:00.000Z' },
      big: { $numberLong: '999' },
      arr: [{ $oid: 'abc123456789012345678901' }, { $numberLong: '42' }],
    });
  });

  it('字符串外超出 2^53 的裸整数包成 $numberLong, 安全整数 / 小数 / 指数 / 字符串内的不动', () => {
    const out = convertShellToJson('{"uid": 9007199254740993, "neg": -9223372036854775808, "n": 9007199254740991, "f": 9007199254740993.5, "e": 1e25, "s": "9007199254740993", "t": "a\\"9007199254740993"}');
    expect(JSON.parse(out)).toEqual({
      uid: { $numberLong: '9007199254740993' },
      neg: { $numberLong: '-9223372036854775808' },
      n: 9007199254740991,
      f: 9007199254740993.5,
      e: 1e25,
      s: '9007199254740993',
      t: 'a"9007199254740993',
    });
  });

  it('超出 int64 的裸整数只能是 double, 原样不包; 负指数里的数字不动', () => {
    for (const s of ['{"a":100000000000000000000}', '{"a":-9223372036854775809}', '{"a":1e-99999999999999999999}']) {
      expect(convertShellToJson(s)).toBe(s);
    }
  });
});

describe('parseShellJson: 从 mongosh 粘过来的写法', () => {
  it('裸 key + Long uid', () => {
    expect(parseShellJson('{uid: 7000000000000012345}')).toEqual({ uid: { $numberLong: '7000000000000012345' } });
  });

  it('单引号 key / 值, 单引号参数的 ObjectId / ISODate / NumberLong', () => {
    expect(parseShellJson("{'name': 'abc', _id: ObjectId('5f1d7a2b3c4d5e6f7a8b9c0d'), at: {$gte: ISODate('2026-10-01 00:00:00')}, gold: NumberLong('12')}")).toEqual({
      name: 'abc',
      _id: { $oid: '5f1d7a2b3c4d5e6f7a8b9c0d' },
      at: { $gte: { $date: '2026-10-01T00:00:00Z' } },
      gold: { $numberLong: '12' },
    });
  });

  it('$regex 字符串里的引号 / 冒号 / 花括号原样保留, 不当成 key 或 shell 写法', () => {
    expect(parseShellJson(`{nick: {$regex: 'a:b"c{d', $options: 'i'}, note: "x, y: z {w}", tip: 'it\\'s ObjectId("x")'}`)).toEqual({
      nick: { $regex: 'a:b"c{d', $options: 'i' },
      note: 'x, y: z {w}',
      tip: `it's ObjectId("x")`,
    });
  });

  it('嵌套 $elemMatch / $or 与多行输入', () => {
    const q = `{
  $or: [{uid: 1001}, {'profile.name': 'bob'}],
  'bag.items': {$elemMatch: {id: 3001, cnt: {$gte: 5}}}
}`;
    expect(parseShellJson(q)).toEqual({
      $or: [{ uid: 1001 }, { 'profile.name': 'bob' }],
      'bag.items': { $elemMatch: { id: 3001, cnt: { $gte: 5 } } },
    });
  });

  it('sort / projection 的裸 key', () => {
    expect(parseShellJson('{_id: -1, lv: 1}')).toEqual({ _id: -1, lv: 1 });
    expect(parseShellJson('{name: 1, bag: 0}')).toEqual({ name: 1, bag: 0 });
  });

  it('漏写 } 的报错位置是用户原文的行列, 不是改写后的位置', () => {
    // 改写后变长 (补引号 + 包 $numberLong), 报错仍指向用户输入的末尾 (25 个字符之后)
    expect(() => parseShellJson('{uid: 7000000000000012345')).toThrow(/at line 1 column 26$/);
  });

  it('带点的路径不补引号 (mongosh 同样不认), 报错指向它在原文的位置', () => {
    expect(() => parseShellJson('{\n  bag.gold: {$gt: 5}}')).toThrow(/at line 2 column 3$/);
  });

  it('不带位置的报错只留出错 token, 不引用改写后的文本', () => {
    let message = '';
    try { parseShellJson("{name: abc, 'lv': 1}"); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/'a'/);
    expect(message).not.toContain('"name"');
  });
});
