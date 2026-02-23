import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryService } from './query-service';
import type { IDatabaseDriver } from '../types/driver';
import type { ColumnInfo, QueryResult } from '../types/query';

describe('QueryService', () => {
  let service: QueryService;
  let mockDriver: IDatabaseDriver;

  beforeEach(() => {
    service = new QueryService();

    // Mock driver
    mockDriver = {
      driverType: 'mysql',
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => true),
      listDatabases: vi.fn(),
      listTables: vi.fn(),
      listColumns: vi.fn(),
      getTableDDL: vi.fn(),
      getDetailedColumns: vi.fn(),
      execute: vi.fn(),
      executeCancellable: vi.fn(),
    };
  });

  describe('fetchRows', () => {
    it('应该获取分页数据和总数', async () => {
      const mockColumns: ColumnInfo[] = [
        {
          name: 'id',
          dataType: 'int',
          nullable: false,
          isPrimaryKey: true,
          defaultValue: null,
          extra: 'auto_increment',
        },
        {
          name: 'name',
          dataType: 'varchar',
          nullable: true,
          isPrimaryKey: false,
          defaultValue: null,
          extra: '',
        },
      ];

      // Mock COUNT 查询
      vi.mocked(mockDriver.execute).mockResolvedValueOnce({
        columns: [],
        rows: [{ count: 100 }],
        affectedRows: 0,
        executionTime: 10,
      } as QueryResult);

      // Mock SELECT 查询
      vi.mocked(mockDriver.execute).mockResolvedValueOnce({
        columns: mockColumns,
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        affectedRows: 0,
        executionTime: 20,
      } as QueryResult);

      // Mock listColumns
      vi.mocked(mockDriver.listColumns).mockResolvedValue(mockColumns);

      const result = await service.fetchRows(mockDriver, 'testdb', 'users', 0, 10);

      expect(result.total).toBe(100);
      expect(result.rows).toHaveLength(2);
      expect(result.columns).toEqual(mockColumns);
      expect(result.page).toEqual({ offset: 0, limit: 10 });

      // 验证调用了 COUNT 和 SELECT
      expect(mockDriver.execute).toHaveBeenCalledTimes(2);
      expect(mockDriver.listColumns).toHaveBeenCalledWith('testdb', 'users');
    });

    it('MySQL 应该生成正确的 SQL', async () => {
      mockDriver.driverType = 'mysql';

      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [{ count: 50 }],
        affectedRows: 0,
        executionTime: 5,
      } as QueryResult);

      vi.mocked(mockDriver.listColumns).mockResolvedValue([]);

      await service.fetchRows(mockDriver, 'mydb', 'users', 20, 10);

      // 第一次调用: COUNT
      expect(mockDriver.execute).toHaveBeenNthCalledWith(
        1,
        'SELECT COUNT(*) as count FROM `mydb`.`users`',
        []
      );

      // 第二次调用: SELECT
      expect(mockDriver.execute).toHaveBeenNthCalledWith(
        2,
        'SELECT * FROM `mydb`.`users` LIMIT ? OFFSET ?',
        [10, 20]
      );
    });

    it('PostgreSQL 应该生成正确的 SQL', async () => {
      mockDriver.driverType = 'postgresql';

      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [{ count: 50 }],
        affectedRows: 0,
        executionTime: 5,
      } as QueryResult);

      vi.mocked(mockDriver.listColumns).mockResolvedValue([]);

      await service.fetchRows(mockDriver, 'pgdb', 'users', 20, 10);

      // 第一次调用: COUNT (PG 不使用 database prefix)
      expect(mockDriver.execute).toHaveBeenNthCalledWith(
        1,
        'SELECT COUNT(*) as count FROM "users"',
        []
      );

      // 第二次调用: SELECT (PG 使用 $N 占位符)
      expect(mockDriver.execute).toHaveBeenNthCalledWith(
        2,
        'SELECT * FROM "users" LIMIT $1 OFFSET $2',
        [10, 20]
      );
    });

    it('应该处理空表情况', async () => {
      vi.mocked(mockDriver.execute)
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ count: 0 }],
          affectedRows: 0,
          executionTime: 5,
        } as QueryResult)
        .mockResolvedValueOnce({
          columns: [],
          rows: [],
          affectedRows: 0,
          executionTime: 5,
        } as QueryResult);

      vi.mocked(mockDriver.listColumns).mockResolvedValue([]);

      const result = await service.fetchRows(mockDriver, 'testdb', 'users', 0, 10);

      expect(result.total).toBe(0);
      expect(result.rows).toEqual([]);
    });
  });

  describe('insertRow', () => {
    it('应该插入行', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [],
        affectedRows: 1,
        executionTime: 10,
      } as QueryResult);

      const row = { name: 'Alice', age: 30 };
      const result = await service.insertRow(mockDriver, 'testdb', 'users', row);

      expect(result.affectedRows).toBe(1);
      expect(mockDriver.execute).toHaveBeenCalledWith(
        'INSERT INTO `testdb`.`users` (`name`, `age`) VALUES (?, ?)',
        ['Alice', 30]
      );
    });

    it('PostgreSQL 应该使用 $N 占位符', async () => {
      mockDriver.driverType = 'postgresql';

      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [],
        affectedRows: 1,
        executionTime: 10,
      } as QueryResult);

      const row = { name: 'Bob', age: 25 };
      await service.insertRow(mockDriver, 'testdb', 'users', row);

      expect(mockDriver.execute).toHaveBeenCalledWith(
        'INSERT INTO "users" ("name", "age") VALUES ($1, $2)',
        ['Bob', 25]
      );
    });
  });

  describe('updateRow', () => {
    it('应该更新行', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [],
        affectedRows: 1,
        executionTime: 10,
      } as QueryResult);

      const pk = { id: 1 };
      const changes = { name: 'Alice Updated', age: 31 };
      const result = await service.updateRow(
        mockDriver,
        'testdb',
        'users',
        pk,
        changes
      );

      expect(result.affectedRows).toBe(1);
      expect(mockDriver.execute).toHaveBeenCalledWith(
        'UPDATE `testdb`.`users` SET `name` = ?, `age` = ? WHERE `id` = ?',
        ['Alice Updated', 31, 1]
      );
    });

    it('应该支持复合主键', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [],
        affectedRows: 1,
        executionTime: 10,
      } as QueryResult);

      const pk = { user_id: 10, tenant_id: 20 };
      const changes = { status: 'active' };
      await service.updateRow(mockDriver, 'testdb', 'users', pk, changes);

      expect(mockDriver.execute).toHaveBeenCalledWith(
        'UPDATE `testdb`.`users` SET `status` = ? WHERE `user_id` = ? AND `tenant_id` = ?',
        ['active', 10, 20]
      );
    });
  });

  describe('deleteRow', () => {
    it('应该删除行', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [],
        affectedRows: 1,
        executionTime: 10,
      } as QueryResult);

      const pk = { id: 1 };
      const result = await service.deleteRow(mockDriver, 'testdb', 'users', pk);

      expect(result.affectedRows).toBe(1);
      expect(mockDriver.execute).toHaveBeenCalledWith(
        'DELETE FROM `testdb`.`users` WHERE `id` = ?',
        [1]
      );
    });

    it('应该支持复合主键', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [],
        affectedRows: 1,
        executionTime: 10,
      } as QueryResult);

      const pk = { user_id: 10, tenant_id: 20 };
      await service.deleteRow(mockDriver, 'testdb', 'users', pk);

      expect(mockDriver.execute).toHaveBeenCalledWith(
        'DELETE FROM `testdb`.`users` WHERE `user_id` = ? AND `tenant_id` = ?',
        [10, 20]
      );
    });
  });

  describe('error paths', () => {
    it('fetchRows 时 driver 抛错应传播错误', async () => {
      const error = new Error('Connection lost');
      vi.mocked(mockDriver.execute).mockRejectedValue(error);

      await expect(
        service.fetchRows(mockDriver, 'testdb', 'users', 0, 10)
      ).rejects.toThrow('Connection lost');
    });

    it('insertRow 时 driver 抛错应传播错误', async () => {
      const error = new Error('Duplicate entry');
      vi.mocked(mockDriver.execute).mockRejectedValue(error);

      await expect(
        service.insertRow(mockDriver, 'testdb', 'users', { name: 'Alice' })
      ).rejects.toThrow('Duplicate entry');
    });

    it('updateRow 时 driver 抛错应传播错误', async () => {
      const error = new Error('Deadlock found');
      vi.mocked(mockDriver.execute).mockRejectedValue(error);

      await expect(
        service.updateRow(mockDriver, 'testdb', 'users', { id: 1 }, { name: 'Bob' })
      ).rejects.toThrow('Deadlock found');
    });

    it('deleteRow 时 driver 抛错应传播错误', async () => {
      const error = new Error('Foreign key constraint');
      vi.mocked(mockDriver.execute).mockRejectedValue(error);

      await expect(
        service.deleteRow(mockDriver, 'testdb', 'users', { id: 1 })
      ).rejects.toThrow('Foreign key constraint');
    });
  });

  describe('executeRaw', () => {
    it('应该执行原始 SQL', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [
          {
            name: 'count',
            dataType: 'bigint',
            nullable: false,
            isPrimaryKey: false,
            defaultValue: null,
            extra: '',
          },
        ],
        rows: [{ count: 42 }],
        affectedRows: 0,
        executionTime: 15,
      } as QueryResult);

      const result = await service.executeRaw(
        mockDriver,
        'testdb',
        'SELECT COUNT(*) as count FROM users'
      );

      expect(result.rows).toEqual([{ count: 42 }]);
      expect(mockDriver.execute).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM users'
      );
    });

    it('raw SQL 不应该自动添加 database 前缀', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [],
        rows: [],
        affectedRows: 1,
        executionTime: 10,
      } as QueryResult);

      await service.executeRaw(mockDriver, 'testdb', 'DROP TABLE users');

      // 应该直接传递用户的 SQL, 不修改
      expect(mockDriver.execute).toHaveBeenCalledWith('DROP TABLE users');
    });
  });
});
