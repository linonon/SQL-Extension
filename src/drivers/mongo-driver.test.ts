import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MongoDriver, deepFormatValue, deepFormatDocument, buildUri, fieldPathTypes, userFilter } from './mongo-driver';
import { ObjectId, Long, Binary, UUID, Timestamp } from 'mongodb';
// 'mongodb' 在本文件被 mock 成假类; 往返测试用 bson 包里的真实类
import {
  BSON, Decimal128 as RealDecimal128, Double as RealDouble, Int32 as RealInt32, Long as RealLong, ObjectId as RealObjectId,
} from 'bson';

// Mock mongodb
const mockCollection = {
  find: vi.fn(),
  findOne: vi.fn(),
  insertOne: vi.fn(),
  insertMany: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
  replaceOne: vi.fn(),
  deleteOne: vi.fn(),
  deleteMany: vi.fn(),
  aggregate: vi.fn(),
  countDocuments: vi.fn(),
  estimatedDocumentCount: vi.fn(),
};

const mockDb = {
  collection: vi.fn(() => mockCollection),
  listCollections: vi.fn(),
  command: vi.fn(),
};

const mockAdmin = {
  listDatabases: vi.fn(),
};

const mockClient = {
  connect: vi.fn(),
  close: vi.fn(),
  db: vi.fn((name?: string) => {
    if (name === 'admin') {
      return { ...mockDb, admin: () => mockAdmin, command: mockDb.command };
    }
    return mockDb;
  }),
};

vi.mock('mongodb', async () => {
  // driver 经 mongodb 的 BSON 命名空间取 EJSON; 这里给真实实现, 只把类换成假的
  const { BSON } = await vi.importActual<typeof import('bson')>('bson');
  class FakeObjectId {
    private readonly id: string;
    constructor(id: string) { this.id = id; }
    toString() { return this.id; }
  }
  class FakeLong {
    readonly _bsontype = 'Long';
    private readonly value: string;
    private constructor(v: string) { this.value = v; }
    static fromString(v: string) { return new FakeLong(v); }
    toString() { return this.value; }
  }
  class FakeInt32 {
    readonly _bsontype = 'Int32';
    readonly value: number;
    constructor(v: number) { this.value = v; }
    toString() { return String(this.value); }
  }
  class FakeDecimal128 {
    readonly _bsontype = 'Decimal128';
    private readonly value: string;
    constructor(v: string) { this.value = v; }
    toString() { return this.value; }
  }
  class FakeMinKey {
    readonly _bsontype = 'MinKey';
  }
  class FakeMaxKey {
    readonly _bsontype = 'MaxKey';
  }
  class FakeBinary {
    readonly _bsontype = 'Binary';
    constructor(readonly buffer: Buffer, readonly sub_type: number) {}
  }
  class FakeUUID {
    readonly _bsontype = 'Binary';
    readonly sub_type = 4;
    constructor(private readonly v: string) {}
    toString() { return this.v; }
  }
  class FakeTimestamp {
    readonly _bsontype = 'Timestamp';
    constructor(private readonly o: { t: number; i: number }) {}
    toExtendedJSON() { return { $timestamp: this.o }; }
  }
  class FakeMongoClient {
    constructor() {
      // 代理到 mockClient
      return mockClient as unknown as FakeMongoClient;
    }
  }
  return {
    BSON,
    MongoClient: FakeMongoClient,
    ObjectId: FakeObjectId,
    Long: FakeLong,
    Int32: FakeInt32,
    Decimal128: FakeDecimal128,
    MinKey: FakeMinKey,
    MaxKey: FakeMaxKey,
    Binary: FakeBinary,
    UUID: FakeUUID,
    Timestamp: FakeTimestamp,
  };
});

