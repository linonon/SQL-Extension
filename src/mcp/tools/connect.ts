import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { makeResult, makeError, toErrorMessage } from './mcp-result.js';
import { isPoolConnection } from '../utils.js';

const DRIVER_TYPES = ['mysql', 'postgresql', 'redis', 'mongodb', 'kafka', 'rabbitmq'] as const;

export function registerConnectTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.registerTool(
    'db_connect',
    {
      title: 'Connect to Database',
      description: [
        'Connect to a database. Two modes:',
        '1. IPC mode (VS Code running): provide only connectionId to connect a saved connection.',
        '2. Standalone mode: provide driverType, host, port, etc. for a new connection.',
      ].join(' '),
      inputSchema: {
        // IPC mode: 只需 connectionId
        connectionId: z.string().optional().describe('Saved connection ID (from db_list_connections). Use this when VS Code is running.'),
        // Standalone mode: 完整参数
        driverType: z.enum(DRIVER_TYPES).optional().describe('Database type (standalone mode)'),
        host: z.string().optional().describe('Database host (standalone mode)'),
        port: z.number().int().positive().optional().describe('Database port (standalone mode)'),
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
        }).optional().describe('SSH tunnel configuration (standalone mode)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        // IPC mode: 用 connectionId 连接保存的连接
        if (params.connectionId) {
          if (!ipc.connected) {
            return makeError('VS Code extension is not running. Cannot connect saved connections.', 'IPC_NOT_AVAILABLE');
          }
          await ipc.request('connect', { connectionId: params.connectionId });
          return makeResult({ connectionId: params.connectionId, mode: 'ipc' });
        }

        // Standalone mode: 需要完整参数
        if (!params.driverType || !params.host || !params.port) {
          return makeError(
            'Provide connectionId (IPC mode) or driverType+host+port (standalone mode).',
            'INVALID_PARAMS',
          );
        }

        const connectionId = await pool.connect({
          driverType: params.driverType,
          host: params.host,
          port: params.port,
          username: params.username,
          password: params.password,
          database: params.database,
          ssh: params.ssh ? { ...params.ssh, enabled: params.ssh.enabled } : undefined,
        });
        return makeResult({
          connectionId,
          driverType: params.driverType,
          database: params.database ?? '',
          mode: 'standalone',
        });
      } catch (err) {
        return makeError(toErrorMessage(err), 'CONNECT_FAILED');
      }
    }
  );

  server.registerTool(
    'db_disconnect',
    {
      title: 'Disconnect from Database',
      description: 'Disconnect from a database.',
      inputSchema: {
        connectionId: z.string().describe('Connection ID'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        // 尝试 standalone pool 先 (pool 的 id 以 conn_ 开头)
        if (isPoolConnection(params.connectionId)) {
          await pool.disconnect(params.connectionId);
        } else if (ipc.connected) {
          await ipc.request('disconnect', { connectionId: params.connectionId });
        } else {
          return makeError('Connection not found and VS Code is not running.', 'NOT_FOUND');
        }
        return makeResult({ success: true, connectionId: params.connectionId });
      } catch (err) {
        return makeError(toErrorMessage(err), 'DISCONNECT_FAILED');
      }
    }
  );

  server.registerTool(
    'db_list_connections',
    {
      title: 'List Database Connections',
      description: 'List all available connections. When VS Code is running, shows saved connections with their state. Otherwise shows only active standalone connections.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const result: unknown[] = [];

      // IPC mode: 返回扩展中保存的连接 (懒连接: 即使启动时 VS Code 没开, 现在也会尝试)
      try {
        const saved = await ipc.request('listConnections') as unknown[];
        result.push(...saved);
      } catch {
        // IPC 不可用, 跳过
      }

      // Standalone mode: 返回 pool 中的活跃连接
      const poolConns = pool.listConnections().map(c => ({
        ...c,
        mode: 'standalone' as const,
        state: 'connected' as const,
      }));
      result.push(...poolConns);

      return makeResult({ connections: result });
    }
  );

  server.registerTool(
    'db_save_connection',
    {
      title: 'Save Connection',
      description: 'Save a database connection configuration to VS Code extension. Requires VS Code to be running. The saved connection will appear in the extension sidebar.',
      inputSchema: {
        name: z.string().describe('Display name for the connection'),
        driverType: z.enum(DRIVER_TYPES).describe('Database type'),
        host: z.string().describe('Database host (the actual target host, not the SSH jump host)'),
        port: z.number().int().positive().describe('Database port'),
        username: z.string().optional().describe('Username'),
        password: z.string().optional().describe('Password'),
        database: z.string().optional().describe('Default database name'),
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      try {
        if (!ipc.connected) {
          return makeError('VS Code extension is not running. Cannot save connections.', 'IPC_NOT_AVAILABLE');
        }
        const id = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const config: Record<string, unknown> = {
          id,
          name: params.name,
          driverType: params.driverType,
          host: params.host,
          port: params.port,
          username: params.username ?? '',
          database: params.database ?? '',
        };
        if (params.ssh) {
          config.ssh = {
            enabled: params.ssh.enabled,
            host: params.ssh.host,
            port: params.ssh.port,
            username: params.ssh.username,
            authType: params.ssh.authType,
            privateKeyPath: params.ssh.privateKeyPath,
          };
        }
        const result = await ipc.request('saveConnection', {
          config,
          password: params.password ?? '',
          sshPassword: params.ssh?.password,
        });
        return makeResult(result);
      } catch (err) {
        return makeError(toErrorMessage(err), 'SAVE_FAILED');
      }
    }
  );
}
