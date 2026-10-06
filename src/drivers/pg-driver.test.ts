import { describe, it, expect, vi, beforeEach } from 'vitest';
import pg from 'pg';
import { PgDriver } from './pg-driver';

// Mock pg
const mockPool = {
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
};

// 每个 new pg.Pool 记下构造参数; 方法共用 mockPool 的 vi.fn, 用 mock.contexts 区分调用落在哪个 pool
const pools = vi.hoisted(() => ({ instances: [] as { opts: { database?: string; host?: string; port?: number } }[] }));

vi.mock('pg', () => {
  return {
    default: {
      Pool: class MockPool {
        constructor(public opts: { database?: string }) { pools.instances.push(this); }
        connect = mockPool.connect;
        query = mockPool.query;
        end = mockPool.end;
        on = mockPool.on;
      },
      types: {
        builtins: { DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, JSON: 114, JSONB: 3802 },
        setTypeParser: vi.fn(),
      },
    },
  };
});

// 模块加载时注册的 type parser (beforeEach 的 clearAllMocks 会清掉调用记录, 先留存)
const typeParserCalls = [...vi.mocked(pg.types.setTypeParser).mock.calls] as unknown as [number, (v: string) => unknown][];

describe('PgDriver', () => {
  it('日期与 JSON/JSONB 注册 identity parser, 保持 PG 原生文本', () => {
    const calls = typeParserCalls;
    expect(calls.map(([oid]) => oid).sort((a, b) => a - b)).toEqual([114, 1082, 1114, 1184, 3802]);
    const json = calls.find(([oid]) => oid === 3802)![1];
    expect(json('{"uid":1234567890123456789}')).toBe('{"uid":1234567890123456789}');
  });

  let driver: PgDriver;

  beforeEach(() => {
    driver = new PgDriver();
    vi.clearAllMocks();
    pools.instances.length = 0;
  });

  const cfg = {
    id: 'test-id', name: 'test', driverType: 'postgresql' as const, host: '127.0.0.1', port: 50123,
    username: 'postgres', password: 'secret', database: 'app_prod',
  };
  const dbOf = (fn: { mock: { contexts: unknown[] } }) =>
    fn.mock.contexts.map((p) => (p as { opts: { database?: string } }).opts.database);

  describe('按库建 pool', () => {
    it('两个库两个 pool, 各方法的查询落到目标库; 缺省用配置库; disconnect 关掉全部', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      mockPool.query.mockResolvedValue({ rows: [], fields: [], rowCount: 0 });
      await driver.connect(cfg);

      await driver.listTables('app_staging');
      await driver.listColumns('app_staging', 'users');
      await driver.execute('UPDATE users SET a = 1 WHERE id = $1', [1], 'app_staging');
      await driver.execute('SELECT 1');
      await driver.listDatabases();

      // 新 pool 沿用连接参数 (SSH tunnel 时就是本地转发端口), 只换 database
      // 其他库的空闲连接很快关掉 (列出全部库时每库一条连接)
      expect(pools.instances.map((p) => p.opts)).toEqual([
        expect.objectContaining({ host: '127.0.0.1', port: 50123, database: 'app_prod', idleTimeoutMillis: 30000 }),
        expect.objectContaining({ host: '127.0.0.1', port: 50123, database: 'app_staging', idleTimeoutMillis: 1000 }),
      ]);
      expect(dbOf(mockPool.query)).toEqual(['app_staging', 'app_staging', 'app_staging', 'app_prod', 'app_prod']);

      await driver.disconnect();
      expect(mockPool.end).toHaveBeenCalledTimes(2);
      expect(driver.isConnected()).toBe(false);
    });

    it('连接验证失败: 清掉 pool, 状态为未连接', async () => {
      mockPool.connect.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(driver.connect(cfg)).rejects.toThrow('Connection refused');
      expect(driver.isConnected()).toBe(false);
      expect(mockPool.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeBatch (单连接执行器)', () => {
    it('多语句文本的结果数组逐条映射; 用目标库的 pool, 连接用完销毁', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      const client = {
        processID: 9,
        release: vi.fn(),
        query: vi.fn().mockResolvedValueOnce([
          { command: 'INSERT', rows: [], fields: [], rowCount: 2 },
          { command: 'SELECT', rows: [{ n: 1 }], fields: [{ name: 'n', tableID: 0, columnID: 0, dataTypeID: 23 }], rowCount: 1 },
        ]),
      };
      mockPool.connect.mockResolvedValue(client);

      const out = await driver.executeBatch(['INSERT INTO t VALUES (1), (2); SELECT 1 AS n'], 'app_staging').promise;

      expect(out.results.map((r) => [r.sql, r.affectedRows, r.rows])).toEqual([
        ['INSERT INTO t VALUES (1), (2)', 2, []],
        ['SELECT 1 AS n', 1, [{ n: 1 }]],
      ]);
      expect(out.error).toBeUndefined();
      expect(dbOf(mockPool.connect).at(-1)).toBe('app_staging');
      expect(client.release).toHaveBeenCalledWith(true);
    });

    it('BEGIN 未提交给出提示; 出错回带输入下标, 没有部分结果', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      const client = {
        processID: 9,
        release: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce([{ command: 'BEGIN', rows: [], fields: [], rowCount: null }, { command: 'UPDATE', rows: [], fields: [], rowCount: 1 }])
          .mockRejectedValueOnce(new Error('syntax error')),
      };
      mockPool.connect.mockResolvedValue(client);

      const ok = await driver.executeBatch(['BEGIN; UPDATE t SET a = 1']).promise;
      expect(ok.warning).toMatch(/rolled back/);

      const bad = await driver.executeBatch(['SELEC 1']).promise;
      expect(bad.results).toEqual([]);
      expect(bad.error).toEqual({ index: 0, cause: new Error('syntax error') });
      expect(client.release).toHaveBeenCalledTimes(2);
      expect(client.release).toHaveBeenLastCalledWith(true);
    });

    it('事务是否收尾看服务端命令标签, 不在客户端切分文本', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      const tag = (command: string) => ({ command, rows: [], fields: [], rowCount: 0 });
      const client = {
        processID: 9,
        release: vi.fn(),
        query: vi.fn()
          // PG 里 'C:\' 是完整字符串, MySQL 规则的切分会把后面的 COMMIT 吞进字符串
          .mockResolvedValueOnce([tag('BEGIN'), tag('INSERT'), tag('COMMIT')])
          // ABORT 的标签是 ROLLBACK
          .mockResolvedValueOnce([tag('START'), tag('ROLLBACK')])
          .mockResolvedValueOnce([tag('START'), tag('DELETE')]),
      };
      mockPool.connect.mockResolvedValue(client);

      expect((await driver.executeBatch(["BEGIN; INSERT INTO t VALUES ('C:\\'); COMMIT;"]).promise).warning).toBeUndefined();
      expect((await driver.executeBatch(['START TRANSACTION; ABORT']).promise).warning).toBeUndefined();
      expect((await driver.executeBatch(['START TRANSACTION; DELETE FROM t WHERE id = 1']).promise).warning).toMatch(/rolled back/);
    });

    it('executeCancellable 不接受 params', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      expect(() => driver.executeCancellable('SELECT $1', [1])).toThrow(/use execute/);
    });

    it('cancel 只取消本连接的 pid; 执行结束后 cancel 是 no-op', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      let finish!: () => void;
      const client = {
        processID: 4321,
        release: vi.fn(),
        query: vi.fn(() => new Promise((r) => { finish = () => r({ command: 'SELECT', rows: [], fields: [], rowCount: 0 }); })),
      };
      mockPool.connect.mockResolvedValue(client);
      mockPool.query.mockResolvedValue({ rows: [], fields: [], rowCount: 0 });

      const run = driver.executeBatch(['SELECT pg_sleep(10)']);
      await vi.waitFor(() => expect(client.query).toHaveBeenCalled());
      run.cancel();
      expect(mockPool.query).toHaveBeenCalledWith('SELECT pg_cancel_backend(4321)');
      finish();
      await run.promise;

      mockPool.query.mockClear();
      run.cancel();
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe('executeReadOnly', () => {
    it('目标库的只读事务里设 statement_timeout, 连接用完销毁', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      const client = { release: vi.fn(), query: vi.fn().mockResolvedValue({ rows: [{ n: 1 }], fields: [], rowCount: 1 }) };
      mockPool.connect.mockResolvedValue(client);

      const result = await driver.executeReadOnly('SELECT 1', 'app_staging');

      expect(client.query.mock.calls.map((c) => c[0])).toEqual([
        'BEGIN READ ONLY',
        'SET LOCAL statement_timeout = 30000',
        { text: 'SELECT 1', queryMode: 'extended' },
      ]);
      expect(result.rows).toEqual([{ n: 1 }]);
      expect(dbOf(mockPool.connect).at(-1)).toBe('app_staging');
      expect(client.release).toHaveBeenCalledWith(true);
    });
  });

  describe('getTableDDL', () => {
    it('序列默认值引用的序列先 CREATE SEQUENCE IF NOT EXISTS', async () => {
      mockPool.connect.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      mockPool.query
        .mockResolvedValueOnce({ rows: [
          { column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: "nextval('\"T_id_seq\"'::regclass)" },
          { column_name: 'name', data_type: 'text', udt_name: 'text', is_nullable: 'YES', column_default: null },
        ] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      expect(await driver.getTableDDL('app_prod', 'T')).toBe(
        'CREATE SEQUENCE IF NOT EXISTS "T_id_seq";\n'
        + 'CREATE TABLE "T" (\n  "id" int4 NOT NULL DEFAULT nextval(\'"T_id_seq"\'::regclass),\n  "name" text\n);',
      );
    });
  });

  describe('connect', () => {
    it('应该创建连接池并验证连接', async () => {
      const mockClient = {
        release: vi.fn(),
      };
      mockPool.connect.mockResolvedValue(mockClient);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      expect(driver.isConnected()).toBe(true);
      expect(mockPool.connect).toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('连接失败时应该抛出错误', async () => {
      const failDriver = new PgDriver();
      mockPool.connect.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        failDriver.connect({
          id: 'test-id',
          name: 'test',
          driverType: 'postgresql',
          host: 'invalid-host',
          port: 5432,
          username: 'postgres',
          password: 'wrong',
          database: 'testdb',
        })
      ).rejects.toThrow('Connection refused');
    });
  });

  describe('disconnect', () => {
    it('应该关闭连接池', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.end.mockResolvedValue(undefined);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      await driver.disconnect();

      expect(mockPool.end).toHaveBeenCalled();
      expect(driver.isConnected()).toBe(false);
    });

    it('未连接时 disconnect 应该安全执行', async () => {
      await driver.disconnect();
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('listDatabases', () => {
    it('应该返回数据库列表', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.query.mockResolvedValue({
        rows: [{ datname: 'db1' }, { datname: 'db2' }, { datname: 'postgres' }],
        fields: [],
        rowCount: 3,
      });

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const databases = await driver.listDatabases();

      expect(databases).toEqual(['db1', 'db2', 'postgres']);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_database'),
        undefined
      );
    });

    it('未连接时应该抛出错误', async () => {
      await expect(driver.listDatabases()).rejects.toThrow(
        'PostgreSQL driver is not connected'
      );
    });
  });

  describe('listTables', () => {
    it('应该返回表列表', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.query.mockResolvedValue({
        rows: [
          { name: 'users', schema: 'public', row_count: 100 },
          { name: 'orders', schema: 'public', row_count: 500 },
        ],
        fields: [],
        rowCount: 2,
      });

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const tables = await driver.listTables('testdb');

      expect(tables).toEqual([
        { name: 'users', schema: 'public', rowCount: 100 },
        { name: 'orders', schema: 'public', rowCount: 500 },
      ]);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
        undefined
      );
    });

    it('应该处理 row_count 为 null 的情况', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.query.mockResolvedValue({
        rows: [{ name: 'empty_table', schema: 'public', row_count: null }],
        fields: [],
        rowCount: 1,
      });

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const tables = await driver.listTables('testdb');

      expect(tables[0].rowCount).toBe(0);
    });
  });

  describe('listColumns', () => {
    it('应该返回列信息', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.query.mockResolvedValue({
        rows: [
          {
            name: 'id',
            data_type: 'integer',
            nullable: 'NO',
            is_pk: true,
            default_value: "nextval('users_id_seq'::regclass)",
          },
          {
            name: 'name',
            data_type: 'character varying',
            nullable: 'YES',
            is_pk: false,
            default_value: null,
          },
        ],
        fields: [],
        rowCount: 2,
      });

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const columns = await driver.listColumns('testdb', 'users');

      expect(columns).toEqual([
        {
          name: 'id',
          dataType: 'integer',
          nullable: false,
          isPrimaryKey: true,
          defaultValue: "nextval('users_id_seq'::regclass)",
          extra: '',
        },
        {
          name: 'name',
          dataType: 'character varying',
          nullable: true,
          isPrimaryKey: false,
          defaultValue: null,
          extra: '',
        },
      ]);
      expect(mockPool.query).toHaveBeenCalledWith(expect.any(String), ['users']);
    });

    it('应该正确处理复合主键', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.query.mockResolvedValue({
        rows: [
          {
            name: 'user_id',
            data_type: 'integer',
            nullable: 'NO',
            is_pk: true,
            default_value: null,
          },
          {
            name: 'tenant_id',
            data_type: 'integer',
            nullable: 'NO',
            is_pk: true,
            default_value: null,
          },
        ],
        fields: [],
        rowCount: 2,
      });

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const columns = await driver.listColumns('testdb', 'user_tenants');

      expect(columns[0].isPrimaryKey).toBe(true);
      expect(columns[1].isPrimaryKey).toBe(true);
    });
  });

  describe('execute', () => {
    it('SELECT 查询应该返回行数据', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);

      const mockResult = {
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        fields: [
          { name: 'id', dataTypeID: 23 },
          { name: 'name', dataTypeID: 1043 },
          { name: 'born', dataTypeID: 1082 },
        ],
        rowCount: 2,
      };

      mockPool.query.mockResolvedValue(mockResult);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const result = await driver.execute('SELECT * FROM users', []);

      expect(result.rows).toEqual(mockResult.rows);
      expect(result.columns).toHaveLength(3);
      expect(result.columns[0].name).toBe('id');
      // 内置类型按 OID 反查类型名 (mock 的 builtins 只含 DATE 等), 查不到的保留 OID
      expect(result.columns[2].dataType).toBe('date');
      expect(result.columns[0].dataType).toBe('23');
      expect(result.affectedRows).toBe(2);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('INSERT/UPDATE/DELETE 应该返回 affectedRows', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);

      const mockResult = {
        rows: [],
        fields: [],
        rowCount: 1,
      };

      mockPool.query.mockResolvedValue(mockResult);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const result = await driver.execute(
        'INSERT INTO users (name) VALUES ($1)',
        ['Charlie']
      );

      expect(result.rows).toEqual([]);
      expect(result.affectedRows).toBe(1);
    });

    it('未连接时应该抛出错误', async () => {
      await expect(driver.execute('SELECT 1')).rejects.toThrow(
        'PostgreSQL driver is not connected'
      );
    });

    it('应该传递参数到 pool.query', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.query.mockResolvedValue({
        rows: [],
        fields: [],
        rowCount: 0,
      });

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      await driver.execute('SELECT * FROM users WHERE id = $1', [42]);

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = $1',
        [42]
      );
    });

    it('应该处理 null 的 fields 和 rows', async () => {
      const mockClient = { release: vi.fn() };
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.query.mockResolvedValue({
        rows: null,
        fields: null,
        rowCount: null,
      });

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'testdb',
      });

      const result = await driver.execute('SELECT 1');

      expect(result.rows).toEqual([]);
      expect(result.columns).toEqual([]);
      expect(result.affectedRows).toBe(0);
    });
  });

  describe('executeCancellable 结果列来源 (source)', () => {
    it('按 tableID/columnID 查 catalog, 只给未改名的原始列挂 schema.table', async () => {
      const client = {
        release: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce({
            rows: [{ id: 1, nick: 'a', n: 2 }],
            rowCount: 1,
            fields: [
              { name: 'id', tableID: 16384, columnID: 1, dataTypeID: 23 },
              { name: 'nick', tableID: 16384, columnID: 2, dataTypeID: 25 },
              { name: 'n', tableID: 0, columnID: 0, dataTypeID: 23 },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { oid: 16384, attnum: 1, attname: 'id', relname: 'users', nspname: 'public' },
              { oid: 16384, attnum: 2, attname: 'name', relname: 'users', nspname: 'public' },
            ],
          }),
      };
      mockPool.connect.mockResolvedValue(client);
      await driver.connect({
        id: 'test-id', name: 'test', driverType: 'postgresql', host: 'localhost', port: 5432,
        username: 'postgres', password: 'secret', database: 'testdb',
      });

      const result = await driver.executeCancellable('SELECT id, name AS nick, 2 AS n FROM users').promise;

      expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining('pg_attribute'), [[16384]]);
      expect(result.columns.map((c) => c.source)).toEqual([{ schema: 'public', table: 'users' }, undefined, undefined]);
      expect(client.release).toHaveBeenCalled();
    });

    it('catalog 查询失败时不挂 source, 查询结果照常返回', async () => {
      const client = {
        release: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1, fields: [{ name: 'id', tableID: 16384, columnID: 1, dataTypeID: 23 }] })
          .mockRejectedValueOnce(new Error('permission denied')),
      };
      mockPool.connect.mockResolvedValue(client);
      await driver.connect({
        id: 'test-id', name: 'test', driverType: 'postgresql', host: 'localhost', port: 5432,
        username: 'postgres', password: 'secret', database: 'testdb',
      });

      const result = await driver.executeCancellable('SELECT id FROM users').promise;

      expect(result.rows).toEqual([{ id: 1 }]);
      expect(result.columns[0].source).toBeUndefined();
    });
  });

  describe('driverType', () => {
    it('应该返回 postgresql', () => {
      expect(driver.driverType).toBe('postgresql');
    });
  });
});
