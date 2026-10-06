import mysql from 'mysql2/promise';
import type { ConnectionConfig } from '../types/connection.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { ColumnInfo, DetailedColumnInfo, QueryResult, TableInfo } from '../types/query.js';

export class MySQLDriver implements IDatabaseDriver {
  readonly driverType = 'mysql';
  private pool: mysql.Pool | null = null;

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
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
      connectionLimit: 5,
      idleTimeout: 30000,
      connectTimeout: 5000,
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
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      try { await this.pool.end(); } catch { /* 清理时忽略: server 可能已关闭 idle 连接 */ }
      this.pool = null;
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

  // SELECT 类查询返回行数组, INSERT/UPDATE/DELETE 返回 ResultSetHeader
  private toQueryResult(
    result: unknown,
    fields: mysql.FieldPacket[] | undefined,
    executionTime: number
  ): QueryResult {
    if (Array.isArray(result)) {
      // 自连接时同一张表以多个别名 (f.table) 出现, 各列分属不同行实例, 按主键写回会写错行, 这张表的列都不挂 source
      const aliasesByTable = new Map<string, Set<string>>();
      for (const f of fields ?? []) {
        const key = `${f.db}.${f.orgTable}`;
        aliasesByTable.set(key, (aliasesByTable.get(key) ?? new Set()).add(f.table));
      }
      const columns: ColumnInfo[] = (fields ?? []).map((f: mysql.FieldPacket) => ({
        name: f.name,
        dataType: String(f.type),
        nullable: true,
        isPrimaryKey: false,
        defaultValue: null,
        extra: '',
        // 表达式列 orgTable 为空; 别名列 orgName != name, 写回会落到别的列, 都不算来源列
        source: f.orgTable && f.db && f.orgName === f.name && aliasesByTable.get(`${f.db}.${f.orgTable}`)!.size === 1
          ? { schema: f.db, table: f.orgTable }
          : undefined,
      }));
      return { columns, rows: result as Record<string, unknown>[], affectedRows: 0, executionTime };
    }
    const header = result as mysql.ResultSetHeader;
    return { columns: [], rows: [], affectedRows: header.affectedRows, executionTime };
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.assertConnected();
    const start = Date.now();
    const [result, fields] = await this.pool!.query(sql, params);
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
        const [result, fields] = await conn.query(sql, params);
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

  // 写语句 (含 WITH ... DELETE / EXPLAIN ANALYZE DML) 被只读事务拒绝; 多语句由 mysql2 默认
  // multipleStatements=false 拒绝. DDL 会隐式提交绕过只读事务, 由调用方的前缀白名单挡住.
  async executeReadOnly(sql: string, database?: string): Promise<QueryResult> {
    this.assertConnected();
    const conn = await this.pool!.getConnection();
    try {
      if (database) {
        await conn.query(`USE \`${database.replace(/`/g, '``')}\``);
      }
      await conn.query('START TRANSACTION READ ONLY');
      const start = Date.now();
      const [result, fields] = await conn.query(sql);
      return this.toQueryResult(result, fields, Date.now() - start);
    } finally {
      // 销毁而非归还: 会话级副作用 (GET_LOCK, 用户变量, USE) 能活过 ROLLBACK, 不能留给 UI 共用的池
      conn.destroy();
    }
  }

  executeCancellable(sql: string, params?: unknown[], database?: string): {
    promise: Promise<QueryResult>;
    cancel: () => void;
  } {
    this.assertConnected();
    let cancelled = false;
    let connectionThreadId: number | undefined;

    const promise = (async () => {
      const conn = await this.pool!.getConnection();
      connectionThreadId = conn.threadId;
      try {
        // 切换到目标 database, 确保用户 SQL 不需要 database 前缀
        if (database) {
          await conn.query(`USE \`${database.replace(/`/g, '``')}\``);
        }
        const start = Date.now();
        const [result, fields] = await conn.query(sql, params);
        return this.toQueryResult(result, fields, Date.now() - start);
      } finally {
        conn.release();
      }
    })();

    const cancel = () => {
      if (cancelled) { return; }
      cancelled = true;
      if (connectionThreadId != null) {
        this.pool!.query(`KILL QUERY ${connectionThreadId}`).catch((err: Error) => { console.error('[MySQLDriver] Cancel query failed:', err.message); });
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
