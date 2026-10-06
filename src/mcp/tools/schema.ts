import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { makeResult, makeError, toErrorMessage } from './mcp-result.js';

// standalone 连接本进程查, 其余转给 VS Code (扩展侧同名 IPC 方法)
async function poolSchema(pool: ConnectionPool, id: string, database?: string, table?: string): Promise<unknown> {
  const { driverType } = pool.getEntry(id);
  if (!database) {
    if (driverType === 'redis') { return Array.from({ length: 16 }, (_, i) => ({ name: String(i) })); }
    if (driverType === 'kafka' || driverType === 'rabbitmq') { return { error: 'N/A for this database type' }; }
    return pool.getDriver(id).listDatabases();
  }
  if (!table) {
    if (driverType === 'kafka') { return pool.getKafkaDriver(id).listTopics(); }
    if (driverType === 'rabbitmq') { return pool.getRabbitMQDriver(id).listQueues(); }
    if (driverType === 'redis') { return { error: 'N/A for Redis' }; }
    return pool.getDriver(id).listTables(database);
  }
  const driver = pool.getDriver(id);
  return { columns: await driver.listColumns(database, table), ddl: await driver.getTableDDL(database, table) };
}

async function ipcSchema(ipc: IpcClient, id: string, database?: string, table?: string): Promise<unknown> {
  if (!database) { return ipc.request('listDatabases', { connectionId: id }); }
  if (!table) { return ipc.request('listTables', { connectionId: id, database }); }
  const [columns, ddl] = await Promise.all([
    ipc.request('listColumns', { connectionId: id, database, table }),
    ipc.request('getTableDDL', { connectionId: id, database, table }),
  ]);
  return { columns, ddl };
}

export function registerSchemaTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
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
        connectionId: z.string().describe('Connection ID (from db_list_connections)'),
        database: z.string().optional().describe('Database name'),
        table: z.string().optional().describe('Table / collection name (requires database)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connectionId, database, table }) => {
      try {
        const result = pool.has(connectionId)
          ? await poolSchema(pool, connectionId, database, table)
          : await ipcSchema(ipc, connectionId, database, table);
        return makeResult(result);
      } catch (err) {
        return makeError(toErrorMessage(err), 'QUERY_FAILED');
      }
    },
  );
}
