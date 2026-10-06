import { describe, it, expect } from 'vitest';
import { BSON, EJSON, Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import { buildClone, buildUpdate, changedSinceLoaded, diffDocuments } from './mongo-update';
import { convertEjsonToBson } from './mongo-shell-to-json';

// 真实 bson 类: 断言写进库的 BSON 类型 (canonical EJSON 区分 Int32 / Long / Double / Decimal128)
const canonical = (v: unknown): unknown => JSON.parse(EJSON.stringify(v, { relaxed: false }));

// webview 送来的 EJSON (编辑器打开时 / 编辑结果) 按宿主的方式还原后求 diff
const diff = (before: unknown, after: unknown) =>
  diffDocuments(convertEjsonToBson(before) as Record<string, unknown>, convertEjsonToBson(after) as Record<string, unknown>);

// 库里的文档按 promoteValues:false 读回的样子 (findOneTyped)
const typed = (doc: Record<string, unknown>) => BSON.deserialize(BSON.serialize(doc), { promoteValues: false });

// 经 BSON 序列化后实际落库的类型: canonical EJSON 把 int32 外的 JS 整数写成 $numberLong, driver 却存成 Double
const written = (doc: Record<string, unknown>): unknown => canonical(typed(doc));

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

describe('castLike: 没有同位原值时的数值类型', () => {
  it('追加的数组元素以兄弟元素作模板: 复制一件道具改 id, 新 id 仍是 Long, 小值也跟兄弟类型', () => {
    const doc = { items: [{ id: Long.fromNumber(10000000001), w: new Double(1.5) }] };
    const before = { items: [{ id: 10000000001, w: 1.5 }] };
    const after = { items: [{ id: 10000000001, w: 1.5 }, { id: 10000000002, w: 2.5 }, { id: 8, w: 3 }] };
    expect(written(buildUpdate(typed(doc), diff(before, after)))).toEqual({
      $set: {
        items: [
          { id: { $numberLong: '10000000001' }, w: { $numberDouble: '1.5' } },
          { id: { $numberLong: '10000000002' }, w: { $numberDouble: '2.5' } },
          { id: { $numberLong: '8' }, w: { $numberDouble: '3.0' } },
        ],
      },
    });
  });

  it('没有模板 (新字段 / 嵌套新值) 或原类型装不下: int32 外的整数存 Long, int32 内存 Int32, 小数存 Double', () => {
    const doc = { name: 'a', lvl: new Int32(5) };
    const before = { name: 'a', lvl: 5 };
    const after = { name: 'a', lvl: 3000000000, n: 5, uid: 10000000002, rate: 1.5, bag: { uids: [3000000000] } };
    expect(written(buildUpdate(typed(doc), diff(before, after)))).toEqual({
      $set: {
        lvl: { $numberLong: '3000000000' },
        n: { $numberInt: '5' },
        uid: { $numberLong: '10000000002' },
        rate: { $numberDouble: '1.5' },
        bag: { uids: [{ $numberLong: '3000000000' }] },
      },
    });
  });
});

describe('changedSinceLoaded: 要写的 path 自打开以来是否被别人改过', () => {
  const loaded = { gold: 1000, at: { $date: '2024-01-15T00:00:00.000Z' }, bag: { items: [{ id: 1 }, { id: 2 }] } };
  const check = (stored: Record<string, unknown>, after: Record<string, unknown>) =>
    changedSinceLoaded(convertEjsonToBson(loaded) as Record<string, unknown>, typed(stored), diff(loaded, after));

  it('库内值与打开时同值 (只差 Int32 / Long / Double 类型, Date) -> 不算改过', () => {
    const stored = { gold: Long.fromNumber(1000), at: new Date('2024-01-15T00:00:00.000Z'), bag: { items: [{ id: new Int32(1) }, { id: new Double(2) }] } };
    expect(check(stored, { gold: 1, at: { $date: '2025-01-01T00:00:00.000Z' }, bag: { items: [{ id: 1 }] } })).toEqual([]);
  });

  it('点名被改 / 被删 / 打开时没有但现在有 (含 null) 的 path; 没写到的 path 变了不管', () => {
    const stored = { gold: Long.fromNumber(999), bag: { items: [{ id: 1 }, { id: 2 }, { id: 3 }], extra: 1 }, note: null };
    expect(check(stored, { gold: 1, bag: { items: [{ id: 1 }, { id: 2 }], extra: 2 }, note: 'x' }))
      .toEqual(['gold', 'bag.extra', 'note', 'at']);
  });

  it('超出 2^53 的 Long 按精确值比较 (相差不到一个 double 间隔也算改过)', () => {
    const big = { uid: { $numberLong: '1800000000000000001' } };
    const lock = (stored: string) => changedSinceLoaded(
      convertEjsonToBson(big) as Record<string, unknown>,
      typed({ uid: Long.fromString(stored) }),
      diff(big, { uid: { $numberLong: '1800000000000000009' } }),
    );
    expect(lock('1800000000000000001')).toEqual([]);
    expect(lock('1800000000000000002')).toEqual(['uid']);
  });

  it('库里按 Double 存的超出 2^53 的整数: 编辑器把它解析成 Long, 同值不算改过 (含数组整组)', () => {
    // 浏览显示裸数字, 编辑器解析时包成 $numberLong
    const shown = { score: { $numberLong: '9007199254740992' }, ids: [{ $numberLong: '18014398509481984' }, 1] };
    const lock = (score: number) => changedSinceLoaded(
      convertEjsonToBson(shown) as Record<string, unknown>,
      typed({ score: new Double(score), ids: [new Double(2 ** 54), new Int32(1)] }),
      diff(shown, { score: 1, ids: [2] }),
    );
    expect(lock(2 ** 53)).toEqual([]);
    expect(lock(2 ** 53 + 2)).toEqual(['score']);
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
