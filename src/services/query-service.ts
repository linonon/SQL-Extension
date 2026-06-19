import type { IDatabaseDriver } from '../types/driver.js';
import type { PagedResult, QueryResult } from '../types/query.js';
import { buildCount, buildDelete, buildInsert, buildSelect, buildUpdate } from '../utils/sql-builder.js';

export class QueryService {
  async fetchRows(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    offset: number,
    limit: number,
    skipColumns?: boolean
  ): Promise<PagedResult> {
    const countQuery = buildCount(driver.driverType, table, database);
    const selectQuery = buildSelect(driver.driverType, table, offset, limit, database);

    // COUNT 和 SELECT 并行, columns 按需获取
    const [countResult, result, columns] = await Promise.all([
      driver.execute(countQuery.sql, countQuery.params),
      driver.execute(selectQuery.sql, selectQuery.params),
      skipColumns ? Promise.resolve([]) : driver.listColumns(database, table),
    ]);

    const total = Number(countResult.rows[0]?.count ?? 0);

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

  // 批量更新做成原子操作: 整批在单个事务内执行, 任一行失败则全部回滚.
  // 避免逐行 autocommit 在中途失败时留下半更新的不一致状态.
  async batchUpdate(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    updates: readonly { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]
  ): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    const run = async (
      exec: (sql: string, params?: unknown[]) => Promise<QueryResult>
    ): Promise<void> => {
      for (const u of updates) {
        const query = buildUpdate(driver.driverType, table, u.primaryKeys, u.changes, database);
        await exec(query.sql, query.params);
      }
    };
    if (driver.transaction) {
      await driver.transaction(run);
    } else {
      // 无事务能力的 driver 退化为逐条 (SQL driver 均实现 transaction, 此为防御兜底)
      await run((sql, params) => driver.execute(sql, params));
    }
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
