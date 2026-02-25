import pg from 'pg';
import type { ConnectionConfig } from '../types/connection.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { ColumnInfo, DetailedColumnInfo, QueryResult, TableInfo } from '../types/query.js';

export class PgDriver implements IDatabaseDriver {
  readonly driverType = 'postgresql';
  private pool: pg.Pool | null = null;

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', (err: Error) => {
      console.error('[PgDriver] Idle client error:', err.message);
    });
    // 验证连接可用
    const client = await this.pool.connect();
    client.release();
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
    const result = await this.query(
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
    );
    return result.map((row) => String(row.datname));
  }

  async listTables(_database: string): Promise<TableInfo[]> {
    // PG 连接已绑定 database, _database 参数仅保持接口一致
    const rows = await this.query(
      `SELECT t.table_name as name, t.table_schema as schema,
              COALESCE(s.n_live_tup, 0) as row_count
       FROM information_schema.tables t
       LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name AND s.schemaname = t.table_schema
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`
    );
    return rows.map((row) => ({
      name: String(row.name),
      schema: String(row.schema),
      rowCount: Number(row.row_count ?? 0),
    }));
  }

  async listColumns(_database: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.query(
      `SELECT c.column_name as name, c.data_type as data_type,
              c.is_nullable as nullable, c.column_default as default_value,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku
           ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_name = $1
           AND tc.table_schema = 'public'
       ) pk ON pk.column_name = c.column_name
       WHERE c.table_name = $1 AND c.table_schema = 'public'
       ORDER BY c.ordinal_position`,
      [table]
    );
    return rows.map((row) => ({
      name: String(row.name),
      dataType: String(row.data_type),
      nullable: row.nullable === 'YES',
      isPrimaryKey: Boolean(row.is_pk),
      defaultValue: row.default_value != null ? String(row.default_value) : null,
      extra: '',
    }));
  }

  async getDetailedColumns(_database: string, table: string): Promise<DetailedColumnInfo[]> {
    const rows = await this.query(
      `SELECT c.column_name as name, c.data_type, c.is_nullable as nullable,
              c.column_default as default_value,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
              COALESCE(pgd.description, '') as comment
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku
           ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_name = $1 AND tc.table_schema = 'public'
       ) pk ON pk.column_name = c.column_name
       LEFT JOIN pg_catalog.pg_statio_all_tables st
         ON st.relname = c.table_name AND st.schemaname = c.table_schema
       LEFT JOIN pg_catalog.pg_description pgd
         ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
       WHERE c.table_name = $1 AND c.table_schema = 'public'
       ORDER BY c.ordinal_position`,
      [table]
    );
    return rows.map((row) => ({
      name: String(row.name),
      dataType: String(row.data_type),
      nullable: row.nullable === 'YES',
      isPrimaryKey: Boolean(row.is_pk),
      defaultValue: row.default_value != null ? String(row.default_value) : null,
      extra: '',
      comment: String(row.comment ?? ''),
    }));
  }

  async getTableDDL(_database: string, table: string): Promise<string> {
    // PG 无 SHOW CREATE TABLE, 从 metadata 构建
    const columns = await this.query(
      `SELECT c.column_name, c.data_type, c.character_maximum_length,
              c.numeric_precision, c.numeric_scale, c.is_nullable,
              c.column_default, c.udt_name
       FROM information_schema.columns c
       WHERE c.table_name = $1 AND c.table_schema = 'public'
       ORDER BY c.ordinal_position`,
      [table]
    );

    const constraints = await this.query(
      `SELECT con.conname, pg_get_constraintdef(con.oid) as def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE rel.relname = $1 AND nsp.nspname = 'public'`,
      [table]
    );

    const indexes = await this.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE tablename = $1 AND schemaname = 'public'
         AND indexname NOT IN (
           SELECT con.conname FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
           WHERE rel.relname = $1 AND nsp.nspname = 'public'
         )`,
      [table]
    );

    const tbl = `"${table.replace(/"/g, '""')}"`;
    const colDefs = columns.map((col) => {
      const name = `"${String(col.column_name).replace(/"/g, '""')}"`;
      let typeName = String(col.udt_name);
      const maxLen = col.character_maximum_length;
      if (maxLen != null) {
        typeName = `${String(col.data_type)}(${maxLen})`;
      } else if (col.numeric_precision != null && col.numeric_scale != null) {
        typeName = `numeric(${col.numeric_precision},${col.numeric_scale})`;
      }
      const notNull = col.is_nullable === 'NO' ? ' NOT NULL' : '';
      const def = col.column_default != null ? ` DEFAULT ${col.column_default}` : '';
      return `  ${name} ${typeName}${notNull}${def}`;
    });

    const conDefs = constraints.map((c) => `  CONSTRAINT "${String(c.conname)}" ${c.def}`);
    const allDefs = [...colDefs, ...conDefs].join(',\n');
    let ddl = `CREATE TABLE ${tbl} (\n${allDefs}\n);`;

    for (const idx of indexes) {
      ddl += `\n${idx.indexdef};`;
    }

    return ddl;
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.assertConnected();
    const start = Date.now();
    const result = await this.pool!.query(sql, params);
    const executionTime = Date.now() - start;

    const columns: ColumnInfo[] = (result.fields ?? []).map((f) => ({
      name: f.name,
      dataType: String(f.dataTypeID),
      nullable: true,
      isPrimaryKey: false,
      defaultValue: null,
      extra: '',
    }));

    return {
      columns,
      rows: result.rows ?? [],
      affectedRows: result.rowCount ?? 0,
      executionTime,
    };
  }

  executeCancellable(sql: string, params?: unknown[], _database?: string): {
    promise: Promise<QueryResult>;
    cancel: () => void;
  } {
    this.assertConnected();
    let cancelled = false;
    let clientPid: number | undefined;

    const promise = (async () => {
      const client = await this.pool!.connect();
      // pg.PoolClient 未在类型定义中暴露 processID, 但 pg 内部实现中存在此属性
      // 用于 pg_cancel_backend(pid) 取消正在执行的查询
      clientPid = (client as unknown as { processID: number }).processID;
      try {
        const start = Date.now();
        const result = await client.query(sql, params);
        const executionTime = Date.now() - start;

        const columns: ColumnInfo[] = (result.fields ?? []).map((f) => ({
          name: f.name,
          dataType: String(f.dataTypeID),
          nullable: true,
          isPrimaryKey: false,
          defaultValue: null,
          extra: '',
        }));

        return {
          columns,
          rows: result.rows ?? [],
          affectedRows: result.rowCount ?? 0,
          executionTime,
        };
      } finally {
        client.release();
      }
    })();

    const cancel = () => {
      if (cancelled) { return; }
      cancelled = true;
      if (clientPid != null) {
        this.pool!.query(`SELECT pg_cancel_backend(${clientPid})`).catch((err: Error) => { console.error('[PgDriver] Cancel query failed:', err.message); });
      }
    };

    return { promise, cancel };
  }

  private async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    this.assertConnected();
    const result = await this.pool!.query(sql, params);
    return result.rows;
  }

  private assertConnected(): void {
    if (!this.pool) {
      throw new Error('PostgreSQL driver is not connected');
    }
  }
}
