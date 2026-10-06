// IDatabaseDriver 的测试替身: 每个方法都是按接口签名定型的 vi.fn, 默认返回空结果; overrides 覆盖任意成员.
import { vi, type Mocked } from 'vitest';
import type { IDatabaseDriver } from '../types/driver.js';
import type { QueryResult } from '../types/query.js';

const emptyResult = (): QueryResult => ({ columns: [], rows: [], affectedRows: 0, executionTime: 0 });

export function createMockDriver(overrides: Partial<Mocked<IDatabaseDriver>> = {}): Mocked<IDatabaseDriver> {
  return {
    driverType: 'mysql',
    connect: vi.fn<IDatabaseDriver['connect']>().mockResolvedValue(undefined),
    disconnect: vi.fn<IDatabaseDriver['disconnect']>().mockResolvedValue(undefined),
    isConnected: vi.fn<IDatabaseDriver['isConnected']>().mockReturnValue(true),
    ping: vi.fn<IDatabaseDriver['ping']>().mockResolvedValue(undefined),
    listDatabases: vi.fn<IDatabaseDriver['listDatabases']>().mockResolvedValue([]),
    listTables: vi.fn<IDatabaseDriver['listTables']>().mockResolvedValue([]),
    listColumns: vi.fn<IDatabaseDriver['listColumns']>().mockResolvedValue([]),
    listSchemaColumns: vi.fn<IDatabaseDriver['listSchemaColumns']>().mockResolvedValue([]),
    getTableDDL: vi.fn<IDatabaseDriver['getTableDDL']>().mockResolvedValue(''),
    getDetailedColumns: vi.fn<IDatabaseDriver['getDetailedColumns']>().mockResolvedValue([]),
    execute: vi.fn<IDatabaseDriver['execute']>().mockImplementation(async () => emptyResult()),
    // 泛型方法: vi.fn 的调用签名会把 T 实例化成 unknown, 需断言回接口签名
    transaction: vi.fn<IDatabaseDriver['transaction']>()
      .mockImplementation(async (work) => work(async () => emptyResult())) as Mocked<IDatabaseDriver>['transaction'],
    executeReadOnly: vi.fn<IDatabaseDriver['executeReadOnly']>().mockImplementation(async () => emptyResult()),
    executeBatch: vi.fn<IDatabaseDriver['executeBatch']>().mockImplementation(() => ({
      promise: Promise.resolve({ results: [] }),
      cancel: vi.fn(),
    })),
    ...overrides,
  };
}
