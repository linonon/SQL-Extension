import type { IDatabaseDriver } from '../types/driver.js';
import type { ColumnInfo, TableInfo } from '../types/query.js';

export class SchemaService {
  async listDatabases(driver: IDatabaseDriver): Promise<string[]> {
    return driver.listDatabases();
  }

  async listTables(driver: IDatabaseDriver, database: string): Promise<TableInfo[]> {
    // 不需要 USE, driver.listTables 内部通过 information_schema 的 WHERE 条件过滤
    return driver.listTables(database);
  }

  async listColumns(
    driver: IDatabaseDriver,
    database: string,
    table: string
  ): Promise<ColumnInfo[]> {
    return driver.listColumns(database, table);
  }
}
