import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMongoMessage } from './mongo-message-handler';
import type { IDatabaseDriver } from '../types/driver';
import type { WebviewMessage } from '../types/messages';

function createMockDriver(): IDatabaseDriver {
  return {
    driverType: 'mongodb',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    listDatabases: vi.fn().mockResolvedValue([]),
    listTables: vi.fn().mockResolvedValue([]),
    listColumns: vi.fn().mockResolvedValue([]),
    getTableDDL: vi.fn().mockResolvedValue(''),
    getDetailedColumns: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({ columns: [], rows: [], affectedRows: 0, executionTime: 0 }),
    executeCancellable: vi.fn().mockReturnValue({
      promise: Promise.resolve({ columns: [], rows: [], affectedRows: 0, executionTime: 0 }),
      cancel: vi.fn(),
    }),
  };
}

describe('handleMongoMessage', () => {
  let driver: IDatabaseDriver;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    driver = createMockDriver();
    postMessage = vi.fn();
  });

  it('非 mongo 消息返回 false', async () => {
    const msg = { type: 'executeQuery', database: 'test', sql: 'SELECT 1' } as WebviewMessage;
    const handled = await handleMongoMessage(msg, driver, postMessage);
    expect(handled).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  describe('mongoListDatabases', () => {
    it('调用 driver.listDatabases, 返回 mongoDatabaseList', async () => {
      const databases = ['admin', 'test', 'mydb'];
      (driver.listDatabases as any).mockResolvedValue(databases);

      const msg = { type: 'mongoListDatabases' } as WebviewMessage;
      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.listDatabases).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoDatabaseList',
        databases,
      });
    });
  });

  describe('mongoListAllCollections', () => {
    it('遍历所有 database 获取 collections', async () => {
      (driver.listDatabases as any).mockResolvedValue(['db1', 'db2']);
      (driver.listTables as any)
        .mockResolvedValueOnce([{ name: 'users', schema: '', rowCount: 100 }])
        .mockResolvedValueOnce([
          { name: 'orders', schema: '', rowCount: 50 },
          { name: 'products', schema: '', rowCount: 0 },
        ]);

      const msg = { type: 'mongoListAllCollections' } as WebviewMessage;
      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.listTables).toHaveBeenCalledWith('db1');
      expect(driver.listTables).toHaveBeenCalledWith('db2');
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoAllCollectionList',
        collections: [
          { database: 'db1', name: 'users', count: 100 },
          { database: 'db2', name: 'orders', count: 50 },
          { database: 'db2', name: 'products', count: 0 },
        ],
      });
    });

    it('rowCount 为 undefined 时用 0', async () => {
      (driver.listDatabases as any).mockResolvedValue(['db1']);
      (driver.listTables as any).mockResolvedValue([
        { name: 'col1', schema: '', rowCount: undefined },
      ]);

      const msg = { type: 'mongoListAllCollections' } as WebviewMessage;
      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoAllCollectionList',
        collections: [{ database: 'db1', name: 'col1', count: 0 }],
      });
    });
  });

  describe('mongoListCollections', () => {
    it('调用 driver.listTables, 返回 mongoCollectionList', async () => {
      (driver.listTables as any).mockResolvedValue([
        { name: 'users', schema: '', rowCount: 42 },
        { name: 'posts', schema: '', rowCount: 0 },
      ]);

      const msg = { type: 'mongoListCollections', database: 'mydb' } as WebviewMessage;
      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.listTables).toHaveBeenCalledWith('mydb');
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoCollectionList',
        collections: [
          { name: 'users', count: 42 },
          { name: 'posts', count: 0 },
        ],
      });
    });
  });

  describe('mongoFindDocuments', () => {
    it('正常路径: 构建 aggregate pipeline 并返回结果', async () => {
      const docsResult = {
        columns: [{ name: '_id', dataType: 'string', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' }],
        rows: [{ _id: '1', name: 'Alice' }],
      };
      const countResult = {
        columns: [],
        rows: [{ count: 1 }],
        affectedRows: 0,
        executionTime: 5,
      };

      // 文档通过 findDocumentsForBrowser 获取, count 仍走 executeCancellable
      (driver as any).findDocumentsForBrowser = vi.fn().mockResolvedValue(docsResult);
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve(countResult),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoFindDocuments',
        database: 'mydb',
        collection: 'users',
        filter: '',
        sort: '',
        projection: undefined,
        skip: 0,
        limit: 20,
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoDocumentList',
        columns: docsResult.columns,
        rows: docsResult.rows,
        total: 1,
      });
    });

    it('driver 抛错时返回 error', async () => {
      // findDocumentsForBrowser 抛错时 catch 块捕获并返回 error
      (driver as any).findDocumentsForBrowser = vi.fn().mockRejectedValue(new Error('aggregation failed'));

      const msg = {
        type: 'mongoFindDocuments',
        database: 'mydb',
        collection: 'users',
        filter: '',
        sort: '',
        skip: 0,
        limit: 20,
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoDocumentList',
        columns: [],
        rows: [],
        total: 0,
        error: 'aggregation failed',
      });
    });

    it('countResult 为空 rows 时 total = 0', async () => {
      // findDocumentsForBrowser 返回空 rows, executeCancellable 处理 count 返回空
      (driver as any).findDocumentsForBrowser = vi.fn().mockResolvedValue({ columns: [], rows: [] });
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve({ columns: [], rows: [], affectedRows: 0, executionTime: 0 }),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoFindDocuments',
        database: 'mydb',
        collection: 'users',
        filter: '',
        sort: '',
        skip: 0,
        limit: 20,
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ total: 0 })
      );
    });
  });

  describe('mongoInsertDocument', () => {
    it('正常路径: 调用 executeCancellable 返回 success', async () => {
      const msg = {
        type: 'mongoInsertDocument',
        database: 'mydb',
        collection: 'users',
        document: { name: 'Bob', age: 25 },
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.executeCancellable).toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: true,
      });
    });

    it('driver 抛错时返回 success: false + error', async () => {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.reject(new Error('insert failed')),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoInsertDocument',
        database: 'mydb',
        collection: 'users',
        document: { name: 'Bob' },
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: false,
        error: 'insert failed',
      });
    });
  });

  describe('mongoUpdateDocument', () => {
    // id 字段携带 _id 的 shell 形式 (idToShell 产出), 经 convertShellToJson 还原类型

    function mockAffected(n: number) {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve({ columns: [], rows: [], affectedRows: n, executionTime: 0 }),
        cancel: vi.fn(),
      });
    }

    it('用 replaceOne 整文档替换 (删字段生效), 命中返回 success + affectedRows', async () => {
      mockAffected(1);
      const msg = {
        type: 'mongoUpdateDocument',
        database: 'mydb',
        collection: 'users',
        id: '"abc123"',
        document: { name: 'Updated' },
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.executeCancellable).toHaveBeenCalledWith(
        expect.stringContaining('replaceOne'),
        undefined,
        'mydb',
        { autoConvertIds: false },
      );
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: true,
        affectedRows: 1,
      });
    });

    it('ObjectId shell _id 还原为 EJSON $oid (保留类型)', async () => {
      mockAffected(1);
      const msg = {
        type: 'mongoUpdateDocument',
        database: 'mydb',
        collection: 'users',
        id: 'ObjectId("507f1f77bcf86cd799439011")',
        document: { name: 'X' },
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      const query = (driver.executeCancellable as any).mock.calls[0][0] as string;
      expect(query).toContain('{"_id":{"$oid":"507f1f77bcf86cd799439011"}}');
    });

    it('数字 _id 不被当字符串 (保留数值类型)', async () => {
      mockAffected(1);
      const msg = {
        type: 'mongoUpdateDocument',
        database: 'mydb',
        collection: 'users',
        id: '1102025811',
        document: { name: 'X' },
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      const query = (driver.executeCancellable as any).mock.calls[0][0] as string;
      expect(query).toContain('{"_id":1102025811}');
      expect(query).not.toContain('{"_id":"1102025811"}');
    });

    it('未匹配 (affectedRows=0) -> success:false + 提示, 不静默成功', async () => {
      mockAffected(0);
      const msg = {
        type: 'mongoUpdateDocument',
        database: 'mydb',
        collection: 'users',
        id: '999',
        document: { name: 'X' },
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      const posted = postMessage.mock.calls[0][0];
      expect(posted.type).toBe('mongoOperationResult');
      expect(posted.success).toBe(false);
      expect(posted.error).toMatch(/_id/);
    });

    it('driver 抛错时返回 error', async () => {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.reject(new Error('update failed')),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoUpdateDocument',
        database: 'mydb',
        collection: 'users',
        id: '"abc123"',
        document: { name: 'Bad' },
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: false,
        error: 'update failed',
      });
    });
  });

  describe('mongoUpdateField (单元格原地编辑, 局部 $set)', () => {
    function mockAffected(n: number) {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve({ columns: [], rows: [], affectedRows: n, executionTime: 0 }),
        cancel: vi.fn(),
      });
    }

    it('构建 updateOne + $set dotted path, _id 走 EJSON 保留类型', async () => {
      mockAffected(1);
      const msg = {
        type: 'mongoUpdateField',
        database: 'mydb',
        collection: 'users',
        id: 'ObjectId("507f1f77bcf86cd799439011")',
        path: 'bind.aid',
        value: 'w-9',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      const query = (driver.executeCancellable as any).mock.calls[0][0] as string;
      expect(query).toContain('updateOne');
      expect(query).toContain('{"_id":{"$oid":"507f1f77bcf86cd799439011"}}');
      expect(query).toContain('{"$set":{"bind.aid":"w-9"}}');
      // CRUD filter 已显式带类型, 须跳过 24-hex autoConvert (review GAP2)
      expect((driver.executeCancellable as any).mock.calls[0][3]).toEqual({ autoConvertIds: false });
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: true,
        affectedRows: 1,
      });
    });

    it('数字值不加引号 (保留类型)', async () => {
      mockAffected(1);
      const msg = {
        type: 'mongoUpdateField',
        database: 'd',
        collection: 'c',
        id: '1',
        path: 'age',
        value: 30,
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      const query = (driver.executeCancellable as any).mock.calls[0][0] as string;
      expect(query).toContain('{"$set":{"age":30}}');
    });

    it('未匹配 (affectedRows=0) -> success:false', async () => {
      mockAffected(0);
      const msg = {
        type: 'mongoUpdateField',
        database: 'd',
        collection: 'c',
        id: '"abc"',
        path: 'name',
        value: 'x',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);
      const posted = postMessage.mock.calls[0][0];
      expect(posted.success).toBe(false);
    });
  });

  describe('mongoDeleteDocument', () => {
    function mockAffected(n: number) {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve({ columns: [], rows: [], affectedRows: n, executionTime: 0 }),
        cancel: vi.fn(),
      });
    }

    it('用 deleteOne, 命中返回 success', async () => {
      mockAffected(1);
      const msg = {
        type: 'mongoDeleteDocument',
        database: 'mydb',
        collection: 'users',
        id: 'ObjectId("507f1f77bcf86cd799439011")',
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      const query = (driver.executeCancellable as any).mock.calls[0][0] as string;
      expect(query).toContain('deleteOne');
      expect(query).toContain('{"_id":{"$oid":"507f1f77bcf86cd799439011"}}');
      expect((driver.executeCancellable as any).mock.calls[0][3]).toEqual({ autoConvertIds: false });
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: true,
        affectedRows: 1,
      });
    });

    it('未匹配 (affectedRows=0) -> success:false', async () => {
      mockAffected(0);
      const msg = {
        type: 'mongoDeleteDocument',
        database: 'mydb',
        collection: 'users',
        id: '999',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      const posted = postMessage.mock.calls[0][0];
      expect(posted.success).toBe(false);
      expect(posted.error).toMatch(/_id/);
    });

    it('driver 抛错时返回 error', async () => {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.reject(new Error('delete failed')),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoDeleteDocument',
        database: 'mydb',
        collection: 'users',
        id: '"abc123"',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: false,
        error: 'delete failed',
      });
    });
  });

  describe('mongoFindDocuments 深取数', () => {
    it('用 findDocumentsForBrowser 的嵌套 rows 发 mongoDocumentList', async () => {
      const posted: any[] = [];
      const driver: any = {
        findDocumentsForBrowser: vi.fn().mockResolvedValue({
          rows: [{ _id: 'ObjectId("c")', bind: { aid: 'w-1' } }],
          columns: [{ name: '_id', dataType: 'ObjectId', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' }],
        }),
        executeCancellable: vi.fn().mockReturnValue({
          promise: Promise.resolve({ columns: [], rows: [{ count: 1 }], affectedRows: 0, executionTime: 0 }),
          cancel: vi.fn(),
        }),
      };

      await handleMongoMessage(
        { type: 'mongoFindDocuments', database: 'db', collection: 'coll', filter: '', sort: '', projection: '', skip: 0, limit: 50 } as any,
        driver,
        (m) => posted.push(m),
      );

      expect(driver.findDocumentsForBrowser).toHaveBeenCalledWith('db', 'coll', expect.any(Array));
      const list = posted.find((m) => m.type === 'mongoDocumentList');
      expect(list.rows[0].bind).toEqual({ aid: 'w-1' });
      expect(list.total).toBe(1);
    });
  });

  describe('mongoExplainQuery', () => {
    it('调用 driver.explainFind 并返回 mongoExplainResult', async () => {
      const summary = { stage: 'COLLSCAN', docsExamined: 100, keysExamined: 0, nReturned: 3, executionTimeMillis: 5, isCollScan: true };
      (driver as any).explainFind = vi.fn().mockResolvedValue(summary);

      const msg = {
        type: 'mongoExplainQuery',
        database: 'mydb',
        collection: 'users',
        filter: '{"age": {"$gt": 18}}',
        sort: '',
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect((driver as any).explainFind).toHaveBeenCalledWith('mydb', 'users', { age: { $gt: 18 } }, undefined);
      expect(postMessage).toHaveBeenCalledWith({ type: 'mongoExplainResult', summary });
    });

    it('sort 非空时解析后传给 explainFind (第四参非 undefined) — M8', async () => {
      const summary = { stage: 'IXSCAN', indexName: 'age_-1', docsExamined: 1, keysExamined: 1, nReturned: 1, executionTimeMillis: 0, isCollScan: false };
      (driver as any).explainFind = vi.fn().mockResolvedValue(summary);

      const msg = {
        type: 'mongoExplainQuery',
        database: 'mydb',
        collection: 'users',
        filter: '',
        sort: '{"age": -1}',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);
      expect((driver as any).explainFind).toHaveBeenCalledWith('mydb', 'users', {}, { age: -1 });
    });

    it('explainFind 抛错时返回 error', async () => {
      (driver as any).explainFind = vi.fn().mockRejectedValue(new Error('explain failed'));

      const msg = {
        type: 'mongoExplainQuery',
        database: 'mydb',
        collection: 'users',
        filter: '',
        sort: '',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);
      expect(postMessage).toHaveBeenCalledWith({ type: 'mongoExplainResult', error: 'explain failed' });
    });
  });

  describe('mongoCountDocuments', () => {
    it('正常路径: 返回 total', async () => {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve({
          columns: [],
          rows: [{ count: 42 }],
          affectedRows: 0,
          executionTime: 5,
        }),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoCountDocuments',
        database: 'mydb',
        collection: 'users',
        filter: '',
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoDocumentList',
        columns: [],
        rows: [],
        total: 42,
      });
    });

    it('空 rows 时 total = 0', async () => {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve({
          columns: [],
          rows: [],
          affectedRows: 0,
          executionTime: 5,
        }),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoCountDocuments',
        database: 'mydb',
        collection: 'users',
        filter: '',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoDocumentList',
        columns: [],
        rows: [],
        total: 0,
      });
    });

    it('driver 抛错时返回 error', async () => {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.reject(new Error('count failed')),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoCountDocuments',
        database: 'mydb',
        collection: 'users',
        filter: '{ invalid }',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoDocumentList',
        columns: [],
        rows: [],
        total: 0,
        error: 'count failed',
      });
    });

    it('带 filter 时构建 countDocuments query', async () => {
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.resolve({ columns: [], rows: [{ count: 5 }], affectedRows: 0, executionTime: 0 }),
        cancel: vi.fn(),
      });

      const msg = {
        type: 'mongoCountDocuments',
        database: 'mydb',
        collection: 'users',
        filter: '{"age": 25}',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(driver.executeCancellable).toHaveBeenCalledWith(
        expect.stringContaining('countDocuments'),
        undefined,
        'mydb'
      );
    });
  });
});
