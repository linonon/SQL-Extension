import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSqlMessage, RESULT_ROW_CAP, type SqlMessageContext } from './sql-message-handler';
import type { IDatabaseDriver } from '../types/driver';
import type { WebviewMessage } from '../types/messages';
import type { StatementOutcome } from '../types/query';
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
    // 每条语句依次消费 queue 的一项, 遇 Error 即停 (与真 executor 的遇错即停一致)
    executeBatch: vi.fn((statements: readonly string[]) => {
      const results: StatementOutcome[] = [];
      for (let k = 0; k < statements.length; k++) {
        const item = queue[i++] ?? { columns: [], rows: [], affectedRows: 0, executionTime: 0 };
        if (item instanceof Error) {
          return { promise: Promise.resolve({ results, error: { index: k, cause: item } }), cancel: vi.fn() };
        }
        results.push({ ...item, sql: statements[k] } as StatementOutcome);
      }
      return { promise: Promise.resolve({ results }), cancel: vi.fn() };
    }),
  } as unknown as IDatabaseDriver;
}

const batchCalls = (driver: IDatabaseDriver) => (driver.executeBatch as ReturnType<typeof vi.fn>).mock.calls;

function createCtx(driver: IDatabaseDriver, posts: unknown[]): SqlMessageContext {
  return {
    getDriver: () => driver,
    queryService: {} as SqlMessageContext['queryService'],
    post: (msg) => { posts.push(msg); },
    panel: {} as vscode.WebviewPanel,
    pendingCancels: new Map(),
    database: 'AGENT_NEW',
    getSchema: async () => ({}),
    readOnly: false,
    queryHistory: { list: () => [], add: vi.fn().mockResolvedValue(undefined) },
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
    // 一次执行只调一次 executor, 切分后的原文按序交给同一条连接, 库取 panel 绑定的库
    expect(batchCalls(driver)).toEqual([[[
      'SELECT * FROM `admin_url_key` WHERE id = 15 AND name = "Log List" LIMIT 50 OFFSET 0',
      "UPDATE t SET note = 'a;b', v = 'it\\'s' WHERE id = 1 -- c;d",
    ], 'AGENT_NEW', { readOnly: false }]]);
  });

  it('只读连接: 编辑器执行走只读会话, 破坏性语句不弹确认 (只读会话会拒绝它)', async () => {
    const warn = vi.mocked(vscode.window.showWarningMessage).mockClear();
    const driver = createMysqlDriver([]);
    await handleSqlMessage(
      { type: 'executeQuery', requestId: 1, database: 'db', sql: 'DELETE FROM t' } as WebviewMessage,
      { ...createCtx(driver, []), readOnly: true },
    );
    expect(warn).not.toHaveBeenCalled();
    expect(batchCalls(driver)).toEqual([[['DELETE FROM t'], 'AGENT_NEW', { readOnly: true }]]);
  });

  it('只读连接上语句含 READ WRITE (可能在解除只读) 时, 破坏性语句照样确认', async () => {
    const warn = vi.mocked(vscode.window.showWarningMessage).mockClear().mockResolvedValue(undefined as never);
    const driver = createMysqlDriver([]);
    await handleSqlMessage(
      { type: 'executeQuery', requestId: 1, database: 'db', sql: 'SET SESSION TRANSACTION READ WRITE; DELETE FROM t' } as WebviewMessage,
      { ...createCtx(driver, []), readOnly: true },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(batchCalls(driver)).toEqual([]);
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
    expect(driver.executeBatch).toHaveBeenCalledTimes(1);
  });

  it('每次执行记一条历史 (成功 / 失败), 破坏性确认取消时没执行不记; listQueryHistory 读出', async () => {
    const driver = createMysqlDriver([{ columns: [], rows: [], affectedRows: 0, executionTime: 1 }, new Error('boom')]);
    const ctx = createCtx(driver, []);
    const add = ctx.queryHistory.add as ReturnType<typeof vi.fn>;
    await handleSqlMessage({ type: 'executeQuery', requestId: 1, database: 'db', sql: 'SELECT 1' }, ctx);
    await handleSqlMessage({ type: 'executeQuery', requestId: 2, database: 'db', sql: 'SELECT x' }, ctx);
    await handleSqlMessage({ type: 'executeQuery', requestId: 3, database: 'db', sql: 'DROP TABLE t' }, ctx);
    expect(add.mock.calls.map(([e]) => [e.sql, e.database, e.ok])).toEqual([
      ['SELECT 1', 'AGENT_NEW', true],
      ['SELECT x', 'AGENT_NEW', false],
    ]);

    const posts: unknown[] = [];
    const entries = [{ sql: 'SELECT 1', database: 'AGENT_NEW', ts: 1, ok: true }];
    await handleSqlMessage({ type: 'listQueryHistory' }, { ...createCtx(driver, posts), queryHistory: { ...ctx.queryHistory, list: () => entries } });
    expect(posts).toEqual([{ type: 'queryHistory', entries }]);
  });

  it('取消后照常返回的结果集报为已取消; 照常返回的写语句照实报 ok', async () => {
    const run = async (result: { columns: unknown[]; rows: unknown[]; affectedRows: number }) => {
      const driver = createMysqlDriver([]);
      (driver.executeBatch as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve({ results: [{ ...result, executionTime: 1, sql: 'x' }], cancelled: true }), cancel: vi.fn(),
      });
      const posts: unknown[] = [];
      await handleSqlMessage({ type: 'executeQuery', requestId: 1, database: 'db', sql: 'x' } as WebviewMessage, createCtx(driver, posts));
      return (posts[0] as { statements: { status: string; error?: string }[] }).statements;
    };
    expect(await run({ columns: [{ name: 'SLEEP(10)' }], rows: [{ 'SLEEP(10)': 1 }], affectedRows: 0 }))
      .toEqual([{ index: 1, sql: 'x', status: 'error', error: 'Query cancelled' }]);
    expect((await run({ columns: [], rows: [], affectedRows: 3 }))[0].status).toBe('ok');

    // 前面语句的结果集仍带行给网格: 被取消的最后一条不占展示位
    const driver = createMysqlDriver([]);
    (driver.executeBatch as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve({
        results: [
          { columns: [{ name: 'id' }], rows: [{ id: 1 }], affectedRows: 0, executionTime: 1, sql: 'SELECT id FROM users' },
          { columns: [{ name: 'SLEEP(10)' }], rows: [{ 'SLEEP(10)': 1 }], affectedRows: 0, executionTime: 1, sql: 'SELECT SLEEP(10)' },
        ],
        cancelled: true,
      }),
      cancel: vi.fn(),
    });
    const posts: unknown[] = [];
    await handleSqlMessage({ type: 'executeQuery', requestId: 1, database: 'db', sql: 'x' } as WebviewMessage, createCtx(driver, posts));
    const [first, second] = (posts[0] as { statements: { status: string; rows?: unknown[]; error?: string }[] }).statements;
    expect(first).toMatchObject({ status: 'ok', rows: [{ id: 1 }] });
    expect(second).toMatchObject({ status: 'error', error: 'Query cancelled' });
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

  it('PG 整段不切分, 服务端返回的每个结果是一条 statement', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([]);
    (driver as { driverType: string }).driverType = 'postgresql';
    const sql = 'SELECT 1; DO $$ BEGIN PERFORM 1; END $$;';
    (driver.executeBatch as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve({ results: [
        { sql: 'SELECT 1', columns: [{ name: 'x' }], rows: [{ x: 1 }], affectedRows: 1, executionTime: 1 },
        { sql: 'DO', columns: [], rows: [], affectedRows: 0, executionTime: 1 },
      ] }),
      cancel: vi.fn(),
    });
    await handleSqlMessage({ type: 'executeQuery', requestId: 1, database: 'db', sql }, createCtx(driver, posts));
    expect(batchCalls(driver)).toEqual([[[sql], 'AGENT_NEW', { readOnly: false }]]);
    expect(posts).toEqual([expect.objectContaining({
      type: 'queryBatchResult',
      statements: [
        expect.objectContaining({ index: 1, sql: 'SELECT 1', status: 'ok', rows: [{ x: 1 }] }),
        expect.objectContaining({ index: 2, sql: 'DO', status: 'ok' }),
      ],
    })]);
  });

  it('只有网格展示的最后一个结果集带行且截到上限, 其余结果集只留行数', async () => {
    const posts: unknown[] = [];
    const cols = [{ name: 'id' }];
    const many = Array.from({ length: RESULT_ROW_CAP + 5 }, (_, i) => ({ id: i }));
    const driver = createMysqlDriver([
      { columns: cols, rows: [{ id: 1 }, { id: 2 }], affectedRows: 0, executionTime: 1 },
      { columns: cols, rows: many, affectedRows: 0, executionTime: 1 },
      { columns: [], rows: [], affectedRows: 3, executionTime: 1 },
    ]);
    await handleSqlMessage(
      { type: 'executeQuery', requestId: 1, database: 'db', sql: 'SELECT 1; SELECT 2; UPDATE t SET a = 1 WHERE id > 0' },
      createCtx(driver, posts),
    );
    const [first, shown, write] = (posts[0] as { statements: Array<Record<string, unknown>> }).statements;
    expect(first).not.toHaveProperty('rows');
    expect(first.rowCount).toBe(2);
    expect(shown).toMatchObject({ rowCount: RESULT_ROW_CAP + 5, truncated: true });
    expect((shown.rows as unknown[]).length).toBe(RESULT_ROW_CAP);
    expect(write).not.toHaveProperty('rows');
    expect(write).not.toHaveProperty('rowCount');
  });

  it('executor 的未提交事务提示带进回执', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([]);
    (driver.executeBatch as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve({ results: [], warning: 'rolled back' }),
      cancel: vi.fn(),
    });
    await handleSqlMessage({ type: 'executeQuery', requestId: 1, database: 'db', sql: 'BEGIN' }, createCtx(driver, posts));
    expect(posts).toEqual([expect.objectContaining({ type: 'queryBatchResult', warning: 'rolled back' })]);
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

  it('listColumns / requestSchema 失败不回笼统 error (会结束同时在跑的查询): 表结构回带 id 的 columnsResult, schema 走通知', async () => {
    const posts: unknown[] = [];
    const driver = createMysqlDriver([]);
    (driver.listColumns as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no such table'));
    const err = vi.spyOn(vscode.window, 'showErrorMessage').mockClear();
    const ctx = { ...createCtx(driver, posts), getSchema: async () => { throw new Error('denied'); } };

    await handleSqlMessage({ type: 'listColumns', requestId: 21, database: 'db', table: 't' }, ctx);
    await handleSqlMessage({ type: 'requestSchema', database: 'db' }, ctx);

    expect(posts).toEqual([{ type: 'columnsResult', requestId: 21, columns: [], error: 'no such table' }]);
    expect(err).toHaveBeenCalledWith('Failed to load schema for autocomplete: denied');
  });

  it('旧执行晚结束不清掉新执行的 cancel', async () => {
    const runs: Array<{ resolve: () => void; cancel: () => void }> = [];
    const driver = createMysqlDriver([]);
    (driver.executeBatch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      let resolve!: () => void;
      const promise = new Promise((r) => { resolve = () => r({ results: [] }); });
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

describe('handleSqlMessage importSql', () => {
  const pick = async (sql: string) => {
    vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([vscode.Uri.file('/tmp/d.sql')] as never);
    vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(Buffer.from(sql, 'utf-8') as never);
  };

  it('MySQL: 按 ; 切分后一次交给 executor, 失败时报出第几条', async () => {
    const dump = "DROP TABLE IF EXISTS `t`;\nCREATE TABLE `t` (id int);\nINSERT INTO `t` (`id`) VALUES (1),\n(2);\n";
    await pick(dump);
    const driver = createMysqlDriver([
      { columns: [], rows: [], affectedRows: 0, executionTime: 1 },
      new Error('boom'),
    ]);
    const err = vi.spyOn(vscode.window, 'showErrorMessage');
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Import' as never);
    const posts: unknown[] = [];
    await handleSqlMessage({ type: 'importSql', database: 'db1' } as WebviewMessage, createCtx(driver, posts));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('destructive'), { modal: true }, 'Import');
    expect(batchCalls(driver)).toEqual([[[
      'DROP TABLE IF EXISTS `t`',
      'CREATE TABLE `t` (id int)',
      'INSERT INTO `t` (`id`) VALUES (1),\n(2)',
    ], 'db1']]);
    expect(err).toHaveBeenCalledWith('Import failed at statement 2/3 (earlier statements were applied): boom');
    // 失败也刷新左侧列表: 前面的语句可能已建表
    expect(posts).toEqual([expect.objectContaining({ type: 'databaseTableList' })]);
  });

  it.each(['mysql', 'postgresql'])('%s: 含 DROP 的文件在 modal 里取消: 不执行, 不刷新', async (driverType) => {
    await pick('DROP TABLE IF EXISTS `t`;\nCREATE TABLE `t` (id int);\n');
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockClear().mockResolvedValue(undefined as never);
    const driver = createMysqlDriver([]);
    (driver as { driverType: string }).driverType = driverType;
    const posts: unknown[] = [];
    await handleSqlMessage({ type: 'importSql', database: 'db1' } as WebviewMessage, createCtx(driver, posts));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('destructive'), { modal: true }, 'Import');
    expect(driver.executeBatch).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it('导入成功后刷新列表失败: 只有导入结果一条通知, 刷新失败报在列表里', async () => {
    await pick('INSERT INTO t (id) VALUES (1);\n');
    const driver = createMysqlDriver([{ columns: [], rows: [], affectedRows: 1, executionTime: 1 }]);
    (driver.listDatabases as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'));
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockClear();
    const err = vi.spyOn(vscode.window, 'showErrorMessage').mockClear();
    const posts: unknown[] = [];
    await handleSqlMessage({ type: 'importSql', database: 'db1' } as WebviewMessage, createCtx(driver, posts));
    expect(info).toHaveBeenCalledWith('SQL imported. Affected rows: 1');
    expect(err).not.toHaveBeenCalled();
    expect(posts).toEqual([{ type: 'databaseTableList', databases: [], error: 'gone' }]);
  });

  it('PG: 整段文本交给 simple protocol, 不在客户端切分', async () => {
    // 以反斜杠结尾的 PG 字符串会让 MySQL 风格的切分器吞掉后面的语句
    const dump = "INSERT INTO \"t\" (\"p\") VALUES ('C:\\');\nINSERT INTO \"t\" (\"p\") VALUES ('x');\n";
    await pick(dump);
    const driver = createMysqlDriver([{ columns: [], rows: [], affectedRows: 2, executionTime: 1 }]);
    (driver as { driverType: string }).driverType = 'postgresql';
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await handleSqlMessage({ type: 'importSql', database: 'db1' } as WebviewMessage, createCtx(driver, []));
    expect(batchCalls(driver)).toEqual([[[dump], 'db1']]);
    expect(info).toHaveBeenCalledWith('SQL imported. Affected rows: 2');
  });
});

describe('handleSqlMessage listDatabasesAndTables', () => {
  const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

  it('最多 4 个库并发; 连不上的库 (权限 / 已删 / pg_hba) 列成空库', async () => {
    const driver = createMysqlDriver([]);
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    (driver.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue(names);
    let inFlight = 0;
    let peak = 0;
    (driver.listTables as ReturnType<typeof vi.fn>).mockImplementation(async (db: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (db === 'b') { throw pgError('42501'); }
      if (db === 'c') { throw pgError('28000'); }
      return [{ name: `${db}_t`, rowCount: 1 }];
    });
    const posts: unknown[] = [];
    await handleSqlMessage({ type: 'listDatabasesAndTables' } as WebviewMessage, createCtx(driver, posts));
    expect(peak).toBe(4);
    const [msg] = posts as { databases: { name: string; tables: unknown[] }[] }[];
    expect(msg.databases.map((d) => [d.name, d.tables.length])).toEqual([
      ['a', 1], ['b', 0], ['c', 0], ['d', 1], ['e', 1], ['f', 1], ['g', 1],
    ]);
  });

  it('其他错误不吞, 走列表的 error 回执', async () => {
    const driver = createMysqlDriver([]);
    (driver.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue(['a', 'b']);
    (driver.listTables as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection terminated'));
    const posts: unknown[] = [];
    await handleSqlMessage({ type: 'listDatabasesAndTables' } as WebviewMessage, createCtx(driver, posts));
    expect(posts).toEqual([{ type: 'databaseTableList', databases: [], error: 'Connection terminated' }]);
  });

  it('MySQL: 一次取完所有库的表 (不逐库 listTables), 没有表的库列成空库', async () => {
    const driver = createMysqlDriver([]);
    (driver.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue(['app', 'empty', 'mysql']);
    driver.listAllTables = vi.fn().mockResolvedValue([
      { name: 'orders', schema: 'app', rowCount: 3 },
      { name: 'users', schema: 'app', rowCount: 5 },
      { name: 'user', schema: 'mysql', rowCount: 1 },
    ]);
    const posts: unknown[] = [];
    await handleSqlMessage({ type: 'listDatabasesAndTables' } as WebviewMessage, createCtx(driver, posts));
    expect(driver.listTables).not.toHaveBeenCalled();
    expect(posts).toEqual([{ type: 'databaseTableList', databases: [
      { name: 'app', tables: [{ name: 'orders', rowCount: 3 }, { name: 'users', rowCount: 5 }] },
      { name: 'empty', tables: [] },
      { name: 'mysql', tables: [{ name: 'user', rowCount: 1 }] },
    ] }]);
  });
});

describe('handleSqlMessage deleteRows', () => {
  it('确认后删除; 实际删除行数少于请求时提示, 仍回成功让网格刷新', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockClear()
      .mockResolvedValueOnce('Delete' as never).mockResolvedValue(undefined as never);
    const driver = createMysqlDriver([]);
    vi.mocked(driver.execute).mockResolvedValue({ columns: [], rows: [], affectedRows: 1, executionTime: 0 });
    const posts: unknown[] = [];
    await handleSqlMessage(
      { type: 'deleteRows', database: 'db', table: 't', primaryKeys: [{ id: 1 }, { id: 2 }] } as WebviewMessage,
      createCtx(driver, posts)
    );
    expect(warn.mock.calls[0][0]).toBe('Delete 2 row(s) from db.t?');
    expect(warn.mock.calls[1][0]).toBe('Deleted 1 of 2 row(s); the others no longer exist');
    expect(posts).toEqual([{ type: 'deleteRowsResult', success: true }]);
  });
});

describe('handleSqlMessage Edit Table / CSV', () => {
  it('Preview DDL 走独立回执, 没有改动时 ddl 为空串', async () => {
    const posts: unknown[] = [];
    const changes = { addedColumns: [], droppedColumns: [], modifiedColumns: [], renamedColumns: [] };
    await handleSqlMessage(
      { type: 'previewAlterTable', database: 'db', table: 't', changes } as WebviewMessage,
      createCtx(createMysqlDriver([]), posts)
    );
    expect(posts).toEqual([{ type: 'alterTablePreview', ddl: '' }]);
  });

  it('Apply 含 Drop Column 先在宿主确认, 点名列; 取消则不执行', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const driver = createMysqlDriver([]);
    const posts: unknown[] = [];
    const changes = { addedColumns: [], droppedColumns: ['a', 'b'], modifiedColumns: [], renamedColumns: [] };
    const msg = { type: 'alterTable', database: 'db', table: 't', changes } as WebviewMessage;
    await handleSqlMessage(msg, createCtx(driver, posts));
    expect(warn).toHaveBeenCalledWith('Drop column(s) a, b from t? Their data is deleted.', { modal: true }, 'Drop');
    expect(driver.executeBatch).not.toHaveBeenCalled();
    expect(posts).toEqual([]);

    warn.mockResolvedValue('Drop' as never);
    await handleSqlMessage(msg, createCtx(driver, posts));
    expect(batchCalls(driver)).toEqual([[['ALTER TABLE `t` DROP COLUMN `a`;', 'ALTER TABLE `t` DROP COLUMN `b`;'], 'db']]);
  });

  it('Apply 不含 Drop Column (如只改列名) 不弹确认', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockClear();
    const driver = createMysqlDriver([]);
    const changes = { addedColumns: [], droppedColumns: [], modifiedColumns: [], renamedColumns: [{ from: 'a', to: 'b' }] };
    await handleSqlMessage({ type: 'alterTable', database: 'db', table: 't', changes } as WebviewMessage, createCtx(driver, []));
    expect(warn).not.toHaveBeenCalled();
    expect(driver.executeBatch).toHaveBeenCalledTimes(1);
  });

  it('CSV 默认存到 workspace 目录下', async () => {
    const save = vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, 'workspaceFolders', 'get').mockReturnValue([{ uri: { fsPath: '/ws' } }] as never);
    await handleSqlMessage(
      { type: 'exportCsv', content: 'a', defaultFileName: 'export.csv' } as WebviewMessage,
      createCtx(createMysqlDriver([]), [])
    );
    expect(save.mock.lastCall?.[0]?.defaultUri?.path).toBe('/ws/export.csv');
  });
});
