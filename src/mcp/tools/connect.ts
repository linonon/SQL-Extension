import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';

const DRIVER_TYPES = ['mysql', 'postgresql', 'redis', 'mongodb', 'kafka', 'rabbitmq'] as const;

export function registerConnectTools(server: McpServer, pool: ConnectionPool): void {
  server.tool(
    'db_connect',
    'Connect to a database. Returns a connectionId for subsequent operations.',
    {
      driverType: z.enum(DRIVER_TYPES).describe('Database type'),
      host: z.string().describe('Database host'),
      port: z.number().int().positive().describe('Database port'),
      username: z.string().optional().describe('Username'),
      password: z.string().optional().describe('Password'),
      database: z.string().optional().describe('Database name'),
      ssh: z.object({
        enabled: z.boolean(),
        host: z.string(),
        port: z.number().int().positive(),
        username: z.string(),
        authType: z.enum(['password', 'privateKey']),
        password: z.string().optional(),
        privateKeyPath: z.string().optional(),
      }).optional().describe('SSH tunnel configuration'),
    },
    async (params) => {
      try {
        const connectionId = await pool.connect({
          driverType: params.driverType,
          host: params.host,
          port: params.port,
          username: params.username,
          password: params.password,
          database: params.database,
          ssh: params.ssh ? { ...params.ssh, enabled: params.ssh.enabled } : undefined,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ connectionId, driverType: params.driverType, database: params.database ?? '' }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              code: 'CONNECT_FAILED',
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'db_disconnect',
    'Disconnect from a database.',
    {
      connectionId: z.string().describe('Connection ID from db_connect'),
    },
    async (params) => {
      try {
        await pool.disconnect(params.connectionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, connectionId: params.connectionId }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              code: 'DISCONNECT_FAILED',
              connectionId: params.connectionId,
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'db_list_connections',
    'List all active connections. Returns connectionId, driverType, and database for each. Does NOT return host, port, username, or password.',
    {},
    async () => {
      const connections = pool.listConnections();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ connections }),
        }],
      };
    }
  );
}
