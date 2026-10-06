import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BSON, EJSON, Double, Long } from 'bson';
// instanceof 断言用 mongodb 包里的类: 被测代码经 mongodb 构造 BSON 值 (vitest 下与直接 import 的 bson 是两份模块)
import { ObjectId } from 'mongodb';
import { handleMongoMessage } from './mongo-message-handler';
import type { MongoDriver } from '../drivers/mongo-driver';
import type { WebviewMessage } from '../types/messages';

const NOT_FOUND = 'document not found (deleted or _id changed)';
const OID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const canonical = (v: unknown): unknown => JSON.parse(EJSON.stringify(v, { relaxed: false }));

function mockMongo() {
  return {
    listDatabases: vi.fn().mockResolvedValue([]),
    listTables: vi.fn().mockResolvedValue([]),
    findDocumentsForBrowser: vi.fn().mockResolvedValue({ rows: [], columns: [] }),
    count: vi.fn().mockResolvedValue(0),
    estimatedCount: vi.fn().mockResolvedValue(0),
    explainFind: vi.fn(),
    findOneTyped: vi.fn().mockResolvedValue(null),
    insertOne: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue(1),
    deleteOne: vi.fn().mockResolvedValue(1),
    createCollection: vi.fn(),
    dropCollection: vi.fn(),
  };
}

