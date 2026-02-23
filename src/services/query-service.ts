import type { IDatabaseDriver } from '../types/driver.js';
import type { PagedResult, QueryResult } from '../types/query.js';
import { buildCount, buildDelete, buildInsert, buildSelect, buildUpdate } from '../utils/sql-builder.js';

export class QueryService {
  async fetchRows(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    offset: number,
    limit: number
  ): Promise<PagedResult> {
    const countQuery = buildCount(driver.driverType, table, database);
    const countResult = await driver.execute(countQuery.sql, countQuery.params);
    const total = Number(countResult.rows[0]?.count ?? 0);

    const selectQuery = buildSelect(driver.driverType, table, offset, limit, database);
    const result = await driver.execute(selectQuery.sql, selectQuery.params);

    const columns = await driver.listColumns(database, table);

    return {
      columns,
      rows: result.rows,
      total,
      page: { offset, limit },
    };
  }

  async insertRow(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    row: Record<string, unknown>
  ): Promise<QueryResult> {
    const query = buildInsert(driver.driverType, table, row, database);
    return driver.execute(query.sql, query.params);
  }

  async updateRow(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    primaryKeys: Record<string, unknown>,
    changes: Record<string, unknown>
  ): Promise<QueryResult> {
    const query = buildUpdate(driver.driverType, table, primaryKeys, changes, database);
    return driver.execute(query.sql, query.params);
  }

  async deleteRow(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    primaryKeys: Record<string, unknown>
  ): Promise<QueryResult> {
    const query = buildDelete(driver.driverType, table, primaryKeys, database);
    return driver.execute(query.sql, query.params);
  }

  async executeRaw(
    driver: IDatabaseDriver,
    _database: string,
    sql: string
  ): Promise<QueryResult> {
    // raw SQL 由用户自行指定 database, 不自动加前缀
    return driver.execute(sql);
  }
}
