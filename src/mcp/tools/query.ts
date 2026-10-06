import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { routeQuery } from '../query-router.js';

const DB_READ_DESCRIPTION = [
  'Execute read-only queries (SQL runs in a read-only transaction; results capped at 500 rows). Use db_schema to discover databases/tables/columns. Query format by database type:',
  '- MySQL/PostgreSQL: one SELECT/SHOW/DESCRIBE/EXPLAIN/WITH statement, e.g. "SELECT * FROM users LIMIT 10" (no INTO)',
  '- Redis: command string, e.g. "GET key1", "HGETALL myhash"',
  '- MongoDB: JSON, e.g. {"collection":"users","method":"find","filter":{}}',
  '- Kafka: JSON, e.g. {"action":"listTopics"}, {"action":"fetch","topic":"t1","partition":0,"offset":"0","limit":10}',
  '- RabbitMQ: JSON, e.g. {"action":"listQueues"}, {"action":"peek","queue":"q1","count":10}',
].join('\n');

export function registerReadTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.registerTool(
    'db_read',
    {
      title: 'Read Query',
      description: DB_READ_DESCRIPTION,
      inputSchema: {
        connectionId: z.string().describe('Connection ID from db_list_connections (saved VS Code connections connect on demand)'),
        query: z.string().describe('Query string (format depends on database type)'),
        database: z.string().optional().describe('MySQL: schema to USE (defaults to the connection\'s database; required if the connection has none; use information_schema for server-level statements). PostgreSQL: ignored, bound to the connection\'s database. MongoDB: required unless the connection has a default. Redis: db index 0-15 (default: connection\'s db).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => routeQuery('read', params.connectionId, params.query, params.database, pool, ipc),
  );
}
