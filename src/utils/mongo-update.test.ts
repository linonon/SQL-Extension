import { describe, it, expect } from 'vitest';
import { BSON, EJSON, Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import { buildClone, buildUpdate, diffDocuments } from './mongo-update';
import { convertEjsonToBson } from './mongo-shell-to-json';

// 真实 bson 类: 断言写进库的 BSON 类型 (canonical EJSON 区分 Int32 / Long / Double / Decimal128)
const canonical = (v: unknown): unknown => JSON.parse(EJSON.stringify(v, { relaxed: false }));

// webview 送来的 EJSON (编辑器打开时 / 编辑结果) 按宿主的方式还原后求 diff
const diff = (before: unknown, after: unknown) =>
  diffDocuments(convertEjsonToBson(before) as Record<string, unknown>, convertEjsonToBson(after) as Record<string, unknown>);

// 库里的文档按 promoteValues:false 读回的样子 (findOneTyped)
const typed = (doc: Record<string, unknown>) => BSON.deserialize(BSON.serialize(doc), { promoteValues: false });

describe('diffDocuments', () => {
  it('没改 -> 空 diff', () => {
    const doc = { a: 1, b: { $numberLong: '9007199254740993' }, c: { d: [1, 2] } };
    expect(diff(doc, doc)).toEqual({ set: {}, unset: [] });
  });

  it('子文档按 dotted path 递归, 删掉的字段 $unset, 新字段 $set, 数组整体作叶子', () => {
    const before = { name: 'a', bag: { gold: 1, gem: 2 }, tags: [1, 2], gone: true };
    const after = { name: 'a', bag: { gold: 5, gem: 2 }, tags: [1, 3], added: 'x' };
    const d = diff(before, after);
    expect(d.unset).toEqual(['gone']);
    expect(d.set).toEqual({ 'bag.gold': 5, tags: [1, 3], added: 'x' });
  });

  it('同值换了 BSON 类型也算改动 (用户显式写了类型)', () => {
    expect(Object.keys(diff({ n: 1 }, { n: { $numberLong: '1' } }).set)).toEqual(['n']);
  });

  it('改到不能按 path 寻址的字段名时报错, 没改到时不报', () => {
    expect(() => diff({ 'a.b': 1 }, { 'a.b': 2 })).toThrow(/cannot be updated by path/);
    expect(() => diff({ x: { $weird: 1 } }, { x: { $weird: 2 } })).toThrow(/cannot be updated by path/);
    expect(() => diff({ 'a.b': 1, n: 1 }, { 'a.b': 1, n: 2 })).not.toThrow();
  });
});

describe('buildUpdate: 只写改过的字段, 数值沿用原 BSON 类型', () => {
  // 游戏数据: 浏览时 Long / Double 被 promote 成 JS number, RegExp 显示成 {}
  const stored = {
    _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
    gold: Long.fromNumber(1000),
    loginAt: Long.fromNumber(1727000000000),
    rate: new Double(2.0),
    lvl: new Int32(5),
    price: Decimal128.fromString('1.50'),
    re: /ab+c/i,
    name: 'a',
  };
  const shown = { gold: 1000, loginAt: 1727000000000, rate: 2, lvl: 5, price: { $numberDecimal: '1.50' }, re: {}, name: 'a' };

  it('只改 name: update 里只有 name, 其他字段不碰 (类型与并发写都不受影响)', () => {
    const update = buildUpdate(typed(stored), diff(shown, { ...shown, name: 'b' }));
    expect(canonical(update)).toEqual({ $set: { name: 'b' } });
  });

  it('改数值: 裸 number 沿用原类型; 显式类型标记优先; 原类型装不下时保留输入', () => {
    const edited = {
      ...shown,
      gold: 2000, loginAt: 1727000000001, rate: 3, price: 1.75,
      lvl: { $numberLong: '6' }, // 显式 NumberLong 覆盖原 Int32
    };
    const update = buildUpdate(typed(stored), diff(shown, edited));
    expect(canonical(update)).toEqual({
      $set: {
        gold: { $numberLong: '2000' },
        loginAt: { $numberLong: '1727000000001' },
        rate: { $numberDouble: '3.0' },
        lvl: { $numberLong: '6' },
        price: { $numberDecimal: '1.75' },
      },
    });
    const frac = buildUpdate(typed(stored), diff(shown, { ...shown, lvl: 5.5 }));
    expect(canonical(frac)).toEqual({ $set: { lvl: { $numberDouble: '5.5' } } });
  });

  it('改过的数组按下标对齐原元素类型, 数组里的子文档按字段名对齐', () => {
    const doc = {
      nums: [Long.fromNumber(1), new Double(2), new Int32(3)],
      items: [{ id: Long.fromNumber(7), n: new Int32(1), at: new Date(0) }],
    };
    const before = { nums: [1, 2, 3], items: [{ id: 7, n: 1, at: { $date: '1970-01-01T00:00:00.000Z' } }] };
    const after = { nums: [4, 5, 6, 8], items: [{ id: 7, n: 2, at: { $date: '1970-01-01T00:00:00.000Z' } }] };
    const update = buildUpdate(typed(doc), diff(before, after));
    expect(canonical(update)).toEqual({
      $set: {
        nums: [{ $numberLong: '4' }, { $numberDouble: '5.0' }, { $numberInt: '6' }, { $numberInt: '8' }],
        items: [{ id: { $numberLong: '7' }, n: { $numberInt: '2' }, at: { $date: { $numberLong: '0' } } }],
      },
    });
  });

  it('删除字段走 $unset, 嵌套字段改动走 dotted $set', () => {
    const doc = { bag: { gold: Long.fromNumber(10), gem: new Int32(1) }, old: 'x' };
    const update = buildUpdate(typed(doc), diff({ bag: { gold: 10, gem: 1 }, old: 'x' }, { bag: { gold: 11, gem: 1 } }));
    expect(canonical(update)).toEqual({ $set: { 'bag.gold': { $numberLong: '11' } }, $unset: { old: '' } });
  });
});

describe('buildClone: 源文档按 _id 重读, 套用改动后插入', () => {
  const source = () => typed({
    _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
    gold: Long.fromNumber(1727000000000),
    rate: new Double(2.0),
    price: Decimal128.fromString('1.50'),
    at: new Date(0),
    name: 'a',
  });
  const seed = { _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, gold: 1727000000000, rate: 2, price: { $numberDecimal: '1.50' }, at: { $date: '1970-01-01T00:00:00.000Z' }, name: 'a' };

  it('没动 _id: 换新 ObjectId, 没改的字段保持原 BSON 类型', () => {
    const out = canonical(buildClone(source(), diff(seed, { ...seed, name: 'copy' }))) as Record<string, unknown>;
    expect(out._id).not.toEqual({ $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(out).toEqual({
      _id: out._id,
      gold: { $numberLong: '1727000000000' },
      rate: { $numberDouble: '2.0' },
      price: { $numberDecimal: '1.50' },
      at: { $date: { $numberLong: '0' } },
      name: 'copy',
    });
  });

  it('改了 _id: 用用户给的 _id', () => {
    const out = canonical(buildClone(source(), diff(seed, { ...seed, _id: 42 }))) as Record<string, unknown>;
    expect(out._id).toEqual({ $numberInt: '42' });
  });
});
