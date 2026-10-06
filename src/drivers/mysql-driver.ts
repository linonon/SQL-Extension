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

// information_schema 的默认值与生成列表达式统一成 SQL 原文, 表达式默认值统一由 EXTRA 的 DEFAULT_GENERATED 标出
// (编辑表按原文显示, 写回时字面量再转义, 表达式原样写):
// - MySQL 8: 表达式文本 (表达式默认值, 生成列表达式) 按字符串字面量转义过 (\\ 与 \'), 逐个 \x 还原成 x; 字面量默认值是原值. 5.7 都是原文
// - MariaDB (10.2.7+): 字面量带引号 ('it''s', 引号与反斜杠双写), 去引号; 不带引号的 NULL 即 DEFAULT NULL;
//   其余不带引号的非数值是表达式, 没有 DEFAULT_GENERATED, 补上
function columnText(row: Record<string, unknown>): Pick<DetailedColumnInfo, 'defaultValue' | 'extra' | 'generationExpression'> {
  const version = String(row.version ?? '');
  const mariadb = /mariadb/i.test(version);
  const unescape = (text: string) => (!mariadb && parseInt(version, 10) >= 8 ? text.replace(/\\(.)/g, '$1') : text);
  let defaultValue = row.defaultValue != null ? String(row.defaultValue) : null;
  let extra = String(row.extra ?? '');
  if (defaultValue !== null && mariadb) {
    if (/^'(?:[^'\\]|''|\\.)*'$/.test(defaultValue)) {
      defaultValue = defaultValue.slice(1, -1).replace(/''|\\\\/g, (m) => m[0]);
    } else if (defaultValue === 'NULL') {
      defaultValue = null;
    } else if (!/^-?\d+(\.\d+)?$/.test(defaultValue)) {
      extra = `DEFAULT_GENERATED ${extra}`.trim();
    }
  } else if (defaultValue !== null && /\bDEFAULT_GENERATED\b/i.test(extra)) {
    defaultValue = unescape(defaultValue);
  } else if (defaultValue !== null && !mariadb && parseInt(version, 10) >= 8
    && /^0x[0-9a-f]*$/i.test(defaultValue) && /^\s*(var)?binary\b/i.test(String(row.dataType ?? ''))) {
    // MySQL 8 把 BINARY / VARBINARY 的字面默认值报成十六进制 (0x6162); 转成 x'..' 字面量, 改列时原样写回
    defaultValue = `x'${defaultValue.slice(2)}'`;
  }
  const expression = row.generationExpression ? unescape(String(row.generationExpression)) : '';
  return { defaultValue, extra, ...(expression ? { generationExpression: expression } : {}) };
}

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
    return this.baseTables(database);
  }

  async listAllTables(): Promise<TableInfo[]> {
    return this.baseTables();
  }

  // 一个库或全部库 (database 缺省) 的表, 一条 information_schema 查询
  private async baseTables(database?: string): Promise<TableInfo[]> {
    const rows = await this.query(
      `SELECT TABLE_NAME as name, TABLE_SCHEMA as \`schema\`, TABLE_ROWS as rowCount
       FROM information_schema.TABLES
       WHERE ${database === undefined ? '' : 'TABLE_SCHEMA = ? AND '}TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      database === undefined ? [] : [database]
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
    // collation 只在与表默认不同时返回: 改列时不写 COLLATE 即回落到表默认, SHOW CREATE 不会因此多出显式的 CHARACTER SET / COLLATE
    const rows = await this.query(
      `SELECT c.COLUMN_NAME as name, c.COLUMN_TYPE as dataType, c.IS_NULLABLE as nullable,
              c.COLUMN_KEY as columnKey, c.COLUMN_DEFAULT as defaultValue, c.EXTRA as extra,
              c.COLUMN_COMMENT as comment, c.GENERATION_EXPRESSION as generationExpression, VERSION() as version,
              CASE WHEN c.COLLATION_NAME <> t.TABLE_COLLATION THEN c.COLLATION_NAME END as collation
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
       ORDER BY c.ORDINAL_POSITION`,
      [database, table]
    );
    return rows.map((row: Record<string, unknown>) => ({
      name: String(row.name),
      dataType: String(row.dataType),
      nullable: row.nullable === 'YES',
      isPrimaryKey: row.columnKey === 'PRI',
      ...columnText(row),
      comment: String(row.comment ?? ''),
      ...(row.collation != null ? { collation: String(row.collation) } : {}),
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
        // 只防误写, 不是权限边界: 语句里的 SET SESSION TRANSACTION READ WRITE 或 START TRANSACTION READ WRITE 能解除它,
        // 服务端级的管理语句 (SET GLOBAL, KILL, FLUSH, GET_LOCK 等命名锁) 也不受它限制. 真正的边界是 DB 账号的权限
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
        return { results, warning: openTransactionWarning(statements), ...(cancelled ? { cancelled: true } : {}) };
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
