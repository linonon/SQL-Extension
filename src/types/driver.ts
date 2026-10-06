import type { ConnectionConfig } from './connection.js';
import type { BatchOutcome, ColumnInfo, DetailedColumnInfo, QueryResult, TableInfo } from './query.js';

export interface IDatabaseDriver {
  readonly driverType: string;

  connect(config: ConnectionConfig & { readonly password: string }): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<void>;

  listDatabases(): Promise<string[]>;
  listTables(database: string): Promise<TableInfo[]>;
  listColumns(database: string, table: string): Promise<ColumnInfo[]>;

  getTableDDL(database: string, table: string): Promise<string>;
  getDetailedColumns(database: string, table: string): Promise<DetailedColumnInfo[]>;

  // database: 语句要落的库. PG 一个库一个 pool, 据此选 pool (缺省为连接配置的库);
  // MySQL 生成的 SQL 自带库前缀, 忽略它
  execute(sql: string, params?: unknown[], database?: string): Promise<QueryResult>;

  // 在单个连接的事务内运行 work; work 抛错则 ROLLBACK 并向上抛, 否则 COMMIT. database 同 execute.
  // 仅 SQL driver 实现 (mongo/redis 等无事务语义, 故 optional).
  transaction?<T>(
    work: (exec: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>,
    database?: string,
  ): Promise<T>;

  // 只读事务内执行单条语句 (MCP db_read 的只读边界, 由数据库强制), 服务端 30s 超时. 仅 MySQL / PostgreSQL 实现.
  executeReadOnly?(sql: string, database?: string): Promise<QueryResult>;

  // 一次用户执行 (编辑器 Execute / 导入 / MCP db_execute) 的全部语句: 借一条专用连接, 切到 database,
  // 按序执行, 遇错即停, 结束后一律销毁连接, 会话状态 (USE / 事务 / SET) 不回共享池.
  // cancel 只取消这条连接上的语句, 执行结束后为 no-op.
  // MySQL 每项一条语句 (mysql2 未开 multipleStatements); PG 每项可以是多语句文本, 走 simple protocol 由服务端切分.
  // 仅 MySQL / PostgreSQL 实现.
  executeBatch?(statements: readonly string[], database?: string): {
    promise: Promise<BatchOutcome>;
    cancel: () => void;
  };

  executeCancellable(
    sql: string,
    params?: unknown[],
    database?: string,
    options?: { readonly autoConvertIds?: boolean },
  ): {
    promise: Promise<QueryResult>;
    cancel: () => void;
  };
}
