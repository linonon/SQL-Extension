import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import { isReadonlySQL, enforceLimit } from '../sql-validator.js';

export function registerQueryTools(server: McpServer, pool: ConnectionPool): void {
  server.tool(
    'db_query',
    'Execute a read-only SQL query. Only SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH statements are allowed. Results are limited to 500 rows maximum. Works with MySQL and PostgreSQL connections.',
    {
      connectionId: z.string().describe('Connection ID from db_connect'),
      sql: z.string().describe('SQL query (read-only)'),
      database: z.string().optional().describe('Database name (for MySQL USE context)'),
    },
    async (params) => {
      try {
        if (!isReadonlySQL(params.sql)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Only read-only SQL is allowed (SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH). Write operations are not permitted.',
                code: 'READONLY_VIOLATION',
              }),
            }],
            isError: true,
          };
        }

        const safeSql = enforceLimit(params.sql);
        const driver = pool.getDriver(params.connectionId);
        const entry = pool.getEntry(params.connectionId);

        // 对于 MySQL, 如果指定了 database, 用 executeCancellable 传 database context
        // 对于 PostgreSQL, database context 在连接时已确定
        let result;
        if (params.database && entry.driverType === 'mysql') {
          const { promise } = driver.executeCancellable(safeSql, undefined, params.database);
          result = await promise;
        } else {
          result = await driver.execute(safeSql);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              columns: result.columns.map(c => ({ name: c.name, dataType: c.dataType })),
              rows: result.rows,
              rowCount: result.rows.length,
              executionTime: result.executionTime,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              code: 'QUERY_FAILED',
              connectionId: params.connectionId,
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
