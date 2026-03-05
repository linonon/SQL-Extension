import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { isReadonlySQL, enforceLimit } from '../sql-validator.js';
import { makeResult, makeError, toErrorMessage } from './mcp-result.js';
import type { QueryResultData } from './types.js';

export function registerQueryTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.tool(
    'db_query',
    'Execute a read-only SQL query. Only SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH statements are allowed. Results are limited to 500 rows maximum. Works with MySQL and PostgreSQL connections.',
    {
      connectionId: z.string().describe('Connection ID'),
      sql: z.string().describe('SQL query (read-only)'),
      database: z.string().optional().describe('Database name (for MySQL USE context)'),
    },
    async (params) => {
      try {
        if (!isReadonlySQL(params.sql)) {
          return makeError(
            'Only read-only SQL is allowed (SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH). Write operations are not permitted.',
            'READONLY_VIOLATION',
          );
        }

        const safeSql = enforceLimit(params.sql);
        let result: QueryResultData;

        // IPC mode: 非 pool 连接
        if (!params.connectionId.startsWith('conn_') && ipc.connected) {
          result = await ipc.request('query', {
            connectionId: params.connectionId,
            sql: safeSql,
            database: params.database,
          }) as QueryResultData;
        } else {
          // Standalone mode: pool 连接
          const driver = pool.getDriver(params.connectionId);
          const entry = pool.getEntry(params.connectionId);
          if (params.database && entry.driverType === 'mysql') {
            const { promise } = driver.executeCancellable(safeSql, undefined, params.database);
            result = await promise as QueryResultData;
          } else {
            result = await driver.execute(safeSql) as QueryResultData;
          }
        }

        return makeResult({
          columns: result.columns?.map(c => ({ name: c.name, dataType: c.dataType })) ?? [],
          rows: result.rows,
          rowCount: result.rows.length,
          executionTime: result.executionTime,
        });
      } catch (err) {
        return makeError(toErrorMessage(err), 'QUERY_FAILED');
      }
    }
  );
}
