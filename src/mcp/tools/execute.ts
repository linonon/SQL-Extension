import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { routeQuery } from '../query-router.js';

const DB_EXECUTE_DESCRIPTION = [
  'Execute write operations and DDL. Query format by database type:',
  '- MySQL/PostgreSQL: SQL string, e.g. "INSERT INTO users (name) VALUES (\'foo\')", "DROP TABLE ..."',
  '- Redis: command string, e.g. "SET key val EX 60", "DEL key1", "FLUSHDB"',
  '- MongoDB: JSON, e.g. {"collection":"users","method":"insertOne","document":{"name":"foo"}}',
  '- Kafka: JSON, e.g. {"action":"produce","topic":"t1","key":"k","value":"v"}',
  '- RabbitMQ: not supported yet',
  'The database parameter is optional for MySQL (schema context), required for MongoDB, and for Redis it selects db index (0-15).',
].join('\n');

export function registerExecuteTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.registerTool(
    'db_execute',
    {
      title: 'Execute Query',
      description: DB_EXECUTE_DESCRIPTION,
      inputSchema: {
        connectionId: z.string().describe('Connection ID'),
        query: z.string().describe('Query string (format depends on database type)'),
        database: z.string().optional().describe('Database/schema name (MySQL context, MongoDB required, Redis db index 0-15)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => routeQuery('execute', params.connectionId, params.query, params.database, pool, ipc),
  );
}
