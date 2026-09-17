import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSqlMessage, type SqlMessageContext } from './sql-message-handler';
import type { IDatabaseDriver } from '../types/driver';
import type { WebviewMessage } from '../types/messages';
import * as vscode from 'vscode';

function createMysqlDriver(queue: Array<
  | { columns: unknown[]; rows: unknown[]; affectedRows: number; executionTime: number }
  | Error
>): IDatabaseDriver {
  let i = 0;
  return {
    driverType: 'mysql',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    ping: vi.fn().mockResolvedValue(undefined),
    listDatabases: vi.fn().mockResolvedValue([]),
    listTables: vi.fn().mockResolvedValue([]),
    listColumns: vi.fn().mockResolvedValue([]),
    getTableDDL: vi.fn().mockResolvedValue(''),
    getDetailedColumns: vi.fn().mockResolvedValue([]),
    execute: vi.fn(),
    executeCancellable: vi.fn((sql: string) => {
      const item = queue[i++];
      if (item instanceof Error) {
        return { promise: Promise.reject(item), cancel: vi.fn() };
      }
      return {
        promise: Promise.resolve(item ?? { columns: [], rows: [], affectedRows: 0, executionTime: 0 }),
        cancel: vi.fn(),
      };
    }),
  } as unknown as IDatabaseDriver;
}

function createCtx(driver: IDatabaseDriver, posts: unknown[]): SqlMessageContext {
  return {
    getDriver: () => driver,
    queryService: {} as SqlMessageContext['queryService'],
    post: (msg) => { posts.push(msg); },
    panel: {} as vscode.WebviewPanel,
    pendingCancels: new Map(),
    database: 'AGENT_NEW',
    getSchema: async () => ({}),
  };
}

describe('handleSqlMessage executeQuery mysql batch', () => {
  beforeEach(() => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
  });

  it('两条都成功时回 queryBatchResult', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([
      { columns: [], rows: [], affectedRows: 0, executionTime: 1 },
      { columns: [], rows: [], affectedRows: 0, executionTime: 2 },
    ]);
    const handled = await handleSqlMessage(
      { type: 'executeQuery', database: 'AGENT_NEW', sql: 'ALTER TABLE a ADD c INT; ALTER TABLE b ADD c INT;' } as WebviewMessage,
      createCtx(driver, posts),
    );
    expect(handled).toBe(true);
    const batch = posts.find((p) => (p as { type: string }).type === 'queryBatchResult') as {
      statements: Array<{ status: string }>;
    };
    expect(batch.statements).toHaveLength(2);
    expect(batch.statements.every((s) => s.status === 'ok')).toBe(true);
    expect(driver.executeCancellable).toHaveBeenCalledTimes(2);
  });

  it('第二条失败则后续 skipped', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([
      { columns: [], rows: [], affectedRows: 0, executionTime: 1 },
      new Error('boom'),
    ]);
    await handleSqlMessage(
      { type: 'executeQuery', database: 'AGENT_NEW', sql: 'SELECT 1; SELECT 2; SELECT 3;' } as WebviewMessage,
      createCtx(driver, posts),
    );
    const batch = posts.find((p) => (p as { type: string }).type === 'queryBatchResult') as {
      statements: Array<{ status: string }>;
    };
    expect(batch.statements.map((s) => s.status)).toEqual(['ok', 'error', 'skipped']);
  });

  it('非 mysql 仍回 queryResult', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([
      { columns: [], rows: [{ x: 1 }], affectedRows: 0, executionTime: 1 },
    ]);
    (driver as { driverType: string }).driverType = 'postgresql';
    await handleSqlMessage(
      { type: 'executeQuery', database: 'db', sql: 'SELECT 1; SELECT 2;' } as WebviewMessage,
      createCtx(driver, posts),
    );
    expect(posts.some((p) => (p as { type: string }).type === 'queryResult')).toBe(true);
    expect(posts.some((p) => (p as { type: string }).type === 'queryBatchResult')).toBe(false);
    expect(driver.executeCancellable).toHaveBeenCalledTimes(1);
  });
});