describe('MongoDriver', () => {
  let driver: MongoDriver;

  beforeEach(() => {
    driver = new MongoDriver();
    vi.clearAllMocks();
  });

  describe('connect', () => {
    it('有 auth 的 URI 构建', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });

      await driver.connect({
        id: 'test',
        name: 'test',
        driverType: 'mongodb',
        host: 'localhost',
        port: 27017,
        username: 'admin',
        password: 'secret',
        database: 'mydb',
      });

      expect(mockClient.connect).toHaveBeenCalled();
      expect(driver.isConnected()).toBe(true);
    });

    it('无 auth 的 URI 构建', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });

      await driver.connect({
        id: 'test',
        name: 'test',
        driverType: 'mongodb',
        host: 'localhost',
        port: 27017,
        username: '',
        password: '',
        database: '',
      });

      expect(mockClient.connect).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('关闭连接', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });

      await driver.disconnect();
      expect(mockClient.close).toHaveBeenCalled();
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('listDatabases', () => {
    it('返回 database 名列表', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });

      mockAdmin.listDatabases.mockResolvedValue({
        databases: [{ name: 'admin' }, { name: 'test' }, { name: 'myapp' }],
      });

      const dbs = await driver.listDatabases();
      expect(dbs).toEqual(['admin', 'test', 'myapp']);
    });
  });

  describe('listTables', () => {
    it('返回 collection 列表并统计文档数', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });

      mockDb.listCollections.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { name: 'users' },
          { name: 'orders' },
        ]),
      });
      mockCollection.estimatedDocumentCount.mockResolvedValue(42);

      const tables = await driver.listTables('testdb');
      expect(tables).toEqual([
        { name: 'orders', schema: 'testdb', rowCount: 42 },
        { name: 'users', schema: 'testdb', rowCount: 42 },
      ]);
    });
  });

  describe('listColumns (inferSchema)', () => {
    it('空集合返回 _id 列', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      const columns = await driver.listColumns('testdb', 'empty');
      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe('_id');
      expect(columns[0].isPrimaryKey).toBe(true);
    });

    it('多类型推断, _id 排第一', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', name: 'Alice', age: 30 },
            { _id: 'id2', name: 'Bob' },
          ]),
        }),
      });

      const columns = await driver.listColumns('testdb', 'users');
      expect(columns[0].name).toBe('_id');
      expect(columns[0].isPrimaryKey).toBe(true);
      const nameCol = columns.find(c => c.name === 'name');
      expect(nameCol).toBeDefined();
      const ageCol = columns.find(c => c.name === 'age');
      expect(ageCol?.nullable).toBe(true); // age 只出现 1 次 < 2 docs
    });
  });

  describe('结构化集合操作', () => {
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
    });

    it('集合名原样作数据传给 driver (数字开头 / 中文名), find 透传 options', async () => {
      mockCollection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ _id: 'a' }]) });
      const docs = await driver.find('db', '2024日志', { a: 1 }, { limit: 5, maxTimeMS: 100 });
      expect(mockDb.collection).toHaveBeenCalledWith('2024日志');
      expect(mockCollection.find).toHaveBeenCalledWith({ a: 1 }, { limit: 5, maxTimeMS: 100 });
      expect(docs).toEqual([{ _id: 'a' }]);
    });

    it('findOneTyped 用 promoteValues:false 读, 保留 Int32 / Long / Double', async () => {
      mockCollection.findOne.mockResolvedValue({ _id: 'x' });
      await driver.findOneTyped('db', 'users', { _id: 'x' });
      expect(mockCollection.findOne).toHaveBeenCalledWith({ _id: 'x' }, { promoteValues: false });
    });

    it('updateOne 返回 matchedCount (命中但值未变也算成功), deleteOne 返回 deletedCount', async () => {
      mockCollection.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 0 });
      mockCollection.deleteOne.mockResolvedValue({ deletedCount: 0 });
      expect(await driver.updateOne('db', 'users', { _id: 'x' }, { $set: { a: 1 } })).toBe(1);
      expect(await driver.deleteOne('db', 'users', { _id: 'x' })).toBe(0);
    });

    it('未连接时报错', async () => {
      await driver.disconnect();
      expect(() => driver.find('db', 'users', {}, { limit: 1 })).toThrow('not connected');
    });

    it('explainFind 只取 queryPlanner (不执行查询), 返回精简摘要', async () => {
      const explain = vi.fn().mockResolvedValue({ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } });
      mockCollection.find.mockReturnValue({ sort: vi.fn().mockReturnThis(), explain });

      const s = await (driver as any).explainFind('mydb', 'users', { age: { $gt: 18 } });
      expect(explain).toHaveBeenCalledWith('queryPlanner');
      expect(s).toEqual({ stage: 'COLLSCAN', indexName: undefined, isCollScan: true });
    });

    it('explainFind 带 EJSON _id filter 还原类型后 explain', async () => {
      const explain = vi.fn().mockResolvedValue({
        queryPlanner: { winningPlan: { stage: 'IDHACK' } },
      });
      mockCollection.find.mockReturnValue({ sort: vi.fn().mockReturnThis(), explain });

      await (driver as any).explainFind('mydb', 'users', { _id: { $oid: '507f1f77bcf86cd799439011' } });
      const filterArg = mockCollection.find.mock.calls[0][0];
      expect(filterArg._id).toBeInstanceOf(ObjectId);
    });

    it('explainFind 带 sort 时调用 cursor.sort — M8', async () => {
      const sortFn = vi.fn().mockReturnThis();
      mockCollection.find.mockReturnValue({
        sort: sortFn,
        explain: vi.fn().mockResolvedValue({ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } }),
      });
      await (driver as any).explainFind('mydb', 'users', { a: 1 }, { a: -1 });
      expect(sortFn).toHaveBeenCalledWith({ a: -1 });
    });
  });

  describe('userFilter (手写 filter 的 _id 便利转换)', () => {
    it('_id 上下文里的 24-hex 串转 ObjectId (含大写 / $in / $or 分支), 其他字段与非 24-hex 不动', () => {
      const hex = '507f1f77bcf86cd799439011';
      const f = userFilter({ _id: hex.toUpperCase(), ref: hex, $or: [{ _id: { $in: [hex, 'short'] } }] });
      expect(f._id).toBeInstanceOf(ObjectId);
      expect(f.ref).toBe(hex);
      expect(f.$or[0]._id.$in[0]).toBeInstanceOf(ObjectId);
      expect(f.$or[0]._id.$in[1]).toBe('short');
      expect(userFilter({ _id: 'abc' })._id).toBe('abc');
    });

    it('EJSON 标记还原成 BSON', () => {
      const f = userFilter({ _id: { $oid: '507f1f77bcf86cd799439011' }, ts: { $numberLong: '1700000000000' } });
      expect(f._id).toBeInstanceOf(ObjectId);
      expect(f.ts).toBeInstanceOf(Long);
    });
  });

  describe('getTableDDL', () => {
    it('无 validator 返回提示信息', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });

      mockDb.listCollections.mockReturnValue({
        next: vi.fn().mockResolvedValue({ name: 'users', options: {} }),
      });

      const ddl = await driver.getTableDDL('testdb', 'users');
      expect(ddl).toContain('no schema validator');
    });

    it('有 validator 返回 JSON', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });

      const validator = { $jsonSchema: { required: ['name'] } };
      mockDb.listCollections.mockReturnValue({
        next: vi.fn().mockResolvedValue({ name: 'users', options: { validator } }),
      });

      const ddl = await driver.getTableDDL('testdb', 'users');
      expect(JSON.parse(ddl)).toEqual(validator);
    });
  });

  describe('findDocumentsForBrowser', () => {
    it('返回深层 rows (嵌套保留) + inferSchema columns', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 't', name: 't', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
      mockCollection.aggregate.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { _id: new ObjectId('b'.repeat(24)), bind: { aid: 'w-1' } },
        ]),
      });

      const res = await driver.findDocumentsForBrowser('db', 'coll', []);

      // 浏览查询带服务端超时, 大 sort / 深页 skip 允许落盘
      expect(mockCollection.aggregate.mock.calls[0][1]).toEqual({ maxTimeMS: 60000, allowDiskUse: true });
      expect(res.rows[0].bind).toEqual({ aid: 'w-1' });
      expect(res.rows[0]._id).toBe(`ObjectId("${'b'.repeat(24)}")`);
      expect(res.columns.some((c) => c.name === '_id')).toBe(true);
    });

    it('pipeline 内 EJSON ($oid/$numberLong) 被还原为 BSON (browser 按 ObjectId 过滤可命中) — review round2 #4', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 't', name: 't', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
      mockCollection.aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

      await driver.findDocumentsForBrowser('db', 'coll', [
        { $match: { _id: { $oid: '507f1f77bcf86cd799439011' } } },
      ]);

      const pipelineArg = mockCollection.aggregate.mock.calls[0][0];
      expect(pipelineArg[0].$match._id).toBeInstanceOf(ObjectId);
    });

    it('$match 内裸 24-hex _id 串自动转 ObjectId, 与 count/explain 一致 — M2/M3', async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 't', name: 't', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
      mockCollection.aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

      await driver.findDocumentsForBrowser('db', 'coll', [
        { $match: { _id: '507f1f77bcf86cd799439011' } },
      ]);

      const pipelineArg = mockCollection.aggregate.mock.calls[0][0];
      expect(pipelineArg[0].$match._id).toBeInstanceOf(ObjectId);
    });
  });

  describe('exportDocuments / importDocuments', () => {
    let dir: string;
    let file: string;
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 't', name: 't', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlext-mongo-export-'));
      file = path.join(dir, 'out.json');
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    // 假游标: 按需逐个产出文档 (每产出一个前先跑 beforeYield), 被提前结束时记 closed
    function fakeCursor(docs: Iterable<unknown>, beforeYield: (i: number) => void = () => {}) {
      const state = { closed: false, pulled: 0 };
      const cursor = {
        async *[Symbol.asyncIterator]() {
          try {
            for (const doc of docs) {
              beforeYield(state.pulled);
              state.pulled++;
              yield doc;
            }
          } finally {
            state.closed = true;
          }
        },
      };
      mockCollection.aggregate.mockReturnValue(cursor);
      return state;
    }

    it('pipeline 内 EJSON 被还原为 BSON (导出过滤可命中), 读时 promoteValues:false, 允许落盘但不设超时', async () => {
      fakeCursor([{ _id: 'x' }]);
      const count = await driver.exportDocuments('db', 'coll', [
        { $match: { _id: { $oid: '507f1f77bcf86cd799439011' } } },
      ], file, false);
      const [pipelineArg, options] = mockCollection.aggregate.mock.calls[0];
      expect(pipelineArg[0].$match._id).toBeInstanceOf(ObjectId);
      expect(options).toEqual({ promoteValues: false, allowDiskUse: true });
      expect(count).toBe(1);
    });

    it('空结果: JSON 写出 [], JSONL 写出空文件', async () => {
      fakeCursor([]);
      expect(await driver.exportDocuments('db', 'coll', [], file, false)).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual([]);
      fakeCursor([]);
      expect(await driver.exportDocuments('db', 'coll', [], file, true)).toBe(0);
      expect(fs.readFileSync(file, 'utf-8')).toBe('');
    });

    // 真实 bson 类: 导出 -> 导入后的 BSON 字节与原文档完全一致 (类型 / 精度都不丢)
    const original = () => [
      {
        _id: new RealObjectId('507f1f77bcf86cd799439011'),
        big: RealLong.fromNumber(1727000000000),
        small: RealLong.fromNumber(1000),
        rate: new RealDouble(2.0),
        lvl: new RealInt32(5),
        price: RealDecimal128.fromString('1.50'),
        at: new Date('2024-01-15T00:00:00.123Z'),
        bag: [RealLong.fromNumber(1), { n: new RealDouble(3), tags: ['a', new RealInt32(2)] }],
      },
      { _id: new RealObjectId('507f1f77bcf86cd799439012'), n: new RealInt32(-1) },
    ];
    // 模拟 driver 按 promoteValues:false 读出的文档
    const readTyped = () => original().map((d) => BSON.deserialize(BSON.serialize(d), { promoteValues: false }));
    const bytes = (docs: unknown[]) => docs.map((d) => Buffer.from(BSON.serialize(d as Record<string, unknown>)).toString('hex'));

    it.each([
      ['JSON 数组', false],
      ['JSONL', true],
    ])('%s 流式写入文件, 再导入时 BSON 往返无损', async (_label, jsonl) => {
      fakeCursor(readTyped());
      expect(await driver.exportDocuments('db', 'coll', [], file, jsonl)).toBe(2);
      const json = fs.readFileSync(file, 'utf-8');
      if (jsonl) {
        const lines = json.trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).big).toEqual({ $numberLong: '1727000000000' });
      } else {
        expect(JSON.parse(json)[0].rate).toEqual({ $numberDouble: '2.0' });
      }

      mockCollection.insertMany.mockResolvedValue({ insertedCount: 2 });
      expect(await driver.importDocuments('db', 'coll', json)).toBe(2);
      const inserted = mockCollection.insertMany.mock.calls[0][0];
      expect(bytes(inserted)).toEqual(bytes(original()));
    });

    it('按写入速度拉游标 (backpressure): 已拉取但未落盘的数据有上限, 不把结果集攒在内存里', async () => {
      const pad = 'x'.repeat(4000);
      const docs = Array.from({ length: 500 }, (_, i) => ({ _id: `doc-${String(i).padStart(6, '0')}`, pad }));
      const lineBytes = Buffer.byteLength(`${BSON.EJSON.stringify(docs[0], { relaxed: false })}\n`);
      let maxLag = 0;
      // 拉第 i 个文档时, 前 i 个已交给写入端; 与磁盘上的文件大小之差即积压在内存里的量
      fakeCursor(docs, (i) => {
        let written = 0;
        // 导出先写同目录的 .partial 临时文件, 完成后才 rename 成目标
        try { written = fs.statSync(`${file}.partial`).size; } catch { /* 文件还没打开 */ }
        maxLag = Math.max(maxLag, i * lineBytes - written);
      });
      expect(await driver.exportDocuments('db', 'coll', [], file, true)).toBe(500);
      expect(fs.statSync(file).size).toBe(500 * lineBytes);
      // 总量约 2MB; 不等写入就拉完会积压到整个结果集
      expect(maxLag).toBeLessThan(512 * 1024);
    });

    it('取消: 游标被关闭, 写了一半的临时文件被删掉, 已有的目标文件原样保留; 进度每 1000 条回报一次', async () => {
      fs.writeFileSync(file, 'keep');
      const aborter = new AbortController();
      const progress: number[] = [];
      const infinite = function* () { for (let i = 0; i < 100_000; i++) { yield { _id: i }; } };
      const state = fakeCursor(infinite(), (i) => { if (i === 2500) { aborter.abort(); } });
      await expect(driver.exportDocuments('db', 'coll', [], file, false, {
        signal: aborter.signal, onProgress: (n) => progress.push(n),
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(state.closed).toBe(true);
      expect(state.pulled).toBeLessThan(3000);
      expect(fs.readFileSync(file, 'utf-8')).toBe('keep');
      expect(fs.readdirSync(dir)).toEqual(['out.json']);
      expect(progress).toEqual([1000, 2000]);
      // 游标收到同一个 signal, 进行中的 getMore 也能被中断
      expect(mockCollection.aggregate.mock.calls[0][1].signal).toBe(aborter.signal);
    });

    it('写入出错 (目录不存在): 报错, 不留文件', async () => {
      fakeCursor([{ _id: 1 }]);
      const bad = path.join(dir, 'missing', 'out.json');
      await expect(driver.exportDocuments('db', 'coll', [], bad, false)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fs.existsSync(bad)).toBe(false);
    });

    // root 无视文件权限, 打不出 EACCES
    it.skipIf(process.getuid?.() === 0)('打开目标失败 (已有只读文件): 报错, 原文件原样保留', async () => {
      fakeCursor([{ _id: 1 }]);
      fs.writeFileSync(file, 'keep');
      fs.chmodSync(file, 0o444);
      await expect(driver.exportDocuments('db', 'coll', [], file, false)).rejects.toMatchObject({ code: 'EACCES' });
      expect(fs.readFileSync(file, 'utf-8')).toBe('keep');
      expect(mockCollection.aggregate).not.toHaveBeenCalled();
    });

    it('导入中途出错: 报错带已写入条数 (含出错那批里已写入的)', async () => {
      const lines = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ _id: i })).join('\n');
      mockCollection.insertMany
        .mockResolvedValueOnce({ insertedCount: 500 })
        .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key error'), { insertedCount: 37 }));
      await expect(driver.importDocuments('db', 'coll', lines))
        .rejects.toThrow('Imported 537 of 1200 documents before the error: E11000 duplicate key error');
      expect(mockCollection.insertMany).toHaveBeenCalledTimes(2);
    });
  });

});

