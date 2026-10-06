import type { IDatabaseDriver } from '../types/driver.js';
import type { QueryResult } from '../types/query.js';
import { buildInsert, buildUpdate } from '../utils/sql-builder.js';

export class QueryService {
  async insertRow(
    driver: IDatabaseDriver,
    database: string,
    table: string,
    row: Record<string, unknown>
  ): Promise<QueryResult> {
    const query = buildInsert(driver.driverType, table, row, database);
    return driver.execute(query.sql, query.params, database);
  }

  // 批量更新做成原子操作: 整批在单个事务内执行, 任一行失败则全部回滚.
  // 避免逐行 autocommit 在中途失败时留下半更新的不一致状态.
  // 每条 UPDATE 必须恰好命中 1 行 (mysql2 默认带 FOUND_ROWS, affectedRows 是匹配行数; pg 是 rowCount),
  // 否则抛错回滚: 0 行 = 行已被删或主键已变, 多行 = 主键不唯一, 都不能报成功.
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
        const { affectedRows } = await exec(query.sql, query.params);
        if (affectedRows !== 1) {
          const pk = Object.entries(u.primaryKeys).map(([k, v]) => `${k}=${String(v)}`).join(', ');
          throw new Error(`UPDATE matched ${affectedRows} rows for ${pk} (expected 1)`);
        }
      }
    };
    if (driver.transaction) {
      await driver.transaction(run, database);
    } else {
      // 无事务能力的 driver 退化为逐条 (SQL driver 均实现 transaction, 此为防御兜底)
      await run((sql, params) => driver.execute(sql, params, database));
    }
  }
}
