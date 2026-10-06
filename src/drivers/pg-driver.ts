import pg from 'pg';
import type { ConnectionConfig } from '../types/connection.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { BatchOutcome, ColumnInfo, DetailedColumnInfo, QueryResult, SchemaColumn, StatementOutcome, TableInfo } from '../types/query.js';
import { OPEN_TRANSACTION_WARNING, splitSqlStatements } from '../utils/destructive-sql.js';
import { pgSequenceOfDefault } from '../utils/sql-builder.js';
import { rowObjects, uniqueColumnKeys } from '../utils/result-columns.js';

// node-postgres 默认把 DATE/TIMESTAMP/TIMESTAMPTZ 解析成 JS Date, JSON 序列化后
// 变成 ISO ("2018-12-11T15:00:00.000Z"), 写回 PG 会因格式不符被拒, 且 Date 时区
// 换算会静默改变显示值; JSON/JSONB 默认解析成对象, grid / Clone / dump 会变成
// [object Object]. 注册 identity parser 让这些类型保持 PG 原生文本, 编辑保存所见即所存.
// (TIME/TIMETZ 默认已是字符串.)
for (const oid of [
  pg.types.builtins.DATE, pg.types.builtins.TIMESTAMP, pg.types.builtins.TIMESTAMPTZ,
  pg.types.builtins.JSON, pg.types.builtins.JSONB,
]) {
  pg.types.setTypeParser(oid, (value: string) => value);
}

// PG 连接绑定单个 database, 跨库只能另起连接: 每个库懒建一个 pool, 连接参数相同 (SSH tunnel 时 host/port 是本地转发端口).
// 只看 public schema
// 结果列类型: OID 反查内置类型名 (int4 / varchar ...), 枚举 / 域等非内置类型保留 OID
const PG_TYPE_NAMES = new Map<number, string>(
  Object.entries(pg.types.builtins).map(([name, oid]) => [oid as number, name.toLowerCase()]),
);

export class PgDriver implements IDatabaseDriver {
  readonly driverType = 'postgresql';
  private config: (ConnectionConfig & { readonly password: string }) | null = null;
  private readonly pools = new Map<string, pg.Pool>();

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    this.config = config;
    // 验证连接可用
    try {
      const client = await this.poolFor().connect();
      client.release();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    this.config = null;
    await Promise.all(pools.map(async (p) => {
      try { await p.end(); } catch { /* 清理时忽略: server 可能已关闭 idle 连接 */ }
    }));
  }

  isConnected(): boolean {
    return this.config !== null;
  }

  async ping(): Promise<void> {
    await this.poolFor().query('SELECT 1');
  }