describe('deepFormatValue', () => {
  it('保留嵌套对象与数组, 叶子转 shell-tag 字符串', () => {
    const out = deepFormatValue({
      _id: new ObjectId('a'.repeat(24)),
      bind: { aid: 'w-1', at: new Date('2020-05-11T02:56:02.131Z'), n: Long.fromString('14') },
      tags: ['x', { k: 1 }],
    }) as Record<string, unknown>;

    expect(out._id).toBe(`ObjectId("${'a'.repeat(24)}")`);
    expect((out.bind as Record<string, unknown>).aid).toBe('w-1');
    expect((out.bind as Record<string, unknown>).at).toBe('ISODate("2020-05-11T02:56:02.131Z")');
    expect((out.bind as Record<string, unknown>).n).toBe('NumberLong("14")');
    expect(Array.isArray(out.tags)).toBe(true);
    expect((out.tags as unknown[])[1]).toEqual({ k: 1 });
  });

  it('null/标量原样', () => {
    expect(deepFormatValue(null)).toBe(null);
    expect(deepFormatValue(42)).toBe(42);
    expect(deepFormatValue('plain')).toBe('plain');
  });

  it('UUID (Binary sub_type 4) 转 UUID("...") — H3', () => {
    const u = new UUID('b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a');
    expect(deepFormatValue(u)).toBe('UUID("b26ddf70-e8e9-4e7d-9fe9-f05eb8ec872a")');
  });

  it('普通 Binary 转 BinData(sub,"base64"), 不再 String(value) 乱码 — H3', () => {
    const b = new Binary(Buffer.from([1, 2, 3, 4]), 0);
    expect(deepFormatValue(b)).toBe('BinData(0,"AQIDBA==")');
  });

  it('Timestamp 转 Timestamp(t,i) — H3', () => {
    const t = new Timestamp({ t: 1700000000, i: 5 });
    expect(deepFormatValue(t)).toBe('Timestamp(1700000000,5)');
  });
});

