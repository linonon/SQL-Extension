import type { ConnectionConfig } from './connection.js';
import type { ColumnInfo, DetailedColumnInfo, QueryResult, TableInfo } from './query.js';

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

  execute(sql: string, params?: unknown[]): Promise<QueryResult>;

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
