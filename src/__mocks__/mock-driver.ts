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
    getTableDDL: vi.fn<IDatabaseDriver['getTableDDL']>().mockResolvedValue(''),
    getDetailedColumns: vi.fn<IDatabaseDriver['getDetailedColumns']>().mockResolvedValue([]),
    execute: vi.fn<IDatabaseDriver['execute']>().mockImplementation(async () => emptyResult()),
    executeCancellable: vi.fn<IDatabaseDriver['executeCancellable']>().mockImplementation(() => ({
      promise: Promise.resolve(emptyResult()),
      cancel: vi.fn(),
    })),
    ...overrides,
  };
}