  // database 缺省或为空时用连接配置的库
  private poolFor(database?: string): pg.Pool {
    this.assertConnected();
    const config = this.config!;
    const db = database || config.database;
    let pool = this.pools.get(db);
    if (!pool) {
      pool = new pg.Pool({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: db,
        max: 5,
        // 其他库的空闲连接 1s 就关: db-browser 列表要给每个库各开一条连接, 不能长时间占着服务端 max_connections
        idleTimeoutMillis: db === config.database ? 30000 : 1000,
        connectionTimeoutMillis: 5000,
      });
      pool.on('error', (err: Error) => {
        console.error('[PgDriver] Idle client error:', err.message);
      });
      this.pools.set(db, pool);
    }
    return pool;
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.query(
      undefined,
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
    );
    return result.map((row) => String(row.datname));
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const rows = await this.query(
      database,
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

  async listColumns(database: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.query(
      database,
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

  async listSchemaColumns(database: string): Promise<SchemaColumn[]> {
    const rows = await this.query(
      database,
      `SELECT c.table_name, c.column_name, c.data_type,
              COALESCE(col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position), '') as comment
       FROM information_schema.columns c
       WHERE c.table_schema = 'public'
       ORDER BY c.table_name, c.ordinal_position`
    );
    return rows.map((row) => ({
      table: String(row.table_name),
      name: String(row.column_name),
      type: String(row.data_type),
      comment: String(row.comment ?? ''),
    }));
  }

  async getDetailedColumns(database: string, table: string): Promise<DetailedColumnInfo[]> {
    const rows = await this.query(
      database,
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

  async getTableDDL(database: string, table: string): Promise<string> {
    // PG 无 SHOW CREATE TABLE, 从 metadata 构建 (三个查询并行)
    const [columns, constraints, indexes] = await Promise.all([
      this.query(
        database,
        `SELECT c.column_name, c.data_type, c.character_maximum_length,
                c.numeric_precision, c.numeric_scale, c.is_nullable,
                c.column_default, c.udt_name
         FROM information_schema.columns c
         WHERE c.table_name = $1 AND c.table_schema = 'public'
         ORDER BY c.ordinal_position`,
        [table]
      ),
      this.query(
        database,
        `SELECT con.conname, pg_get_constraintdef(con.oid) as def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE rel.relname = $1 AND nsp.nspname = 'public'`,
        [table]
      ),
      this.query(
        database,
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
      ),
    ]);

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
    // 默认值引用的序列 (serial 列) 不在表定义里, 先建出来: 导入时 dump 的 DROP TABLE 会连带删掉表拥有的序列
    const seqDefs = columns
      .map((col) => pgSequenceOfDefault(col.column_default))
      .filter((seq) => seq !== undefined)
      .map((seq) => `CREATE SEQUENCE IF NOT EXISTS ${seq};\n`);
    let ddl = `${seqDefs.join('')}CREATE TABLE ${tbl} (\n${allDefs}\n);`;

    for (const idx of indexes) {
      ddl += `\n${idx.indexdef};`;
    }

    return ddl;
  }

  // 返回结果集的查询按值数组取行 (rowMode 'array'), 再按去重后的列名组装: 同名列不互相覆盖
  private toQueryResult(result: pg.QueryArrayResult, executionTime: number): QueryResult {
    const keys = uniqueColumnKeys(result.fields ?? []);
    const columns: ColumnInfo[] = (result.fields ?? []).map((f, i) => ({
      name: keys[i],
      dataType: PG_TYPE_NAMES.get(f.dataTypeID) ?? String(f.dataTypeID),
      nullable: true,
      isPrimaryKey: false,
      defaultValue: null,
      extra: '',
    }));
    return {
      columns,
      rows: rowObjects(keys, result.rows ?? []),
      affectedRows: result.rowCount ?? 0,
      executionTime,
    };
  }

  async execute(sql: string, params?: unknown[], database?: string): Promise<QueryResult> {
    const start = Date.now();
    const result = await this.poolFor(database).query({ text: sql, values: params, rowMode: 'array' });
    return this.toQueryResult(result, Date.now() - start);
  }

  async transaction<T>(
    work: (exec: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>,
    database?: string,
  ): Promise<T> {
    const client = await this.poolFor(database).connect();
    try {
      await client.query('BEGIN');
      const exec = async (sql: string, params?: unknown[]): Promise<QueryResult> => {
        const start = Date.now();
        const result = await client.query({ text: sql, values: params, rowMode: 'array' });
        return this.toQueryResult(result, Date.now() - start);
      };
      const out = await work(exec);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* rollback 失败忽略, 原始错误更重要 */ }
      throw err;
    } finally {
      client.release();
    }
  }

  // 只读事务拒绝写 (含 writable CTE / SELECT INTO / nextval); extended 协议拒绝多语句,
  // 防 "SELECT 1; COMMIT; DROP ..." 在事务里先提交再写.
  async executeReadOnly(sql: string, database?: string): Promise<QueryResult> {
    const client = await this.poolFor(database).connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL statement_timeout = 30000');
      const start = Date.now();
      const result = await client.query({ text: sql, queryMode: 'extended', rowMode: 'array' } as pg.QueryArrayConfig);
      return this.toQueryResult(result, Date.now() - start);
    } finally {
      // 销毁而非归还: advisory lock 等会话级副作用能活过 ROLLBACK, 不能留给 UI 共用的池
      client.release(true);
    }
  }

  executeBatch(statements: readonly string[], database?: string, options?: { readonly readOnly?: boolean }): {
    promise: Promise<BatchOutcome>;
    cancel: () => void;
  } {
    const pool = this.poolFor(database);
    let pid: number | undefined;
    let cancelled = false;
    let done = false;

    const promise = (async (): Promise<BatchOutcome> => {
      const results: StatementOutcome[] = [];
      let client: pg.PoolClient | undefined;
      let index = 0;
      // 按服务端命令标签跟踪显式事务 (END 的标签是 COMMIT, ABORT 是 ROLLBACK); ROLLBACK TO SAVEPOINT 也是 ROLLBACK 标签, 漏报不误报
      let open = false;
      try {
        client = await pool.connect();
        // pg.PoolClient 的类型定义未暴露 processID, 运行时存在, 供 pg_cancel_backend(pid) 使用
        pid = (client as unknown as { processID: number }).processID;
        // 会话默认只读: 之后的隐式 / 显式事务都拒绝写与 DDL. 语句里显式 SET ... READ WRITE 能解除它: 这里防误写, 权限边界在 DB 账号
        if (options?.readOnly) {
          await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
        }
        for (; index < statements.length; index++) {
          const text = statements[index];
          if (cancelled) { throw new Error('Query cancelled'); }
          const start = Date.now();
          // 无参数走 simple protocol: 多语句文本返回结果数组, 出错时整段在隐式事务里回滚, 拿不到前面的结果
          const raw = await client.query({ text, rowMode: 'array' }) as pg.QueryArrayResult | pg.QueryArrayResult[];
          // 一次往返返回全部结果, 各条只能记整段耗时
          const elapsed = Date.now() - start;
          const parts = Array.isArray(raw) ? raw : [raw];
          const labels = parts.length > 1 ? splitSqlStatements(text, 'postgresql') : [text];
          for (let i = 0; i < parts.length; i++) {
            const command = parts[i].command;
            if (command === 'BEGIN' || command === 'START') { open = true; }
            else if (command === 'COMMIT' || command === 'ROLLBACK') { open = false; }
            const out = this.toQueryResult(parts[i], elapsed);
            results.push({
              ...out,
              sql: labels.length === parts.length ? labels[i] : parts[i].command,
              columns: await this.withSources(client, parts[i].fields ?? [], out.columns),
            });
          }
        }
        return { results, warning: open ? OPEN_TRANSACTION_WARNING : undefined };
      } catch (cause) {
        return { results, error: { index, cause }, warning: open ? OPEN_TRANSACTION_WARNING : undefined };
      } finally {
        done = true;
        // 销毁而非归还: 未提交事务 / SET 等会话状态不能留给 UI 和 agent 共用的池
        client?.release(true);
      }
    })();

    const cancel = () => {
      if (done || cancelled) { return; }
      cancelled = true;
      if (pid != null) {
        // 另开一条连接发 (参数同池): 池可能被执行中的查询占满, pool.query 要排队到它们结束
        const killer = new pg.Client(pool.options);
        killer.connect()
          .then(() => killer.query(`SELECT pg_cancel_backend(${pid})`).finally(() => killer.end()))
          .catch((err: Error) => { console.error('[PgDriver] Cancel query failed:', err.message); });
      }
    };

    return { promise, cancel };
  }

  // RowDescription 只带 tableID / columnID (表 OID + attnum), 查 catalog 还原 schema.table 与原列名.
  // 只给未改名的原始列挂 source (别名列与去重改名的同名列不挂); 查询失败时不挂 (结果网格只读)
  private async withSources(client: pg.PoolClient, fields: pg.FieldDef[], columns: readonly ColumnInfo[]): Promise<readonly ColumnInfo[]> {
    const oids = [...new Set(fields.map((f) => f.tableID).filter((id) => id > 0))];
    if (oids.length === 0) { return columns; }
    try {
      const { rows } = await client.query(
        `SELECT a.attrelid AS oid, a.attnum, a.attname, c.relname, n.nspname
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0`,
        [oids]
      );
      const byKey = new Map(rows.map((r) => [`${r.oid}.${r.attnum}`, r]));
      return columns.map((col, i) => {
        const f = fields[i];
        const r = byKey.get(`${f.tableID}.${f.columnID}`);
        return r && r.attname === col.name ? { ...col, source: { schema: String(r.nspname), table: String(r.relname) } } : col;
      });
    } catch {
      return columns;
    }
  }

  private async query(database: string | undefined, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const result = await this.poolFor(database).query(sql, params);
    return result.rows;
  }

  private assertConnected(): void {
    if (!this.config) {
      throw new Error('PostgreSQL driver is not connected');
    }
  }
}