describe('handleMongoMessage', () => {
  let mongo: ReturnType<typeof mockMongo>;
  let post: ReturnType<typeof vi.fn<(msg: unknown) => void>>;
  const send = (msg: Record<string, unknown>) => handleMongoMessage(msg as unknown as WebviewMessage, mongo as unknown as MongoDriver, post);

  beforeEach(() => {
    mongo = mockMongo();
    post = vi.fn();
  });

  it('非 mongo 消息返回 false', async () => {
    expect(await send({ type: 'executeQuery', database: 'test', sql: 'SELECT 1' })).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('mongoListAllCollections: 遍历所有 database 汇总 collections', async () => {
    mongo.listDatabases.mockResolvedValue(['db1', 'db2']);
    mongo.listTables
      .mockResolvedValueOnce([{ name: 'users', schema: '', rowCount: 100 }])
      .mockResolvedValueOnce([{ name: 'orders', schema: '', rowCount: undefined }]);
    await send({ type: 'mongoListAllCollections' });
    expect(post).toHaveBeenCalledWith({
      type: 'mongoAllCollectionList',
      collections: [
        { database: 'db1', name: 'users', count: 100 },
        { database: 'db2', name: 'orders', count: 0 },
      ],
    });
  });

  describe('mongoFindDocuments', () => {
    const find = { type: 'mongoFindDocuments', requestId: 3, database: 'db', sort: '', projection: '', skip: 0, limit: 20, count: true };

    it('集合名与 filter 作为数据传给 driver: 数字开头 / 中文集合名也能浏览; 总数另发一条回执', async () => {
      mongo.findDocumentsForBrowser.mockResolvedValue({ rows: [{ _id: 'x' }], columns: [] });
      mongo.count.mockResolvedValue(7);
      await send({ ...find, collection: '2024日志', filter: `{"_id": "${OID}", "uid": 9007199254740993}` });
      expect(mongo.findDocumentsForBrowser).toHaveBeenCalledWith('db', '2024日志', expect.any(Array));
      const [, coll, filter, options] = mongo.count.mock.calls[0];
      expect(coll).toBe('2024日志');
      expect(options).toEqual({ maxTimeMS: 15000 });
      // 手写 filter 的裸 24-hex _id 自动转 ObjectId; 超过 2^53 的整数按 Long, 不被舍入
      expect(filter._id).toBeInstanceOf(ObjectId);
      expect(String(filter.uid)).toBe('9007199254740993');
      expect(post.mock.calls).toEqual([
        [{ type: 'mongoDocumentList', requestId: 3, columns: [], rows: [{ _id: 'x' }] }],
        [{ type: 'mongoDocumentCount', requestId: 3, total: 7 }],
      ]);
    });

    it('空 filter 用 estimatedDocumentCount, 不跑 countDocuments', async () => {
      mongo.estimatedCount.mockResolvedValue(1000000);
      await send({ ...find, collection: 'users', filter: ' {} ' });
      expect(mongo.count).not.toHaveBeenCalled();
      expect(mongo.estimatedCount).toHaveBeenCalledWith('db', 'users', { maxTimeMS: 15000 });
      expect(post).toHaveBeenLastCalledWith({ type: 'mongoDocumentCount', requestId: 3, total: 1000000 });
    });

    it('count=false (翻页 / 刷新) 不计数', async () => {
      await send({ ...find, collection: 'users', filter: '{"a": 1}', count: false });
      expect(mongo.count).not.toHaveBeenCalled();
      expect(mongo.estimatedCount).not.toHaveBeenCalled();
      expect(post.mock.calls.map(([m]) => (m as { type: string }).type)).toEqual(['mongoDocumentList']);
    });

    it('慢 count 不拖住文档; count 失败或超时回 total=null, 文档照常', async () => {
      let rejectCount!: (e: Error) => void;
      mongo.count.mockReturnValue(new Promise((_, reject) => { rejectCount = reject; }));
      const done = send({ ...find, collection: 'users', filter: '{"a": 1}' });
      await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'mongoDocumentList', requestId: 3, columns: [], rows: [] }));
      expect(post).toHaveBeenCalledTimes(1);
      rejectCount(Object.assign(new Error('operation exceeded time limit'), { code: 50 }));
      await done;
      expect(post).toHaveBeenLastCalledWith({ type: 'mongoDocumentCount', requestId: 3, total: null });
    });

    it('driver 抛错时回带 requestId 与 error, 不发总数', async () => {
      mongo.findDocumentsForBrowser.mockRejectedValue(new Error('aggregation failed'));
      await send({ ...find, collection: 'users', filter: '{"a": 1}' });
      expect(post.mock.calls).toEqual([[{ type: 'mongoDocumentList', requestId: 3, columns: [], rows: [], error: 'aggregation failed' }]]);
    });
  });

  describe('mongoUpdateDocument', () => {
    const base = { type: 'mongoUpdateDocument', database: 'db', collection: 'users', id: { $oid: OID } };
    // 浏览时 Long / Double 已被 promote 成 JS number
    const shown = { gold: 1000, rate: 2, name: 'a' };
    const stored = BSON.deserialize(BSON.serialize({
      _id: new ObjectId(OID), gold: Long.fromNumber(1000), rate: new Double(2), name: 'a',
    }), { promoteValues: false });

    it('没有改动: 不读不写, 回 No changes', async () => {
      await send({ ...base, original: shown, document: { ...shown } });
      expect(mongo.findOneTyped).not.toHaveBeenCalled();
      expect(mongo.updateOne).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({ type: 'mongoOperationResult', success: true, affectedRows: 0, message: 'No changes' });
    });

    it('updateOne 只 $set 改过的字段, 数值沿用库内原类型; _id 按 EJSON 还原', async () => {
      mongo.findOneTyped.mockResolvedValue(stored);
      await send({ ...base, original: shown, document: { ...shown, gold: 2000 } });
      const [db, coll, filter, update] = mongo.updateOne.mock.calls[0];
      expect([db, coll]).toEqual(['db', 'users']);
      expect(canonical(filter)).toEqual({ _id: { $oid: OID } });
      expect(canonical(update)).toEqual({ $set: { gold: { $numberLong: '2000' } } });
      expect(post).toHaveBeenCalledWith({ type: 'mongoOperationResult', success: true, affectedRows: 1 });
    });

    it('projection 下编辑: 只 $set 改过的 path, 没投影出来的字段不 $unset', async () => {
      // Projection {"name": 1, "bag": 1}: 编辑器只看到 name 与整个 bag, 库里还有 rate / gold
      mongo.findOneTyped.mockResolvedValue(BSON.deserialize(BSON.serialize({
        _id: new ObjectId(OID), name: 'a', rate: new Double(2), gold: Long.fromNumber(1000), bag: { gold: 5, items: [1, 2] },
      }), { promoteValues: false }));
      const projected = { name: 'a', bag: { gold: 5, items: [1, 2] } };
      await send({ ...base, original: projected, document: { name: 'b', bag: { gold: 5, items: [1, 2] } } });
      expect(canonical(mongo.updateOne.mock.calls[0][3])).toEqual({ $set: { name: 'b' } });

      await send({ ...base, original: projected, document: { name: 'a', bag: { gold: 6, items: [1, 2] } } });
      expect(canonical(mongo.updateOne.mock.calls[1][3])).toEqual({ $set: { 'bag.gold': { $numberInt: '6' } } });
    });

    it('复合 _id 内的 ObjectId / Date 按真实类型进 filter; 24-hex 字符串 _id 不被转成 ObjectId', async () => {
      mongo.findOneTyped.mockResolvedValue(stored);
      await send({ ...base, id: { uid: { $oid: OID }, day: { $date: '2024-01-15T00:00:00.000Z' } }, original: shown, document: { ...shown, name: 'b' } });
      const filter = mongo.findOneTyped.mock.calls[0][2];
      expect(filter._id.uid).toBeInstanceOf(ObjectId);
      expect(filter._id.day).toBeInstanceOf(Date);

      await send({ ...base, id: OID, original: shown, document: { ...shown, name: 'c' } });
      expect(mongo.updateOne.mock.calls[1][2]).toEqual({ _id: OID });
    });

    it('文档已不存在 (重读为空或 matchedCount 0) -> 报 not found', async () => {
      await send({ ...base, original: shown, document: { ...shown, name: 'b' } });
      expect(mongo.updateOne).not.toHaveBeenCalled();
      mongo.findOneTyped.mockResolvedValue(stored);
      mongo.updateOne.mockResolvedValue(0);
      await send({ ...base, original: shown, document: { ...shown, name: 'b' } });
      expect(post).toHaveBeenNthCalledWith(1, { type: 'mongoOperationResult', success: false, error: NOT_FOUND });
      expect(post).toHaveBeenNthCalledWith(2, { type: 'mongoOperationResult', success: false, error: NOT_FOUND });
    });

    it('改到不能按 path 写的字段名 -> 报错, 不写库', async () => {
      await send({ ...base, original: { 'a.b': 1 }, document: { 'a.b': 2 } });
      expect(mongo.updateOne).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: expect.stringMatching(/cannot be updated by path/) }));
    });
  });

  describe('mongoCloneDocument', () => {
    const seed = { _id: { $oid: OID }, gold: 1000, name: 'a' };
    const base = { type: 'mongoCloneDocument', database: 'db', collection: 'users', sourceId: { $oid: OID }, original: seed };

    it('按 sourceId 重读源文档, 套用改动, 换新 _id 后插入', async () => {
      mongo.findOneTyped.mockResolvedValue(BSON.deserialize(BSON.serialize({ _id: new ObjectId(OID), gold: Long.fromNumber(1000), name: 'a' }), { promoteValues: false }));
      await send({ ...base, document: { ...seed, name: 'copy' } });
      const inserted = canonical(mongo.insertOne.mock.calls[0][2]) as Record<string, unknown>;
      expect(inserted._id).not.toEqual({ $oid: OID });
      expect(inserted).toEqual({ _id: inserted._id, gold: { $numberLong: '1000' }, name: 'copy' });
      expect(post).toHaveBeenCalledWith({ type: 'mongoOperationResult', success: true, affectedRows: 1 });
    });

    it('projection 下 Clone: 没投影出来的字段取自重读的源文档, 不丢', async () => {
      mongo.findOneTyped.mockResolvedValue(BSON.deserialize(BSON.serialize({ _id: new ObjectId(OID), gold: Long.fromNumber(1000), name: 'a' }), { promoteValues: false }));
      const projectedSeed = { _id: { $oid: OID }, name: 'a' };
      await send({ ...base, original: projectedSeed, document: { ...projectedSeed, name: 'copy' } });
      const inserted = canonical(mongo.insertOne.mock.calls[0][2]) as Record<string, unknown>;
      expect(inserted).toEqual({ _id: inserted._id, gold: { $numberLong: '1000' }, name: 'copy' });
    });

    it('源文档已不存在 -> 报 not found, 不插入', async () => {
      await send({ ...base, document: seed });
      expect(mongo.insertOne).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({ type: 'mongoOperationResult', success: false, error: NOT_FOUND });
    });
  });

  it('mongoInsertDocument: EJSON 还原成 BSON 后插入', async () => {
    await send({ type: 'mongoInsertDocument', database: 'db', collection: 'users', document: { n: { $numberLong: '5' } } });
    expect(canonical(mongo.insertOne.mock.calls[0][2])).toEqual({ n: { $numberLong: '5' } });
    expect(post).toHaveBeenCalledWith({ type: 'mongoOperationResult', success: true, affectedRows: 1 });
  });

  it('mongoDeleteDocument: 按 EJSON _id 删除, 没删到报 not found', async () => {
    await send({ type: 'mongoDeleteDocument', database: 'db', collection: 'users', id: { $numberLong: '42' } });
    expect(canonical(mongo.deleteOne.mock.calls[0][2])).toEqual({ _id: { $numberLong: '42' } });
    mongo.deleteOne.mockResolvedValue(0);
    await send({ type: 'mongoDeleteDocument', database: 'db', collection: 'users', id: 'x' });
    expect(post).toHaveBeenLastCalledWith({ type: 'mongoOperationResult', success: false, error: NOT_FOUND });
  });

  describe('mongoExplainQuery', () => {
    it('filter / sort 解析后传给 explainFind', async () => {
      const summary = { stage: 'IXSCAN' };
      mongo.explainFind.mockResolvedValue(summary);
      await send({ type: 'mongoExplainQuery', database: 'db', collection: 'users', filter: '{"age": {"$gt": 18}}', sort: '' });
      expect(mongo.explainFind).toHaveBeenCalledWith('db', 'users', { age: { $gt: 18 } }, undefined);
      await send({ type: 'mongoExplainQuery', database: 'db', collection: 'users', filter: '', sort: '{"age": -1}' });
      expect(mongo.explainFind).toHaveBeenLastCalledWith('db', 'users', {}, { age: -1 });
      expect(post).toHaveBeenCalledWith({ type: 'mongoExplainResult', summary });
    });

    it('explainFind 抛错时返回 error', async () => {
      mongo.explainFind.mockRejectedValue(new Error('explain failed'));
      await send({ type: 'mongoExplainQuery', database: 'db', collection: 'users', filter: '', sort: '' });
      expect(post).toHaveBeenCalledWith({ type: 'mongoExplainResult', error: 'explain failed' });
    });
  });
});