describe('buildUri', () => {
  const base = { id: 't', name: 't', driverType: 'mongodb' as const, host: '127.0.0.1', port: 40001, username: 'u', password: 'p@ss', database: 'game' };
  const ssh = { enabled: true, host: 'bastion', port: 22, username: 'ops', authType: 'password' as const };

  it('走 SSH tunnel 时带 directConnection=true (不按副本集成员内网地址发现)', () => {
    expect(buildUri({ ...base, authSource: 'admin', ssh })).toBe(
      'mongodb://u:p%40ss@127.0.0.1:40001/game?authSource=admin&directConnection=true'
    );
    expect(buildUri({ ...base, ssh })).toBe('mongodb://u:p%40ss@127.0.0.1:40001/game?directConnection=true');
  });

  it('不走 tunnel 时不加 directConnection', () => {
    expect(buildUri({ ...base, authSource: 'admin' })).toBe('mongodb://u:p%40ss@127.0.0.1:40001/game?authSource=admin');
    expect(buildUri({ ...base, ssh: { ...ssh, enabled: false } })).toBe('mongodb://u:p%40ss@127.0.0.1:40001/game');
  });
});

describe('fieldPathTypes', () => {
  it('数组元素的字段沿用数组路径; 数字 / 24-hex key 归并为 <n> / <id>; 浅层在前', () => {
    const hex = '5f1d7a2b3c4d5e6f70819203';
    const docs = [
      {
        heroes: { [hex]: { star: new RealInt32(5) }, '10086': { star: new RealLong(1) } },
        bag: [{ itemId: 'a', n: new RealInt32(3) }, { itemId: 'b' }],
        _id: new RealObjectId('a'.repeat(24)),
      },
      { bag: [], tags: ['x', new RealInt32(1)], at: new Date(0), uid: new RealLong(9) },
    ];
    expect(fieldPathTypes(docs)).toEqual([
      ['heroes', ['object']],
      ['bag', ['array<object>', 'array']],
      ['_id', ['ObjectId']],
      ['tags', ['array<string|Int32>']],
      ['at', ['date']],
      ['uid', ['Long']],
      ['heroes.<n>', ['object']],
      ['heroes.<id>', ['object']],
      ['bag.itemId', ['string']],
      ['bag.n', ['Int32']],
      ['heroes.<n>.star', ['Long']],
      ['heroes.<id>.star', ['Int32']],
    ]);
  });
});
