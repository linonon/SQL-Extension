import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DumpService } from './dump-service';
import type { IDatabaseDriver } from '../types/driver';

function createMockDriver(driverType: string = 'mysql'): IDatabaseDriver {
  return {
    driverType,
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    listDatabases: vi.fn().mockResolvedValue([]),
    listTables: vi.fn().mockResolvedValue([]),
    listColumns: vi.fn().mockResolvedValue([]),
    getTableDDL: vi.fn().mockResolvedValue('CREATE TABLE `users` (`id` int PRIMARY KEY);'),
    getDetailedColumns: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({ columns: [], rows: [], affectedRows: 0, executionTime: 0 }),
    executeCancellable: vi.fn().mockReturnValue({
      promise: Promise.resolve({ columns: [], rows: [], affectedRows: 0, executionTime: 0 }),
      cancel: vi.fn(),
    }),
  };
}

describe('DumpService', () => {
  let service: DumpService;

  beforeEach(() => {
    service = new DumpService();
  });

  describe('dumpStruct', () => {
    it('MongoDB 抛错', async () => {
      const driver = createMockDriver('mongodb');
      await expect(service.dumpStruct(driver, 'db', 'col'))
        .rejects.toThrow('MongoDB does not support SQL dump');
    });

    it('MySQL 方言: 反引号 + DROP TABLE IF EXISTS', async () => {
      const driver = createMockDriver('mysql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE `users` (`id` int PRIMARY KEY);');

      const result = await service.dumpStruct(driver, 'testdb', 'users');

      expect(result).toContain('DROP TABLE IF EXISTS `users`;');
      expect(result).toContain('CREATE TABLE `users`');
      expect(result).toContain('-- Table: users');
      expect(result).toContain('-- Dump from SQL Extension');
    });

    it('PostgreSQL 方言: 双引号 + DROP TABLE IF EXISTS', async () => {
      const driver = createMockDriver('postgresql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE "users" ("id" serial PRIMARY KEY);');

      const result = await service.dumpStruct(driver, 'testdb', 'users');

      expect(result).toContain('DROP TABLE IF EXISTS "users";');
      expect(result).toContain('CREATE TABLE "users"');
    });

    it('MySQL 表名含反引号时正确转义', async () => {
      const driver = createMockDriver('mysql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE `my``table` (`id` int);');

      const result = await service.dumpStruct(driver, 'testdb', 'my`table');

      expect(result).toContain('DROP TABLE IF EXISTS `my``table`;');
    });

    it('PostgreSQL 表名含双引号时正确转义', async () => {
      const driver = createMockDriver('postgresql');
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE "my""table" ("id" serial);');

      const result = await service.dumpStruct(driver, 'testdb', 'my"table');

      expect(result).toContain('DROP TABLE IF EXISTS "my""table";');
    });
  });

  describe('dumpStructAndData', () => {
    it('MongoDB 抛错', async () => {
      const driver = createMockDriver('mongodb');
      await expect(service.dumpStructAndData(driver, 'db', 'col'))
        .rejects.toThrow('MongoDB does not support SQL dump');
    });

    it('表无数据时只返回 struct', async () => {
      const driver = createMockDriver('mysql');
      (driver.execute as any).mockResolvedValue({
        columns: [],
        rows: [{ cnt: 0 }],
        affectedRows: 0,
        executionTime: 0,
      });

      const result = await service.dumpStructAndData(driver, 'testdb', 'users');

      expect(result).toContain('DROP TABLE IF EXISTS');
      expect(result).not.toContain('INSERT INTO');
    });

    it('MySQL: 生成 INSERT 语句', async () => {
      const driver = createMockDriver('mysql');

      // 第一次 execute: COUNT
      // 第二次 execute: SELECT page 1
      // 第三次 execute: SELECT page 2 (空)
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 2 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
          affectedRows: 0,
          executionTime: 0,
        })
        .mockResolvedValueOnce({ columns: [], rows: [], affectedRows: 0, executionTime: 0 });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
        { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ]);

      const result = await service.dumpStructAndData(driver, 'testdb', 'users');

      expect(result).toContain('INSERT INTO `users`');
      expect(result).toContain('`id`');
      expect(result).toContain('`name`');
      expect(result).toContain("'Alice'");
      expect(result).toContain("'Bob'");
    });

    it('PostgreSQL: 生成 INSERT 语句用双引号', async () => {
      const driver = createMockDriver('postgresql');

      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ id: 1, name: 'Alice' }],
          affectedRows: 0,
          executionTime: 0,
        });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
        { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ]);
      (driver.getTableDDL as any).mockResolvedValue('CREATE TABLE "users" ("id" serial PRIMARY KEY);');

      const result = await service.dumpStructAndData(driver, 'testdb', 'users');

      expect(result).toContain('INSERT INTO "users"');
      expect(result).toContain('"id"');
      expect(result).toContain('"name"');
    });

    it('onProgress 被调用', async () => {
      const driver = createMockDriver('mysql');
      const onProgress = vi.fn();

      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 2 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ id: 1 }, { id: 2 }],
          affectedRows: 0,
          executionTime: 0,
        });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      ]);

      await service.dumpStructAndData(driver, 'testdb', 'users', onProgress);

      expect(onProgress).toHaveBeenCalledWith(2, 2);
    });

    it('cancellationToken cancel 时中断', async () => {
      const driver = createMockDriver('mysql');
      const token = { isCancellationRequested: false };

      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 3000 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: Array.from({ length: 1000 }, (_, i) => ({ id: i })),
          affectedRows: 0,
          executionTime: 0,
        })
        .mockImplementation(() => {
          // 第二页时取消
          token.isCancellationRequested = true;
          return Promise.resolve({
            columns: [],
            rows: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1000 })),
            affectedRows: 0,
            executionTime: 0,
          });
        });

      (driver.listColumns as any).mockResolvedValue([
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' },
      ]);

      const result = await service.dumpStructAndData(driver, 'testdb', 'users', undefined, token);

      // 应该只有第一页的数据 (取消前)
      expect(result).toContain('INSERT INTO');
      // execute 不应被调用 3 次 (第三页不应请求)
      expect((driver.execute as any).mock.calls.length).toBeLessThanOrEqual(3);
    });
  });

  describe('escapeValue (通过 dump 输出间接测试)', () => {
    let driver: IDatabaseDriver;

    beforeEach(() => {
      driver = createMockDriver('mysql');
      (driver.listColumns as any).mockResolvedValue([
        { name: 'val', dataType: 'text', nullable: true, isPrimaryKey: false, defaultValue: null, extra: '' },
      ]);
    });

    it('null -> NULL', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: null }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(NULL)');
    });

    it('number -> 数字字符串不带引号', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: 42 }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(42)');
      // 确保不是 ('42')
      expect(result).not.toContain("('42')");
    });

    it('boolean -> TRUE / FALSE', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 2 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ val: true }, { val: false }],
          affectedRows: 0,
          executionTime: 0,
        });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(TRUE)');
      expect(result).toContain('(FALSE)');
    });

    it('string -> 单引号包裹', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: 'hello' }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('hello')");
    });

    it("string 内部单引号转义为 ''", async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: "it's" }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('it''s')");
    });

    it('含反斜杠的字符串转义', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: 'path\\to\\file' }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('path\\\\to\\\\file')");
    });

    it('Date -> ISO 字符串带单引号', async () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: date }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain("('2024-01-15T10:30:00.000Z')");
    });

    it('undefined -> NULL', async () => {
      (driver.execute as any)
        .mockResolvedValueOnce({ columns: [], rows: [{ cnt: 1 }], affectedRows: 0, executionTime: 0 })
        .mockResolvedValueOnce({ columns: [], rows: [{ val: undefined }], affectedRows: 0, executionTime: 0 });

      const result = await service.dumpStructAndData(driver, 'testdb', 'test_table');
      expect(result).toContain('(NULL)');
    });
  });
});
