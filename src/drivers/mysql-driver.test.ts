import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MySQLDriver } from './mysql-driver';
import type mysql from 'mysql2/promise';

// Mock mysql2/promise
vi.mock('mysql2/promise', () => {
  const mockPool = {
    getConnection: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };

  return {
    default: {
      createPool: vi.fn(() => mockPool),
    },
    __mockPool: mockPool,
  };
});

describe('MySQLDriver', () => {
  let driver: MySQLDriver;
  let mockPool: any;

  beforeEach(async () => {
    driver = new MySQLDriver();
    // 重置 mock
    const mysql = await import('mysql2/promise');
    mockPool = (mysql as any).__mockPool;
    vi.clearAllMocks();
  });

  describe('connect', () => {
    it('应该创建连接池并验证连接', async () => {
      const mockConn = {
        release: vi.fn(),
      };
      mockPool.getConnection.mockResolvedValue(mockConn);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      expect(driver.isConnected()).toBe(true);
      expect(mockPool.getConnection).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
      // BIGINT 精确字符串, JSON 列原文
      const mysql = await import('mysql2/promise');
      expect(mysql.default.createPool).toHaveBeenCalledWith(expect.objectContaining({
        supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true,
      }));
    });

    it('连接失败时应该抛出错误', async () => {
      // 创建新的 driver 实例确保未连接状态
      const failDriver = new MySQLDriver();
      mockPool.getConnection.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        failDriver.connect({
          id: 'test-id',
          name: 'test',
          driverType: 'mysql',
          host: 'invalid-host',
          port: 3306,
          username: 'root',
          password: 'wrong',
          database: 'testdb',
        })
      ).rejects.toThrow('Connection refused');
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('应该关闭连接池', async () => {
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);
      mockPool.end.mockResolvedValue(undefined);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
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
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);
      mockPool.query.mockResolvedValue([
        [{ Database: 'db1' }, { Database: 'db2' }, { Database: 'db3' }],
        [],
      ]);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      const databases = await driver.listDatabases();

      expect(databases).toEqual(['db1', 'db2', 'db3']);
      expect(mockPool.query).toHaveBeenCalledWith('SHOW DATABASES', undefined);
    });

    it('未连接时应该抛出错误', async () => {
      await expect(driver.listDatabases()).rejects.toThrow(
        'MySQL driver is not connected'
      );
    });
  });

  describe('listTables', () => {
    it('应该返回表列表', async () => {
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);
      mockPool.query.mockResolvedValue([
        [
          // bigNumberStrings 下 TABLE_ROWS (BIGINT UNSIGNED) 以字符串返回
          { name: 'users', schema: 'testdb', rowCount: '100' },
          { name: 'orders', schema: 'testdb', rowCount: '500' },
        ],
        [],
      ]);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      const tables = await driver.listTables('testdb');

      expect(tables).toEqual([
        { name: 'users', schema: 'testdb', rowCount: 100 },
        { name: 'orders', schema: 'testdb', rowCount: 500 },
      ]);
      expect(mockPool.query).toHaveBeenCalledWith(expect.any(String), ['testdb']);
    });

    it('应该处理 rowCount 为 null 的情况', async () => {
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);
      mockPool.query.mockResolvedValue([
        [{ name: 'empty_table', schema: 'testdb', rowCount: null }],
        [],
      ]);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      const tables = await driver.listTables('testdb');

      expect(tables[0].rowCount).toBe(0);
    });
  });

  describe('listColumns', () => {
    it('应该返回列信息', async () => {
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);
      mockPool.query.mockResolvedValue([
        [
          {
            name: 'id',
            dataType: 'int',
            nullable: 'NO',
            columnKey: 'PRI',
            defaultValue: null,
            extra: 'auto_increment',
          },
          {
            name: 'name',
            dataType: 'varchar',
            nullable: 'YES',
            columnKey: '',
            defaultValue: 'default_name',
            extra: '',
          },
        ],
        [],
      ]);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      const columns = await driver.listColumns('testdb', 'users');

      expect(columns).toEqual([
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
          defaultValue: 'default_name',
          extra: '',
        },
      ]);
      expect(mockPool.query).toHaveBeenCalledWith(expect.any(String), [
        'testdb',
        'users',
      ]);
    });
  });

  describe('execute', () => {
    it('SELECT 查询应该返回行数据', async () => {
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);

      const mockRows = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
      const mockFields = [
        { name: 'id', type: 3 },
        { name: 'name', type: 253 },
      ] as mysql.FieldPacket[];

      mockPool.query.mockResolvedValue([mockRows, mockFields]);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      const result = await driver.execute('SELECT * FROM users', []);

      expect(result.rows).toEqual(mockRows);
      expect(result.columns).toHaveLength(2);
      expect(result.columns[0].name).toBe('id');
      expect(result.affectedRows).toBe(0);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('INSERT/UPDATE/DELETE 应该返回 affectedRows', async () => {
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);

      const mockResultHeader = {
        affectedRows: 1,
        insertId: 123,
        fieldCount: 0,
      } as mysql.ResultSetHeader;

      mockPool.query.mockResolvedValue([mockResultHeader, []]);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      const result = await driver.execute('INSERT INTO users (name) VALUES (?)', [
        'Charlie',
      ]);

      expect(result.rows).toEqual([]);
      expect(result.columns).toEqual([]);
      expect(result.affectedRows).toBe(1);
    });

    it('未连接时应该抛出错误', async () => {
      await expect(driver.execute('SELECT 1')).rejects.toThrow(
        'MySQL driver is not connected'
      );
    });

    it('应该传递参数到 pool.execute', async () => {
      const mockConn = { release: vi.fn() };
      mockPool.getConnection.mockResolvedValue(mockConn);
      mockPool.query.mockResolvedValue([[], []]);

      await driver.connect({
        id: 'test-id',
        name: 'test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'secret',
        database: 'testdb',
      });

      await driver.execute('SELECT * FROM users WHERE id = ?', [42]);

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = ?',
        [42]
      );
    });
  });

  describe('结果列来源 (source)', () => {
    it('只给未改名的真实表列挂 schema.table; 表达式列和别名列不挂', async () => {
      mockPool.getConnection.mockResolvedValue({ release: vi.fn() });
      mockPool.query.mockResolvedValue([
        [{ id: 1, nick: 'a', cnt: 2 }],
        [
          { name: 'id', orgName: 'id', table: 'u', orgTable: 'users', db: 'app', type: 3 },
          { name: 'nick', orgName: 'name', table: 'u', orgTable: 'users', db: 'app', type: 253 },
          { name: 'cnt', orgName: '', table: '', orgTable: '', db: '', type: 8 },
        ],
      ]);
      await driver.connect({
        id: 'test-id', name: 'test', driverType: 'mysql', host: 'localhost', port: 3306,
        username: 'root', password: 'secret', database: 'testdb',
      });

      const result = await driver.execute('SELECT u.id, u.name AS nick, COUNT(*) AS cnt FROM users u');

      expect(result.columns.map((c) => c.source)).toEqual([{ schema: 'app', table: 'users' }, undefined, undefined]);
    });

    it('CALL 多结果集取第一个; 列类型显示类型名而非数字码', async () => {
      mockPool.getConnection.mockResolvedValue({ release: vi.fn() });
      mockPool.query.mockResolvedValue([
        [[{ id: 1, name: 'a' }], [{ total: 9 }], { affectedRows: 0 }],
        [
          [{ name: 'id', orgName: 'id', table: 'u', orgTable: 'users', db: 'app', type: 3 },
            { name: 'name', orgName: 'name', table: 'u', orgTable: 'users', db: 'app', type: 253 }],
          [{ name: 'total', orgName: '', table: '', orgTable: '', db: '', type: 8 }],
          undefined,
        ],
      ]);
      await driver.connect({
        id: 'test-id', name: 'test', driverType: 'mysql', host: 'localhost', port: 3306,
        username: 'root', password: 'secret', database: 'testdb',
      });

      const result = await driver.execute('CALL list_users()');

      expect(result.rows).toEqual([{ id: 1, name: 'a' }]);
      expect(result.columns.map((c) => c.dataType)).toEqual(['LONG', 'VAR_STRING']);
    });

    it('自连接 (同表多个别名): 该表的列都不挂 source', async () => {
      mockPool.getConnection.mockResolvedValue({ release: vi.fn() });
      mockPool.query.mockResolvedValue([
        [{ id: 1, name: 'p' }],
        [
          { name: 'id', orgName: 'id', table: 'a', orgTable: 't', db: 'app', type: 3 },
          { name: 'name', orgName: 'name', table: 'b', orgTable: 't', db: 'app', type: 253 },
        ],
      ]);
      await driver.connect({
        id: 'test-id', name: 'test', driverType: 'mysql', host: 'localhost', port: 3306,
        username: 'root', password: 'secret', database: 'testdb',
      });

      const result = await driver.execute('SELECT a.id, b.name FROM t a JOIN t b ON a.parent_id = b.id');

      expect(result.columns.map((c) => c.source)).toEqual([undefined, undefined]);
    });
  });

  describe('executeBatch (单连接执行器)', () => {
    const cfg = {
      id: 'test-id', name: 'test', driverType: 'mysql' as const, host: 'localhost', port: 3306,
      username: 'root', password: 'secret', database: 'testdb',
    };
    const header = (affectedRows: number) => [{ affectedRows }, undefined];

    it('一条专用连接: USE 一次, 按序执行, 遇错即停, 结束后销毁不归还', async () => {
      const conn = {
        threadId: 42, release: vi.fn(), destroy: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce(header(0)) // USE
          .mockResolvedValueOnce(header(0)) // USE other (批内切库对后续语句生效)
          .mockResolvedValueOnce(header(3))
          .mockRejectedValueOnce(new Error('boom')),
      };
      mockPool.getConnection.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      mockPool.getConnection.mockResolvedValue(conn);

      const out = await driver.executeBatch(['USE other', 'UPDATE t SET a=1', 'BAD', 'SELECT 1'], 'app').promise;

      expect(mockPool.getConnection).toHaveBeenCalledTimes(2);
      expect(conn.query.mock.calls.map((c) => c[0])).toEqual(['USE `app`', 'USE other', 'UPDATE t SET a=1', 'BAD']);
      expect(out.results.map((r) => [r.sql, r.affectedRows])).toEqual([['USE other', 0], ['UPDATE t SET a=1', 3]]);
      expect(out.error).toEqual({ index: 2, cause: new Error('boom') });
      expect(conn.destroy).toHaveBeenCalledTimes(1);
      expect(conn.release).not.toHaveBeenCalled();
    });

    it('BEGIN 之后没有 COMMIT: 回带事务已回滚的提示', async () => {
      const conn = { threadId: 1, destroy: vi.fn(), query: vi.fn().mockResolvedValue(header(1)) };
      mockPool.getConnection.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      mockPool.getConnection.mockResolvedValue(conn);

      expect((await driver.executeBatch(['BEGIN', 'UPDATE t SET a=1']).promise).warning).toMatch(/rolled back/);
      expect((await driver.executeBatch(['START TRANSACTION', 'UPDATE t SET a=1', 'COMMIT']).promise).warning).toBeUndefined();
    });

    it('cancel 只 KILL 本连接的 threadId; 执行结束后 cancel 是 no-op', async () => {
      let finish!: () => void;
      const conn = {
        threadId: 77, destroy: vi.fn(),
        query: vi.fn(() => new Promise((r) => { finish = () => r(header(0)); })),
      };
      mockPool.getConnection.mockResolvedValue({ release: vi.fn() });
      await driver.connect(cfg);
      mockPool.getConnection.mockResolvedValue(conn);
      mockPool.query.mockResolvedValue([[], []]);

      const run = driver.executeBatch(['SELECT SLEEP(10)', 'SELECT 2']);
      await vi.waitFor(() => expect(conn.query).toHaveBeenCalledTimes(1));
      run.cancel();
      expect(mockPool.query).toHaveBeenCalledWith('KILL QUERY 77');
      finish();
      const out = await run.promise;
      // 被取消后不再执行下一条
      expect(conn.query).toHaveBeenCalledTimes(1);
      expect(out.error?.index).toBe(1);

      mockPool.query.mockClear();
      run.cancel();
      const done = driver.executeBatch(['SELECT 1']);
      await vi.waitFor(() => expect(conn.query).toHaveBeenCalledTimes(2));
      finish();
      await done.promise;
      done.cancel();
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe('executeReadOnly', () => {
    it('专用连接上先设服务端超时再开只读事务; 不支持该变量的服务器照常执行', async () => {
      const conn = {
        destroy: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce([{ affectedRows: 0 }, undefined]) // USE
          .mockRejectedValueOnce(new Error("Unknown system variable 'max_execution_time'"))
          .mockResolvedValue([[{ n: 1 }], []]),
      };
      mockPool.getConnection.mockResolvedValue({ release: vi.fn() });
      await driver.connect({
        id: 'test-id', name: 'test', driverType: 'mysql', host: 'localhost', port: 3306,
        username: 'root', password: 'secret', database: 'testdb',
      });
      mockPool.getConnection.mockResolvedValue(conn);

      const result = await driver.executeReadOnly('SELECT 1', 'app');

      expect(conn.query.mock.calls.map((c) => c[0])).toEqual([
        'USE `app`', 'SET SESSION max_execution_time = 30000', 'START TRANSACTION READ ONLY', 'SELECT 1',
      ]);
      expect(result.rows).toEqual([{ n: 1 }]);
      expect(conn.destroy).toHaveBeenCalled();
    });
  });

  describe('driverType', () => {
    it('应该返回 mysql', () => {
      expect(driver.driverType).toBe('mysql');
    });
  });
});
