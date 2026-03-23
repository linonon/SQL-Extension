import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { routeQuery } from '../query-router.js';

const DB_READ_DESCRIPTION = [
  'Execute read-only queries. Query format by database type:',
  '- MySQL/PostgreSQL: SQL string, e.g. "SELECT * FROM users LIMIT 10"',
  '- Redis: command string, e.g. "GET key1", "HGETALL myhash"',
  '- MongoDB: JSON, e.g. {"collection":"users","method":"find","filter":{}}',
  '- Kafka: JSON, e.g. {"action":"listTopics"}, {"action":"fetch","topic":"t1","partition":0,"offset":"0","limit":10}',
  '- RabbitMQ: JSON, e.g. {"action":"listQueues"}, {"action":"peek","queue":"q1","count":10}',
  'The database parameter is optional for MySQL (schema context), required for MongoDB, and for Redis it selects db index (0-15).',
].join('\n');

export function registerReadTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.registerTool(
    'db_read',
    {
      title: 'Read Query',
      description: DB_READ_DESCRIPTION,
      inputSchema: {
        connectionId: z.string().describe('Connection ID'),
        query: z.string().describe('Query string (format depends on database type)'),
        database: z.string().optional().describe('Database/schema name (MySQL context, MongoDB required, Redis db index 0-15)'),
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
