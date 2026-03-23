import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from './connection-pool.js';
import type { IpcClient } from './ipc-client.js';
import { isPoolConnection } from './utils.js';

export function registerResources(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  // databases
  server.registerResource(
    'database-list',
    new ResourceTemplate('sqlext://{connectionId}/databases', {
      list: async () => {
        const connections = pool.listConnections();
        return {
          resources: connections.map(c => ({
            uri: `sqlext://${c.id}/databases`,
            name: `Databases (${c.id})`,
          })),
        };
      },
    }),
    { title: 'Database List', description: 'List all databases for a connection', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = variables['connectionId'] as string;
      let result: unknown;
      if (isPoolConnection(id)) {
        const entry = pool.getEntry(id);
        if (entry.driverType === 'redis') {
          result = Array.from({ length: 16 }, (_, i) => ({ name: String(i) }));
        } else if (entry.driverType === 'kafka' || entry.driverType === 'rabbitmq') {
          result = { error: 'N/A for this database type' };
        } else {
          const driver = pool.getDriver(id);
          result = await driver.listDatabases();
        }
      } else if (ipc.connected) {
        result = await ipc.request('listDatabases', { connectionId: id });
      } else {
        result = { error: 'Connection not found' };
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(result), mimeType: 'application/json' }] };
    },
  );

  // tables
  server.registerResource(
    'table-list',
    new ResourceTemplate('sqlext://{connectionId}/{database}/tables', {
      list: undefined,
    }),
    { title: 'Table List', description: 'List tables/collections for a database', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = variables['connectionId'] as string;
      const db = variables['database'] as string;
      let result: unknown;
      if (isPoolConnection(id)) {
        const entry = pool.getEntry(id);
        if (entry.driverType === 'kafka') {
          result = await pool.getKafkaDriver(id).listTopics();
        } else if (entry.driverType === 'rabbitmq') {
          result = await pool.getRabbitMQDriver(id).listQueues();
        } else if (entry.driverType === 'redis') {
          result = { error: 'N/A for Redis' };
        } else {
          result = await pool.getDriver(id).listTables(db);
        }
      } else if (ipc.connected) {
        result = await ipc.request('listTables', { connectionId: id, database: db });
      } else {
        result = { error: 'Connection not found' };
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(result), mimeType: 'application/json' }] };
    },
  );

  // columns
  server.registerResource(
    'column-list',
    new ResourceTemplate('sqlext://{connectionId}/{database}/{table}/columns', {
      list: undefined,
    }),
    { title: 'Column List', description: 'List columns/fields for a table', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = variables['connectionId'] as string;
      const db = variables['database'] as string;
      const tbl = variables['table'] as string;
      let result: unknown;
      if (isPoolConnection(id)) {
        result = await pool.getDriver(id).listColumns(db, tbl);
      } else if (ipc.connected) {
        result = await ipc.request('listColumns', { connectionId: id, database: db, table: tbl });
      } else {
        result = { error: 'Connection not found' };
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(result), mimeType: 'application/json' }] };
    },
  );

  // DDL
  server.registerResource(
    'table-ddl',
    new ResourceTemplate('sqlext://{connectionId}/{database}/{table}/ddl', {
      list: undefined,
    }),
    { title: 'Table DDL', description: 'Get CREATE TABLE DDL', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = variables['connectionId'] as string;
      const db = variables['database'] as string;
      const tbl = variables['table'] as string;
      let result: unknown;
      if (isPoolConnection(id)) {
        result = await pool.getDriver(id).getTableDDL(db, tbl);
      } else if (ipc.connected) {
        result = await ipc.request('getTableDDL', { connectionId: id, database: db, table: tbl });
      } else {
        result = { error: 'Connection not found' };
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(result), mimeType: 'application/json' }] };
    },
  );
}
