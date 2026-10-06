import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '../ipc-client.js';
import { makeResult, makeError, toErrorMessage } from './mcp-result.js';

// 转给 VS Code 扩展的同名 IPC 方法
async function ipcSchema(ipc: IpcClient, id: string, database?: string, table?: string): Promise<unknown> {
  if (!database) { return ipc.request('listDatabases', { connectionId: id }); }
  if (!table) { return ipc.request('listTables', { connectionId: id, database }); }
  const [columns, ddl] = await Promise.all([
    ipc.request('listColumns', { connectionId: id, database, table }),
    ipc.request('getTableDDL', { connectionId: id, database, table }),
  ]);
  return { columns, ddl };
}

export function registerSchemaTools(server: McpServer, ipc: IpcClient): void {
  server.registerTool(
    'db_schema',
    {
      title: 'Browse Schema',
      description: [
        'Browse schema of a connection:',
        '- omit database: list databases (Redis: db indexes 0-15)',
        '- database only: list tables (MongoDB: collections, Kafka: topics, RabbitMQ: queues)',
        '- database + table: columns and CREATE TABLE DDL (MySQL/PostgreSQL/MongoDB)',
      ].join('\n'),
      inputSchema: {
        connectionId: z.string().describe('Connection ID from db_list_connections (connects automatically on first use)'),
        database: z.string().optional().describe('Database name'),
        table: z.string().optional().describe('Table / collection name (requires database)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connectionId, database, table }) => {
      try {
        return makeResult(await ipcSchema(ipc, connectionId, database, table));
      } catch (err) {
        return makeError(toErrorMessage(err), 'QUERY_FAILED');
      }
    },
  );
}
