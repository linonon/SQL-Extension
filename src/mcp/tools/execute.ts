import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '../ipc-client.js';
import { forwardQuery } from './query.js';

const DB_EXECUTE_DESCRIPTION = [
  'Execute write operations and DDL. SQL: one statement per call, each on its own autocommitted session; USE / SET / BEGIN do not carry over to the next call (multi-statement transactions are not supported). Query format by database type:',
  '- MySQL/PostgreSQL: SQL string, e.g. "INSERT INTO users (name) VALUES (\'foo\')", "DROP TABLE ..."',
  '- Redis: command string, e.g. "SET key val EX 60", "DEL key1", "FLUSHDB"',
  '- MongoDB: JSON, e.g. {"collection":"users","method":"insertOne","document":{"name":"foo"}} (filter / update / document accept EJSON such as {"$oid":"..."}, {"$date":"..."}, {"$numberLong":"..."})',
  '- Kafka: JSON, e.g. {"action":"produce","topic":"t1","key":"k","value":"v"}',
  '- RabbitMQ: not supported yet',
  'Destructive requests (SQL DROP / TRUNCATE / DELETE or UPDATE without WHERE, Redis FLUSHDB / FLUSHALL, MongoDB dropIndex or deleteMany / updateMany with {"_all": true}) wait for the user to approve them in VS Code; denied or unanswered within 60s, they fail with code NOT_CONFIRMED and nothing runs.',
].join('\n');

export function registerExecuteTools(server: McpServer, ipc: IpcClient): void {
  server.registerTool(
    'db_execute',
    {
      title: 'Execute Query',
      description: DB_EXECUTE_DESCRIPTION,
      inputSchema: {
        connectionId: z.string().describe('Connection ID from db_list_connections (connects automatically on first use)'),
        query: z.string().describe('Query string (format depends on database type)'),
        database: z.string().optional().describe('MySQL: schema to USE (defaults to the connection\'s database; required if the connection has none; use information_schema for server-level statements). PostgreSQL: database to run in (defaults to the connection\'s database; only the public schema). MongoDB: required unless the connection has a default. Redis: db index 0-15 (default: connection\'s db).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => forwardQuery(ipc, 'execute', params),
  );
}
