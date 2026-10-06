import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '../ipc-client.js';
import { makeError, toErrorMessage, RESULT_SIZE_CAP, type ToolResult } from './mcp-result.js';

// db_read / db_execute 共用的结果形状说明
export const RESULT_SHAPE = [
  'SQL results are columnar: {"columns":["id","name"],"rows":[[1,"a"],[2,"b"]],"rowCount":2,...}; each row lists values in column order.',
  'Repeated column names (e.g. u.id, o.id in a JOIN) stay separate: later ones are renamed "<table alias>.<name>" (PostgreSQL: "<name> (2)").',
  'Binary values come back as {"binary":"<hex of the first 64 bytes>","length":<bytes>}.',
  `Every result is capped at ${RESULT_SIZE_CAP} characters of JSON: past that, trailing rows are dropped and the result has truncated: true, sizeCapChars, rowsReturned (a top-level list becomes {truncated, total, items}; other shapes become {truncated, partialJson}).`,
].join('\n');

const DB_READ_DESCRIPTION = [
  'Execute read-only queries (SQL runs in a read-only transaction; results capped at 500 rows; SQL and MongoDB reads time out after 30s on the server). Use db_schema to discover databases/tables/columns. Query format by database type:',
  '- MySQL/PostgreSQL: one SELECT/SHOW/DESCRIBE/EXPLAIN/WITH statement, e.g. "SELECT * FROM users LIMIT 10" (no INTO)',
  '- Redis: command string, e.g. "GET key1", "HGETALL myhash"',
  '- MongoDB: JSON, e.g. {"collection":"users","method":"find","filter":{},"sort":{"_id":-1},"skip":0,"limit":20} (find also takes projection; aggregate takes pipeline, limit; countDocuments takes filter; unknown fields are rejected). filter and pipeline accept EJSON: {"$oid":"..."}, {"$date":"2024-01-01T00:00:00Z"}, {"$numberLong":"..."}. Documents come back as relaxed EJSON (ObjectId as $oid, Date as $date; integers beyond 2^53 as $numberLong)',
  '- Kafka: JSON, e.g. {"action":"listTopics"}, {"action":"fetch","topic":"t1","partition":0,"offset":"0","limit":10}',
  '- RabbitMQ: JSON, e.g. {"action":"listQueues"}, {"action":"peek","queue":"q1","count":10}',
  'The read-only check on the query text is best-effort; the real boundary is the read-only transaction and the database account\'s permissions.',
  RESULT_SHAPE,
  'When the 500-row cap cut a SQL result (the LIMIT was added or lowered and 500 rows came back), it also has truncated: true, rowCap: 500.',
].join('\n');

// 只读 / 上限校验与执行都在 VS Code 扩展里 (routeByDriver), 本进程只转发
export async function forwardQuery(
  ipc: IpcClient,
  mode: 'read' | 'execute',
  params: { connectionId: string; query: string; database?: string },
): Promise<ToolResult> {
  try {
    return await ipc.request(mode, params) as ToolResult;
  } catch (err) {
    return makeError(toErrorMessage(err), 'QUERY_FAILED');
  }
}

export function registerReadTools(server: McpServer, ipc: IpcClient): void {
  server.registerTool(
    'db_read',
    {
      title: 'Read Query',
      description: DB_READ_DESCRIPTION,
      inputSchema: {
        connectionId: z.string().describe('Connection ID from db_list_connections (connects automatically on first use)'),
        query: z.string().describe('Query string (format depends on database type)'),
        database: z.string().optional().describe('MySQL: schema to USE (defaults to the connection\'s database; required if the connection has none; use information_schema for server-level statements). PostgreSQL: database to run in (defaults to the connection\'s database; only the public schema). MongoDB: required unless the connection has a default. Redis: db index 0-15 (default: connection\'s db).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => forwardQuery(ipc, 'read', params),
  );
}
