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
        affectedRows: 0,
        executionTime: 10,
      };
      const countResult = {
        columns: [],
        rows: [{ count: 1 }],
        affectedRows: 0,
        executionTime: 5,
      };

      (driver.executeCancellable as any).mockImplementation((query: string) => {
        if (query.includes('countDocuments')) {
          return { promise: Promise.resolve(countResult), cancel: vi.fn() };
        }
        return { promise: Promise.resolve(docsResult), cancel: vi.fn() };
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
      (driver.executeCancellable as any).mockReturnValue({
        promise: Promise.reject(new Error('aggregation failed')),
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
    it('正常路径: 调用 executeCancellable 返回 success', async () => {
      const msg = {
        type: 'mongoUpdateDocument',
        database: 'mydb',
        collection: 'users',
        id: 'abc123',
        document: { name: 'Updated' },
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: true,
      });
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
        id: 'abc123',
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

  describe('mongoDeleteDocument', () => {
    it('正常路径: 调用 executeCancellable 返回 success', async () => {
      const msg = {
        type: 'mongoDeleteDocument',
        database: 'mydb',
        collection: 'users',
        id: 'abc123',
      } as WebviewMessage;

      const handled = await handleMongoMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: true,
      });
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
        id: 'abc123',
      } as WebviewMessage;

      await handleMongoMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'mongoOperationResult',
        success: false,
        error: 'delete failed',
      });
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
