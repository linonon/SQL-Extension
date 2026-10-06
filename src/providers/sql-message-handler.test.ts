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

  it('执行原文: 字符串字面量 / 注释不被掏空', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([]);
    const sql = `SELECT * FROM \`admin_url_key\` WHERE id = 15 AND name = "Log List" LIMIT 50 OFFSET 0; UPDATE t SET note = 'a;b', v = 'it\\'s' WHERE id = 1 -- c;d`;
    await handleSqlMessage({ type: 'executeQuery', database: 'db', sql } as WebviewMessage, createCtx(driver, posts));
    const sent = (driver.executeCancellable as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(sent).toEqual([
      'SELECT * FROM `admin_url_key` WHERE id = 15 AND name = "Log List" LIMIT 50 OFFSET 0',
      "UPDATE t SET note = 'a;b', v = 'it\\'s' WHERE id = 1 -- c;d",
    ]);
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

describe('handleSqlMessage 回执身份与 cancel 槽位', () => {
  beforeEach(() => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
  });

  it('executeQuery / listColumns 回执带回 requestId, 驱动不可用时也回带 id 的 queryResult', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([]);
    const ctx = createCtx(driver, posts);
    await handleSqlMessage({ type: 'executeQuery', requestId: 11, database: 'db', sql: 'SELECT 1' }, ctx);
    await handleSqlMessage({ type: 'listColumns', requestId: 12, database: 'db', table: 't' }, ctx);
    await handleSqlMessage(
      { type: 'executeQuery', requestId: 13, database: 'db', sql: 'SELECT 1' },
      { ...ctx, getDriver: () => { throw new Error('not connected'); } },
    );
    expect(posts).toEqual([
      expect.objectContaining({ type: 'queryBatchResult', requestId: 11 }),
      expect.objectContaining({ type: 'columnsResult', requestId: 12 }),
      expect.objectContaining({ type: 'queryResult', requestId: 13, error: expect.any(String) }),
    ]);
  });

  it('旧执行晚结束不清掉新执行的 cancel', async () => {
    const runs: Array<{ resolve: () => void; cancel: () => void }> = [];
    const driver = createMysqlDriver([]);
    (driver.executeCancellable as ReturnType<typeof vi.fn>).mockImplementation(() => {
      let resolve!: () => void;
      const promise = new Promise((r) => { resolve = () => r({ columns: [], rows: [], affectedRows: 0, executionTime: 0 }); });
      const run = { resolve, cancel: vi.fn() };
      runs.push(run);
      return { promise, cancel: run.cancel };
    });
    const ctx = createCtx(driver, []);
    const first = handleSqlMessage({ type: 'executeQuery', requestId: 1, database: 'db', sql: 'SELECT 1' }, ctx);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const second = handleSqlMessage({ type: 'executeQuery', requestId: 2, database: 'db', sql: 'SELECT 2' }, ctx);
    await vi.waitFor(() => expect(runs).toHaveLength(2));

    runs[0].resolve();
    await first;
    expect(ctx.pendingCancels.get(ctx.panel)).toBe(runs[1].cancel);

    runs[1].resolve();
    await second;
    expect(ctx.pendingCancels.has(ctx.panel)).toBe(false);
  });
});

describe('handleSqlMessage dumpTable', () => {
  it('取消 Dump Struct and Data: 不写文件, 提示 Dump cancelled', async () => {
    const driver = createMysqlDriver([]);
    (driver.getTableDDL as ReturnType<typeof vi.fn>).mockResolvedValue('CREATE TABLE t (id int)');
    (driver.listColumns as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'id' }]);
    const token = { isCancellationRequested: false };
    (driver.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ columns: [], rows: [{ cnt: '5000' }], affectedRows: 0, executionTime: 0 })
      .mockImplementation(async () => {
        token.isCancellationRequested = true;
        return { columns: [], rows: [{ id: 1 }], affectedRows: 0, executionTime: 0 };
      });
    vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(vscode.Uri.file('/tmp/t.sql') as never);
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(
      (async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) => task({ report: vi.fn() }, token)) as never
    );
    const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const posts: unknown[] = [];

    await handleSqlMessage(
      { type: 'dumpTable', database: 'db', table: 't', includeData: true } as WebviewMessage,
      createCtx(driver, posts)
    );

    expect(writeFile).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Dump cancelled');
    expect(posts).toEqual([]);
  });
});
