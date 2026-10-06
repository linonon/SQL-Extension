import mysql from 'mysql2/promise';
import { Types } from 'mysql2';
import type { ConnectionConfig } from '../types/connection.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { BatchOutcome, ColumnInfo, DetailedColumnInfo, QueryResult, SchemaColumn, StatementOutcome, TableInfo } from '../types/query.js';
import { openTransactionWarning } from '../utils/destructive-sql.js';
import { rowObjects, uniqueColumnKeys } from '../utils/result-columns.js';

// mysql2 的 Types 同时是 数字码 -> 类型名 的反查表 (3 -> 'LONG', 253 -> 'VAR_STRING')
const TYPE_NAMES = Types as unknown as Record<number, string | undefined>;

// 返回结果集的查询按值数组取行 (rowsAsArray), 再由 toQueryResult 按去重后的列名组装: 同名列不互相覆盖
const asArrays = (sql: string): mysql.QueryOptions => ({ sql, rowsAsArray: true });

export class MySQLDriver implements IDatabaseDriver {
  readonly driverType = 'mysql';
  private pool: mysql.Pool | null = null;
  // 连接参数 (SSH tunnel 时是本地转发端口): cancel 的 KILL QUERY 另开一条连接发, 不排在可能被占满的池后面
  private server: mysql.ConnectionOptions | null = null;

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    this.server = {
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      connectTimeout: 5000,
    };
    this.pool = mysql.createPool({
      ...this.server,
      database: config.database,
      // DATE/DATETIME/TIMESTAMP 以 MySQL 原生字符串返回 (如 "2018-12-11 15:00:00"),
      // 而非 JS Date. 避免 Date -> JSON 变成 ISO ("...T...Z") 后写回 MySQL 被拒,
      // 也避免 Date 时区换算静默改变显示值. 编辑保存所见即所存.
      dateStrings: true,
      // BIGINT 一律以精确字符串返回 (与 pg int8 一致), 防 snowflake id 等超出 2^53 被 Number() 舍入;
      // COUNT(*) / TABLE_ROWS 等计数也随之变成字符串, 要当数字用的地方显式 Number().
      supportBigNumbers: true,
      bigNumberStrings: true,
      // JSON 列以原文字符串返回, 网格显示 / 编辑 / Clone / CSV 都是真 JSON 而非 [object Object]
      jsonStrings: true,
      // DOUBLE 按服务端文本精确解析: mysql2 默认的文本解析会丢掉最短往返表示的最后一位 (2.3333333333333335 -> 2.333333333333333)
      typeCast: (field, next) => {
        if (field.type !== 'DOUBLE') { return next(); }
        const text = field.string();
        return text === null ? null : Number(text);
      },
      connectionLimit: 5,
      idleTimeout: 30000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
    });
    // 验证连接可用
    try {
      const conn = await this.pool.getConnection();
      conn.release();
    } catch (err) {
      try { await this.pool.end(); } catch { /* 清理 pool 时忽略错误 */ }
      this.pool = null;
      this.server = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      try { await this.pool.end(); } catch { /* 清理时忽略: server 可能已关闭 idle 连接 */ }
      this.pool = null;
      this.server = null;
    }
  }

  isConnected(): boolean {
    return this.pool !== null;
  }

  async ping(): Promise<void> {
    this.assertConnected();
    await this.pool!.query('SELECT 1');
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.query('SHOW DATABASES');
    return result.map((row: Record<string, unknown>) => {
      const val = Object.values(row)[0];
      return String(val);
    });
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const rows = await this.query(
      `SELECT TABLE_NAME as name, TABLE_SCHEMA as \`schema\`, TABLE_ROWS as rowCount
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [database]
    );
    return rows.map((row: Record<string, unknown>) => ({
      name: String(row.name),
      schema: String(row.schema),
      rowCount: Number(row.rowCount ?? 0),
    }));
  }

  async listColumns(database: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.query(
      `SELECT COLUMN_NAME as name, COLUMN_TYPE as dataType, IS_NULLABLE as nullable,
              COLUMN_KEY as columnKey, COLUMN_DEFAULT as defaultValue, EXTRA as extra
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    return rows.map((row: Record<string, unknown>) => ({
      name: String(row.name),
      dataType: String(row.dataType),
      nullable: row.nullable === 'YES',
      isPrimaryKey: row.columnKey === 'PRI',
      defaultValue: row.defaultValue != null ? String(row.defaultValue) : null,
      extra: String(row.extra ?? ''),
    }));
  }

  async listSchemaColumns(database: string): Promise<SchemaColumn[]> {
    const rows = await this.query(
      `SELECT TABLE_NAME as tableName, COLUMN_NAME as name, COLUMN_TYPE as type, COLUMN_COMMENT as comment
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database]
    );
    return rows.map((row: Record<string, unknown>) => ({
      table: String(row.tableName),
      name: String(row.name),
      type: String(row.type),
      comment: String(row.comment ?? ''),
    }));
  }

  async getDetailedColumns(database: string, table: string): Promise<DetailedColumnInfo[]> {
    const rows = await this.query(
      `SELECT COLUMN_NAME as name, COLUMN_TYPE as dataType, IS_NULLABLE as nullable,
              COLUMN_KEY as columnKey, COLUMN_DEFAULT as defaultValue, EXTRA as extra,
              COLUMN_COMMENT as comment
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    return rows.map((row: Record<string, unknown>) => ({
      name: String(row.name),
      dataType: String(row.dataType),
      nullable: row.nullable === 'YES',
      isPrimaryKey: row.columnKey === 'PRI',
      defaultValue: row.defaultValue != null ? String(row.defaultValue) : null,
      extra: String(row.extra ?? ''),
      comment: String(row.comment ?? ''),
    }));
  }

  async getTableDDL(database: string, table: string): Promise<string> {
    const db = database.replace(/`/g, '``');
    const tbl = table.replace(/`/g, '``');
    const rows = await this.query(`SHOW CREATE TABLE \`${db}\`.\`${tbl}\``);
    return String(rows[0]?.['Create Table'] ?? '');
  }

  // SELECT 类查询返回行 (每行是值数组), INSERT/UPDATE/DELETE 返回 ResultSetHeader;
  // CALL 存储过程返回 [结果集1, 结果集2, ..., ResultSetHeader] 且 fields 按结果集分组, 只展示第一个结果集
  private toQueryResult(
    result: unknown,
    fields: mysql.FieldPacket[] | undefined,
    executionTime: number
  ): QueryResult {
    const grouped = fields as unknown as (mysql.FieldPacket[] | undefined)[] | undefined;
    if (Array.isArray(result) && Array.isArray(grouped?.[0])) {
      return this.toQueryResult(result[0], grouped[0], executionTime);
    }
    if (Array.isArray(result)) {
      const keys = uniqueColumnKeys(fields ?? []);
      // 自连接时同一张表以多个别名 (f.table) 出现, 各列分属不同行实例, 按主键写回会写错行, 这张表的列都不挂 source
      const aliasesByTable = new Map<string, Set<string>>();
      for (const f of fields ?? []) {
        const key = `${f.db}.${f.orgTable}`;
        aliasesByTable.set(key, (aliasesByTable.get(key) ?? new Set()).add(f.table));
      }
      const columns: ColumnInfo[] = (fields ?? []).map((f: mysql.FieldPacket, i) => ({
        name: keys[i],
        dataType: (f.type !== undefined ? TYPE_NAMES[f.type] : undefined) ?? String(f.type),
        nullable: true,
        isPrimaryKey: false,
        defaultValue: null,
        extra: '',
        // 表达式列 orgTable 为空; 别名列与去重改名的同名列 orgName != name, 写回会落到别的列, 都不算来源列
        source: f.orgTable && f.db && f.orgName === keys[i] && aliasesByTable.get(`${f.db}.${f.orgTable}`)!.size === 1
          ? { schema: f.db, table: f.orgTable }
          : undefined,
      }));
      return { columns, rows: rowObjects(keys, result as unknown[][]), affectedRows: 0, executionTime };
    }
    const header = result as mysql.ResultSetHeader;
    return { columns: [], rows: [], affectedRows: header.affectedRows, executionTime };
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.assertConnected();
    const start = Date.now();
    const [result, fields] = await this.pool!.query(asArrays(sql), params);
    return this.toQueryResult(result, fields, Date.now() - start);
  }

  async transaction<T>(
    work: (exec: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>
  ): Promise<T> {
    this.assertConnected();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const exec = async (sql: string, params?: unknown[]): Promise<QueryResult> => {
        const start = Date.now();
        const [result, fields] = await conn.query(asArrays(sql), params);
        return this.toQueryResult(result, fields, Date.now() - start);
      };
      const out = await work(exec);
      await conn.commit();
      return out;
    } catch (err) {
      try { await conn.rollback(); } catch { /* rollback 失败忽略, 原始错误更重要 */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  // 会话级只读 + 只读事务: 写语句 (含 WITH ... DELETE / EXPLAIN ANALYZE DML) 与 DDL 都由数据库拒绝
  // (DDL 隐式提交后开始的下一个事务仍是只读); 多语句由 mysql2 默认 multipleStatements=false 拒绝.
  // 调用方的前缀白名单是第二层
  async executeReadOnly(sql: string, database?: string): Promise<QueryResult> {
    this.assertConnected();
    const conn = await this.pool!.getConnection();
    try {
      if (database) {
        await conn.query(`USE \`${database.replace(/`/g, '``')}\``);
      }
      // 服务端超时 (只作用于 SELECT); MariaDB 等没有这个变量时忽略
      try { await conn.query('SET SESSION max_execution_time = 30000'); } catch { /* 变量不存在 */ }
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      await conn.query('START TRANSACTION READ ONLY');
      const start = Date.now();
      const [result, fields] = await conn.query(asArrays(sql));
      return this.toQueryResult(result, fields, Date.now() - start);
    } finally {
      // 销毁而非归还: 会话级副作用 (GET_LOCK, 用户变量, USE) 能活过 ROLLBACK, 不能留给 UI 共用的池
      conn.destroy();
    }
  }

  executeBatch(statements: readonly string[], database?: string, options?: { readonly readOnly?: boolean }): {
    promise: Promise<BatchOutcome>;
    cancel: () => void;
  } {
    this.assertConnected();
    const pool = this.pool!;
    const server = this.server!;
    let threadId: number | undefined;
    let cancelled = false;
    let done = false;

    const promise = (async (): Promise<BatchOutcome> => {
      const results: StatementOutcome[] = [];
      let conn: mysql.PoolConnection | undefined;
      try {
        conn = await pool.getConnection();
        threadId = conn.threadId;
        if (database) {
          await conn.query(`USE \`${database.replace(/`/g, '``')}\``);
        }
        // 会话级只读: DDL 隐式提交后开始的下一个事务仍是只读, 所以 DDL 也被拒 (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION).
        // 语句里显式 SET ... READ WRITE 能解除它: 这里防误写, 权限边界在 DB 账号
        if (options?.readOnly) {
          await conn.query('SET SESSION TRANSACTION READ ONLY');
        }
        for (const sql of statements) {
          // 语句之间被取消: KILL QUERY 打在空闲连接上不生效, 由这里停下
          if (cancelled) { throw new Error('Query cancelled'); }
          const start = Date.now();
          const [result, fields] = await conn.query(asArrays(sql));
          results.push({ sql, ...this.toQueryResult(result, fields, Date.now() - start) });
        }
        return { results, warning: openTransactionWarning(statements) };
      } catch (cause) {
        return {
          results,
          error: { index: results.length, cause },
          warning: openTransactionWarning(statements.slice(0, results.length)),
        };
      } finally {
        done = true;
        // 销毁而非归还: USE / 未提交事务 / SET 等会话状态不能留给 UI 和 agent 共用的池
        conn?.destroy();
      }
    })();

    const cancel = () => {
      if (done || cancelled) { return; }
      cancelled = true;
      if (threadId != null) {
        const id = threadId;
        mysql.createConnection(server)
          .then((c) => c.query(`KILL QUERY ${id}`).finally(() => c.end()))
          .catch((err: Error) => { console.error('[MySQLDriver] Cancel query failed:', err.message); });
      }
    };

    return { promise, cancel };
  }

  private async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    this.assertConnected();
    const [rows] = await this.pool!.query(sql, params);
    return rows as Record<string, unknown>[];
  }

  private assertConnected(): void {
    if (!this.pool) {
      throw new Error('MySQL driver is not connected');
    }
  }
}
