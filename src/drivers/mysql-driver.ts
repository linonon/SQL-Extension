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
      connectionLimit: 5,
      idleTimeout: 30000,
      connectTimeout: 5000,
    });
    this.pool.on('error', (err: Error) => {
      console.error('[MySQLDriver] Idle client error:', err.message);
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

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.assertConnected();
    const start = Date.now();
    const [result, fields] = await this.pool!.query(sql, params);
    const executionTime = Date.now() - start;

    // SELECT 类查询返回行数组, INSERT/UPDATE/DELETE 返回 ResultSetHeader
    if (Array.isArray(result)) {
      const columns: ColumnInfo[] = (fields ?? []).map((f: mysql.FieldPacket) => ({
        name: f.name,
        dataType: String(f.type),
        nullable: true,
        isPrimaryKey: false,
        defaultValue: null,
        extra: '',
      }));
      return {
        columns,
        rows: result as Record<string, unknown>[],
        affectedRows: 0,
        executionTime,
      };
    }

    const header = result as mysql.ResultSetHeader;
    return {
      columns: [],
      rows: [],
      affectedRows: header.affectedRows,
      executionTime,
    };
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
        const executionTime = Date.now() - start;

        if (Array.isArray(result)) {
          const columns: ColumnInfo[] = (fields ?? []).map((f: mysql.FieldPacket) => ({
            name: f.name,
            dataType: String(f.type),
            nullable: true,
            isPrimaryKey: false,
            defaultValue: null,
            extra: '',
          }));
          return { columns, rows: result as Record<string, unknown>[], affectedRows: 0, executionTime };
        }

        const header = result as mysql.ResultSetHeader;
        return { columns: [], rows: [], affectedRows: header.affectedRows, executionTime };
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
