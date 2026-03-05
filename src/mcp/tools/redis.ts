import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { makeResult, makeError, toErrorMessage } from './mcp-result.js';

// 只读命令白名单
export const ALLOWED_COMMANDS = new Set([
  'GET', 'MGET', 'TTL', 'PTTL', 'TYPE', 'EXISTS', 'DBSIZE', 'INFO',
  'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN',
  'HGET', 'HGETALL', 'HMGET', 'HLEN',
  'LRANGE', 'LLEN',
  'SCARD', 'SMEMBERS', 'SISMEMBER',
  'ZCARD', 'ZRANGE', 'ZRANGEBYSCORE', 'ZCOUNT',
  'STRLEN',
]);

const SCAN_COMMANDS = new Set(['SCAN', 'HSCAN', 'SSCAN', 'ZSCAN']);
const MAX_SCAN_COUNT = 1000;

/**
 * SCAN 系命令的 COUNT 参数上限 1000.
 * args 格式: SCAN cursor [MATCH pattern] [COUNT count]
 * 找到 COUNT 关键字后, 将其后的数值限制到 MAX_SCAN_COUNT.
 */
export function capScanCount(args: readonly string[]): string[] {
  if (args.length === 0) { return [...args]; }
  const cmd = args[0].toUpperCase();
  if (!SCAN_COMMANDS.has(cmd)) { return [...args]; }

  const result = [...args];
  for (let i = 1; i < result.length - 1; i++) {
    if (result[i].toUpperCase() === 'COUNT') {
      const count = parseInt(result[i + 1], 10);
      if (!isNaN(count) && count > MAX_SCAN_COUNT) {
        result[i + 1] = String(MAX_SCAN_COUNT);
      }
      break;
    }
  }
  return result;
}

export function registerRedisTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.tool(
    'redis_command',
    'Execute a read-only Redis command. Only whitelisted read commands are allowed (GET, MGET, SCAN, HGETALL, LRANGE, etc). Write commands (SET, DEL, FLUSHDB, etc) are rejected.',
    {
      connectionId: z.string().describe('Redis connection ID'),
      db: z.number().int().min(0).max(15).default(0).describe('Redis database index (0-15)'),
      args: z.array(z.string()).min(1).describe('Command and arguments, e.g. ["GET", "mykey"]'),
    },
    async (params) => {
      try {
        const cmd = params.args[0].toUpperCase();
        if (!ALLOWED_COMMANDS.has(cmd)) {
          return makeError(
            `Command "${cmd}" is not allowed. Only read-only commands are permitted: ${[...ALLOWED_COMMANDS].join(', ')}`,
            'COMMAND_NOT_ALLOWED',
          );
        }

        const safeArgs = capScanCount(params.args);

        let result: unknown;

        // IPC mode: 非 pool 连接
        if (!params.connectionId.startsWith('conn_') && ipc.connected) {
          result = await ipc.request('redisCommand', {
            connectionId: params.connectionId,
            db: params.db,
            args: safeArgs,
          });
        } else {
          // Standalone mode: pool 连接
          const driver = pool.getRedisDriver(params.connectionId);
          await driver.selectDatabase(params.db);
          result = await driver.executeCommand(safeArgs);
        }

        return makeResult(result);
      } catch (err) {
        return makeError(toErrorMessage(err), 'REDIS_COMMAND_FAILED');
      }
    }
  );
}
