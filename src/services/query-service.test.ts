import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryService } from './query-service';
import { createMockDriver } from '../__mocks__/mock-driver';
import type { IDatabaseDriver } from '../types/driver';
import type { QueryResult } from '../types/query';

describe('QueryService', () => {
  let service: QueryService;
  let mockDriver: IDatabaseDriver;

  beforeEach(() => {
    service = new QueryService();

    mockDriver = createMockDriver();
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
      mockDriver = createMockDriver({ driverType: 'postgresql' });

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

  describe('error paths', () => {
    it('insertRow 时 driver 抛错应传播错误', async () => {
      const error = new Error('Duplicate entry');
      vi.mocked(mockDriver.execute).mockRejectedValue(error);

      await expect(
        service.insertRow(mockDriver, 'testdb', 'users', { name: 'Alice' })
      ).rejects.toThrow('Duplicate entry');
    });
  });

  describe('batchUpdate', () => {
    it('应该在单个事务内执行所有 update (原子)', async () => {
      const exec = vi.fn().mockResolvedValue({
        columns: [], rows: [], affectedRows: 1, executionTime: 1,
      } as QueryResult);
      mockDriver.transaction = vi.fn(async (work) => work(exec));

      await service.batchUpdate(mockDriver, 'testdb', 'users', [
        { primaryKeys: { id: 1 }, changes: { name: 'A' } },
        { primaryKeys: { id: 2 }, changes: { name: 'B' } },
      ]);

      expect(mockDriver.transaction).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenNthCalledWith(1, 'UPDATE `testdb`.`users` SET `name` = ? WHERE `id` = ?', ['A', 1]);
      expect(exec).toHaveBeenNthCalledWith(2, 'UPDATE `testdb`.`users` SET `name` = ? WHERE `id` = ?', ['B', 2]);
    });

    it('某行失败时错误传播 (由 driver.transaction 负责 rollback)', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ columns: [], rows: [], affectedRows: 1, executionTime: 1 } as QueryResult)
        .mockRejectedValueOnce(new Error('constraint violation'));
      mockDriver.transaction = vi.fn(async (work) => work(exec));

      await expect(service.batchUpdate(mockDriver, 'testdb', 'users', [
        { primaryKeys: { id: 1 }, changes: { name: 'A' } },
        { primaryKeys: { id: 2 }, changes: { name: 'B' } },
      ])).rejects.toThrow('constraint violation');
    });

    it.each([0, 2])('某行命中 %i 行时抛错 (事务内, 触发回滚) 并点名主键', async (matched) => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ columns: [], rows: [], affectedRows: 1, executionTime: 1 } as QueryResult)
        .mockResolvedValueOnce({ columns: [], rows: [], affectedRows: matched, executionTime: 1 } as QueryResult);
      mockDriver.transaction = vi.fn(async (work) => work(exec));

      await expect(service.batchUpdate(mockDriver, 'testdb', 'users', [
        { primaryKeys: { id: '1' }, changes: { name: 'A' } },
        { primaryKeys: { id: '1234567890123456789' }, changes: { name: 'B' } },
      ])).rejects.toThrow(`UPDATE matched ${matched} rows for id=1234567890123456789`);
    });

    it('空 updates 不触发 transaction', async () => {
      mockDriver.transaction = vi.fn();
      await service.batchUpdate(mockDriver, 'testdb', 'users', []);
      expect(mockDriver.transaction).not.toHaveBeenCalled();
    });

    it('driver 无 transaction 能力时退化为逐条 execute', async () => {
      vi.mocked(mockDriver.execute).mockResolvedValue({
        columns: [], rows: [], affectedRows: 1, executionTime: 1,
      } as QueryResult);
      await service.batchUpdate(mockDriver, 'testdb', 'users', [
        { primaryKeys: { id: 1 }, changes: { name: 'A' } },
      ]);
      expect(mockDriver.execute).toHaveBeenCalledWith('UPDATE `testdb`.`users` SET `name` = ? WHERE `id` = ?', ['A', 1]);
    });
  });
});
