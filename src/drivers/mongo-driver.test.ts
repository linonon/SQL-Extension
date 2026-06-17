import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MongoDriver, deepFormatValue, deepFormatDocument } from './mongo-driver';
import { ObjectId, Long } from 'mongodb';

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

vi.mock('mongodb', () => {
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
  class FakeMongoClient {
    constructor() {
      // 代理到 mockClient
      return mockClient as unknown as FakeMongoClient;
    }
  }
  return {
    MongoClient: FakeMongoClient,
    ObjectId: FakeObjectId,
    Long: FakeLong,
    Int32: FakeInt32,
    Decimal128: FakeDecimal128,
    MinKey: FakeMinKey,
    MaxKey: FakeMaxKey,
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

  describe('execute', () => {
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
    });

    it('find 返回扁平化文档', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'abc', name: 'Alice', tags: ['a', 'b'] },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]._id).toBe('abc');
      expect(result.rows[0].tags).toBe('["a","b"]'); // 数组被 JSON.stringify
    });

    it('insertOne 返回 affectedRows', async () => {
      mockCollection.insertOne.mockResolvedValue({ insertedId: 'newid' });

      const result = await driver.execute('db.users.insertOne({"name": "New"})');
      expect(result.affectedRows).toBe(1);
      expect(result.rows).toEqual([]);
    });

    it('updateOne 返回 modifiedCount', async () => {
      mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

      const result = await driver.execute('db.users.updateOne({"_id": "x"}, {"$set": {"name": "Updated"}})');
      expect(result.affectedRows).toBe(1);
    });

    it('deleteOne 返回 deletedCount', async () => {
      mockCollection.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await driver.execute('db.users.deleteOne({"_id": "x"})');
      expect(result.affectedRows).toBe(1);
    });

    it('replaceOne 整文档替换, affectedRows 取 matchedCount', async () => {
      mockCollection.replaceOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const result = await driver.execute('db.users.replaceOne({"_id": "x"}, {"name": "Replaced"})');
      expect(result.affectedRows).toBe(1);
      // 替换文档是整文档 (无 $set operator)
      expect(mockCollection.replaceOne.mock.calls[0][1]).toEqual({ name: 'Replaced' });
    });

    it('replaceOne 用 EJSON _id filter 还原 ObjectId 类型', async () => {
      mockCollection.replaceOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      await driver.execute('db.users.replaceOne({"_id": {"$oid": "507f1f77bcf86cd799439011"}}, {"name": "X"})');

      const filterArg = mockCollection.replaceOne.mock.calls[0][0];
      expect(filterArg._id).toBeInstanceOf(ObjectId);
      expect(String(filterArg._id)).toBe('507f1f77bcf86cd799439011');
    });

    it('replaceOne 未匹配时 affectedRows=0 (matchedCount=0)', async () => {
      mockCollection.replaceOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

      const result = await driver.execute('db.users.replaceOne({"_id": 999}, {"name": "X"})');
      expect(result.affectedRows).toBe(0);
    });

    it('CRUD 传 autoConvertIds:false 时 24-hex 字符串 _id 不被强转 ObjectId (保字符串)', async () => {
      mockCollection.replaceOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      await driver.executeCancellable(
        'db.users.replaceOne({"_id":"507f1f77bcf86cd799439011"},{"name":"X"})',
        undefined,
        'mydb',
        { autoConvertIds: false },
      ).promise;
      const filterArg = mockCollection.replaceOne.mock.calls[0][0];
      expect(typeof filterArg._id).toBe('string');
      expect(filterArg._id).toBe('507f1f77bcf86cd799439011');
    });

    it('deleteOne 传 autoConvertIds:false 时字符串 _id 保字符串', async () => {
      mockCollection.deleteOne.mockResolvedValue({ deletedCount: 1 });
      await driver.executeCancellable(
        'db.users.deleteOne({"_id":"aaaaaaaaaaaaaaaaaaaaaaaa"})',
        undefined,
        'mydb',
        { autoConvertIds: false },
      ).promise;
      const filterArg = mockCollection.deleteOne.mock.calls[0][0];
      expect(typeof filterArg._id).toBe('string');
    });

    it('默认 (不传 options) 仍对 24-hex 字符串 _id 自动转 ObjectId (查询编辑器便利)', async () => {
      mockCollection.replaceOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      await driver.execute('db.users.replaceOne({"_id":"507f1f77bcf86cd799439011"},{"name":"X"})');
      const filterArg = mockCollection.replaceOne.mock.calls[0][0];
      expect(filterArg._id).toBeInstanceOf(ObjectId);
    });

    it('explainFind 返回精简 explain 摘要 (全表扫描)', async () => {
      mockCollection.find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        explain: vi.fn().mockResolvedValue({
          queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
          executionStats: { nReturned: 1, totalDocsExamined: 50, totalKeysExamined: 0, executionTimeMillis: 3 },
        }),
      });

      const s = await (driver as any).explainFind('mydb', 'users', { age: { $gt: 18 } });
      expect(s.isCollScan).toBe(true);
      expect(s.docsExamined).toBe(50);
      expect(s.nReturned).toBe(1);
    });

    it('explainFind 带 EJSON _id filter 还原类型后 explain', async () => {
      const explain = vi.fn().mockResolvedValue({
        queryPlanner: { winningPlan: { stage: 'IDHACK' } },
        executionStats: { nReturned: 1, totalDocsExamined: 1, totalKeysExamined: 1, executionTimeMillis: 0 },
      });
      mockCollection.find.mockReturnValue({ sort: vi.fn().mockReturnThis(), explain });

      await (driver as any).explainFind('mydb', 'users', { _id: { $oid: '507f1f77bcf86cd799439011' } });
      const filterArg = mockCollection.find.mock.calls[0][0];
      expect(filterArg._id).toBeInstanceOf(ObjectId);
    });

    it('deleteMany 返回 deletedCount', async () => {
      mockCollection.deleteMany.mockResolvedValue({ deletedCount: 5 });

      const result = await driver.execute('db.logs.deleteMany({"level": "debug"})');
      expect(result.affectedRows).toBe(5);
    });

    it('aggregate 返回文档', async () => {
      mockCollection.aggregate.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { _id: 'active', count: 10 },
        ]),
      });

      const result = await driver.execute('db.orders.aggregate([{"$group": {"_id": "$status", "count": {"$sum": 1}}}])');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]._id).toBe('active');
    });

    it('countDocuments 返回 count', async () => {
      mockCollection.countDocuments.mockResolvedValue(42);

      const result = await driver.execute('db.users.countDocuments({})');
      expect(result.rows).toEqual([{ count: 42 }]);
    });

    it('executeCancellable 使用指定 database', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      const { promise } = driver.executeCancellable('db.users.find({})', [], 'otherdb');
      const result = await promise;
      expect(result.rows).toEqual([]);
      expect(mockClient.db).toHaveBeenCalledWith('otherdb');
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

  describe('flattenValue via execute/find', () => {
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
    });

    it('ObjectId 扁平化为 ObjectId("...")', async () => {
      // 从 mock 中拿到 FakeObjectId
      const { ObjectId } = await import('mongodb');
      const oid = new ObjectId('aabbccddee112233aabbccdd');

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: oid, name: 'test' },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0]._id).toBe('ObjectId("aabbccddee112233aabbccdd")');
    });

    it('Date 扁平化为 ISODate("...")', async () => {
      const date = new Date('2024-06-15T10:30:00.000Z');

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', createdAt: date },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0].createdAt).toBe('ISODate("2024-06-15T10:30:00.000Z")');
    });

    it('Long 扁平化为 NumberLong("...")', async () => {
      const { Long } = await import('mongodb');
      const longVal = Long.fromString('9999999999');

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', bigNum: longVal },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0].bigNum).toBe('NumberLong("9999999999")');
    });

    it('Int32 扁平化为 NumberInt(...)', async () => {
      const { Int32 } = await import('mongodb');
      const intVal = new Int32(42);

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', count: intVal },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0].count).toBe('NumberInt(42)');
    });

    it('Decimal128 扁平化为 NumberDecimal("...")', async () => {
      const { Decimal128 } = await import('mongodb');
      const decVal = new Decimal128('3.14159');

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', price: decVal },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0].price).toBe('NumberDecimal("3.14159")');
    });

    it('MinKey 扁平化为 MinKey()', async () => {
      const { MinKey } = await import('mongodb');

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', lower: new MinKey() },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0].lower).toBe('MinKey()');
    });

    it('MaxKey 扁平化为 MaxKey()', async () => {
      const { MaxKey } = await import('mongodb');

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', upper: new MaxKey() },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0].upper).toBe('MaxKey()');
    });

    it('null/undefined 值扁平化为 null', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', empty: null, missing: undefined },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      expect(result.rows[0].empty).toBeNull();
      expect(result.rows[0].missing).toBeNull();
    });

    it('嵌套对象含 BSON 类型被 JSON.stringify', async () => {
      const { ObjectId } = await import('mongodb');
      const oid = new ObjectId('aabbccddee112233aabbccdd');

      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: 'id1', meta: { ref: oid, count: 5 } },
          ]),
        }),
      });

      const result = await driver.execute('db.users.find({})');
      // 嵌套对象 flattenValue 会递归然后 JSON.stringify
      const parsed = JSON.parse(result.rows[0].meta as string);
      expect(parsed.ref).toBe('ObjectId("aabbccddee112233aabbccdd")');
      expect(parsed.count).toBe(5);
    });
  });

  describe('autoConvertIds (via find)', () => {
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
    });

    it('24 位 hex _id 自动转为 ObjectId', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      await driver.execute('db.users.find({"_id": "507f1f77bcf86cd799439011"})');

      const filterArg = mockCollection.find.mock.calls[0][0];
      const { ObjectId } = await import('mongodb');
      expect(filterArg._id).toBeInstanceOf(ObjectId);
    });

    it('非 24 位 hex _id 保持 string', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      await driver.execute('db.users.find({"_id": "not-a-valid-hex"})');

      const filterArg = mockCollection.find.mock.calls[0][0];
      expect(filterArg._id).toBe('not-a-valid-hex');
    });

    it('大写 hex _id 也能自动转换', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      await driver.execute('db.users.find({"_id": "507F1F77BCF86CD799439011"})');

      const filterArg = mockCollection.find.mock.calls[0][0];
      const { ObjectId } = await import('mongodb');
      expect(filterArg._id).toBeInstanceOf(ObjectId);
    });

    it('非 _id 字段的 24 位 hex 不转换', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      await driver.execute('db.users.find({"name": "507f1f77bcf86cd799439011"})');

      const filterArg = mockCollection.find.mock.calls[0][0];
      expect(filterArg.name).toBe('507f1f77bcf86cd799439011');
    });
  });

  describe('insertOne with EJSON', () => {
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
    });

    it('{"$date":"..."} 传入后 insertOne 收到 Date 实例', async () => {
      mockCollection.insertOne.mockResolvedValue({ insertedId: 'newid' });

      await driver.execute('db.users.insertOne({"name": "Alice", "createdAt": {"$date": "2024-01-15T00:00:00.000Z"}})');

      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
      const arg = mockCollection.insertOne.mock.calls[0][0];
      expect(arg.name).toBe('Alice');
      expect(arg.createdAt).toBeInstanceOf(Date);
      expect(arg.createdAt.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });
  });

  describe('updateOne with EJSON', () => {
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
    });

    it('$set 中的 {"$date":"..."} 被转为 Date 实例', async () => {
      mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await driver.execute('db.users.updateOne({"_id": "x"}, {"$set": {"updatedAt": {"$date": "2024-06-01T12:00:00.000Z"}}})');

      expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
      const updateArg = mockCollection.updateOne.mock.calls[0][1];
      expect(updateArg.$set.updatedAt).toBeInstanceOf(Date);
      expect(updateArg.$set.updatedAt.toISOString()).toBe('2024-06-01T12:00:00.000Z');
    });
  });

  describe('EJSON + autoConvertIds 端到端集成', () => {
    beforeEach(async () => {
      mockDb.command.mockResolvedValue({ ok: 1 });
      await driver.connect({
        id: 'test', name: 'test', driverType: 'mongodb',
        host: 'localhost', port: 27017, username: '', password: '', database: '',
      });
    });

    it('find 中 {"$oid":"..."} filter 经 convertEjsonToBson + autoConvertIds 完整链路', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      // 使用 EJSON 格式的 _id
      await driver.execute('db.users.find({"_id": {"$oid": "507f1f77bcf86cd799439011"}})');

      const filterArg = mockCollection.find.mock.calls[0][0];
      const { ObjectId } = await import('mongodb');
      // convertEjsonToBson 把 {"$oid":"..."} 转成 ObjectId 实例
      expect(filterArg._id).toBeInstanceOf(ObjectId);
      expect(filterArg._id.toString()).toBe('507f1f77bcf86cd799439011');
    });

    it('updateOne 带 ObjectId filter + ISODate body', async () => {
      mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await driver.execute('db.users.updateOne({"_id": {"$oid": "507f1f77bcf86cd799439011"}}, {"$set": {"lastLogin": {"$date": "2024-06-01T00:00:00.000Z"}}})');

      const { ObjectId } = await import('mongodb');
      const filterArg = mockCollection.updateOne.mock.calls[0][0];
      expect(filterArg._id).toBeInstanceOf(ObjectId);

      const updateArg = mockCollection.updateOne.mock.calls[0][1];
      expect(updateArg.$set.lastLogin).toBeInstanceOf(Date);
      expect(updateArg.$set.lastLogin.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    });

    it('find 带 NumberLong filter', async () => {
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      await driver.execute('db.events.find({"timestamp": {"$numberLong": "1700000000000"}})');

      const filterArg = mockCollection.find.mock.calls[0][0];
      const { Long } = await import('mongodb');
      expect(filterArg.timestamp).toBeInstanceOf(Long);
    });

    it('aggregate pipeline 中的 EJSON 类型被转换', async () => {
      mockCollection.aggregate.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: null, count: 5 }]),
      });

      await driver.execute('db.events.aggregate([{"$match": {"date": {"$gt": {"$date": "2024-01-01T00:00:00.000Z"}}}}])');

      const pipelineArg = mockCollection.aggregate.mock.calls[0][0];
      const matchStage = pipelineArg[0].$match;
      expect(matchStage.date.$gt).toBeInstanceOf(Date);
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

      expect(res.rows[0].bind).toEqual({ aid: 'w-1' });
      expect(res.rows[0]._id).toBe(`ObjectId("${'b'.repeat(24)}")`);
      expect(res.columns.some((c) => c.name === '_id')).toBe(true);
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
});
