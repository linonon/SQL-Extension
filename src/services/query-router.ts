import type { IDatabaseDriver } from '../types/driver.js';
import type { IRedisDriver } from '../types/redis-driver.js';
import type { IKafkaDriver } from '../types/kafka-driver.js';
import type { IRabbitMQDriver } from '../types/rabbitmq-driver.js';
import type { QueryResult } from '../types/query.js';
import type { MongoDriver } from '../drivers/mongo-driver.js';
import { ErrorCode } from './utils.js';
import { isReadonlySQL, enforceLimit, isMultiStatement } from './sql-validator.js';
import { parseRedisCommand } from './parsers/redis-parser.js';
import { parseMongoQuery, READ_METHODS } from './parsers/mongo-parser.js';
import { parseKafkaQuery, READ_ACTIONS } from './parsers/kafka-parser.js';
import { parseRabbitMQQuery } from './parsers/rabbitmq-parser.js';
import { makeResult, makeError, type ToolResult } from '../mcp/tools/mcp-result.js';

const REDIS_READ_COMMANDS = new Set([
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
const MAX_LIMIT = 500;

const FORBIDDEN_STAGES = new Set(['$out', '$merge']);

// db_read 的服务端超时, 与 MySQL / PG driver.executeReadOnly 里设置的 30s 一致
const READ_TIMEOUT_MS = 30_000;

// 服务端超时错误换成可操作的提示, 其余错误原样抛出
function rethrowReadTimeout(err: unknown): never {
  const e = err as { errno?: number; code?: unknown; message?: string } | null;
  const timedOut = e?.errno === 3024 // MySQL ER_QUERY_TIMEOUT (max_execution_time)
    || (e?.code === '57014' && /statement timeout/i.test(e.message ?? '')) // PG statement_timeout (57014 也用于手动取消)
    || e?.code === 50; // MongoDB MaxTimeMSExpired
  if (timedOut) {
    throw new Error('Query exceeded the 30s read timeout. Narrow it (filter on an indexed column, smaller range or LIMIT) and retry.');
  }
  throw err;
}

// 0 / 负数 / 非整数都会让驱动取消上限, 一律回落到 MAX_LIMIT
const capLimit = (n: unknown): number =>
  Number.isInteger(n) && (n as number) > 0 ? Math.min(n as number, MAX_LIMIT) : MAX_LIMIT;

export type RouteMode = 'read' | 'execute';

// driver 来源, 由 IpcServer 用 ConnectionManager 适配
export interface DriverSource {
  getDriver(id: string): IDatabaseDriver;
  getRedisDriver(id: string): IRedisDriver;
  getMongoDriver(id: string): MongoDriver;
  getKafkaDriver(id: string): IKafkaDriver;
  getRabbitMQDriver(id: string): IRabbitMQDriver;
}

/**
 * MCP db_read / db_execute 经 IPC 到达扩展后的执行入口, 返回值是 MCP tool result, 由 MCP 进程原样转交 agent.
 * database 为调用方显式值, 缺省时应已回落到连接配置的默认库.
 */
export async function routeByDriver(
  mode: RouteMode,
  driverType: string,
  connectionId: string,
  query: string,
  database: string | undefined,
  drivers: DriverSource,
): Promise<ToolResult> {
  switch (driverType) {
    case 'mysql':
    case 'postgresql':
      return routeSQL(mode, driverType, connectionId, query, database, drivers);
    case 'redis':
      return routeRedis(mode, connectionId, query, database, drivers);
    case 'mongodb':
      return routeMongo(mode, connectionId, query, database, drivers);
    case 'kafka':
      return routeKafka(mode, connectionId, query, drivers);
    case 'rabbitmq':
      return routeRabbitMQ(mode, connectionId, query, drivers);
    default:
      return makeError(`Unsupported driver type: ${driverType}`, ErrorCode.UNSUPPORTED_COMMAND);
  }
}

async function routeSQL(
  mode: RouteMode, driverType: string, connectionId: string, query: string,
  database: string | undefined, drivers: DriverSource,
) {
  if (isMultiStatement(query)) {
    return makeError(
      'Multiple SQL statements not allowed. Send one statement at a time.',
      ErrorCode.MULTI_STATEMENT,
    );
  }

  if (mode === 'read') {
    if (!isReadonlySQL(query)) {
      return makeError(
        'db_read only accepts SELECT/SHOW/DESCRIBE/EXPLAIN. Use db_execute for write operations.',
        ErrorCode.READONLY_VIOLATION,
      );
    }
    query = enforceLimit(query, undefined, driverType === 'mysql');
  }

  // MySQL 连接可以不配默认库, 不带库时未限定的表名落不到任何 schema; PG 缺省走连接配置的库
  if (driverType === 'mysql' && !database) {
    return makeError(
      'database is required for MySQL (the connection has no default). Pass any existing schema, e.g. information_schema, for server-level statements.',
      ErrorCode.MISSING_DATABASE,
    );
  }

  const driver = drivers.getDriver(connectionId);
  if (mode === 'read' ? !driver.executeReadOnly : !driver.executeBatch) {
    return makeError(`Driver '${driverType}' cannot run this mode.`, ErrorCode.UNSUPPORTED_COMMAND);
  }
  let result: QueryResult;
  let warning: string | undefined;
  if (mode === 'read') {
    result = await driver.executeReadOnly!(query, database).catch(rethrowReadTimeout);
  } else {
    // 专用连接执行完即销毁: agent 的 USE / BEGIN / SET 不会留在 UI 共用的池里
    const outcome = await driver.executeBatch!([query], database).promise;
    if (outcome.error) { throw outcome.error.cause; }
    result = outcome.results[outcome.results.length - 1];
    warning = outcome.warning;
  }

  return makeResult({
    columns: result.columns?.map(c => ({ name: c.name, dataType: c.dataType })) ?? [],
    rows: result.rows,
    rowCount: result.rows.length,
    affectedRows: result.affectedRows,
    executionTime: result.executionTime,
    ...(warning ? { warning } : {}),
  });
}

async function routeRedis(
  mode: RouteMode, connectionId: string, query: string,
  database: string | undefined, drivers: DriverSource,
) {
  const args = parseRedisCommand(query);
  const cmd = args[0].toUpperCase();

  if (mode === 'read' && !REDIS_READ_COMMANDS.has(cmd)) {
    return makeError(
      `Command "${cmd}" not allowed in db_read. Use db_execute for write commands.`,
      ErrorCode.READONLY_VIOLATION,
    );
  }

  let safeArgs = args;
  if (SCAN_COMMANDS.has(cmd)) {
    safeArgs = [...args];
    for (let i = 1; i < safeArgs.length - 1; i++) {
      if (safeArgs[i].toUpperCase() === 'COUNT') {
        const count = parseInt(safeArgs[i + 1], 10);
        if (!isNaN(count) && count > MAX_SCAN_COUNT) {
          safeArgs[i + 1] = String(MAX_SCAN_COUNT);
        }
        break;
      }
    }
  }

  let dbIndex: number | undefined;
  if (database !== undefined) {
    dbIndex = Number(database);
    if (!Number.isInteger(dbIndex) || dbIndex < 0 || dbIndex > 15) {
      return makeError(
        `Redis database must be 0-15, got '${database}'.`,
        ErrorCode.INVALID_DATABASE,
      );
    }
  }

  // 独立连接执行: 不 SELECT 共享 client, 免得和 UI 浏览的库互相串
  const result = await drivers.getRedisDriver(connectionId).executeCommandInDb(dbIndex, safeArgs);
  return makeResult(result);
}

async function routeMongo(
  mode: RouteMode, connectionId: string, query: string,
  database: string | undefined, drivers: DriverSource,
) {
  if (!database) {
    return makeError(
      'database parameter is required for MongoDB. Specify the target database name.',
      ErrorCode.MISSING_DATABASE,
    );
  }

  const params = parseMongoQuery(query);

  const readSet = new Set(READ_METHODS as readonly string[]);
  if (mode === 'read') {
    if (!readSet.has(params.method)) {
      return makeError(
        `Method '${params.method}' not allowed in db_read. Use db_execute for write operations.`,
        ErrorCode.INVALID_METHOD,
      );
    }
    if (params.method === 'aggregate' && params.pipeline) {
      for (const stage of params.pipeline) {
        for (const key of Object.keys(stage)) {
          if (FORBIDDEN_STAGES.has(key)) {
            return makeError(
              `Aggregate stage "${key}" not allowed in db_read. Use db_execute for $out/$merge.`,
              ErrorCode.READONLY_VIOLATION,
            );
          }
        }
      }
    }
  } else {
    if (
      (params.method === 'deleteMany' || params.method === 'updateMany') &&
      params.filter && Object.keys(params.filter).length === 0
    ) {
      return makeError(
        'Empty filter on bulk operation is dangerous. Use {"_all": true} in filter to confirm.',
        ErrorCode.DANGEROUS_OPERATION,
      );
    }
    if (params.filter && '_all' in params.filter && params.filter._all === true) {
      params.filter = {};
    }
  }

  const driver = drivers.getMongoDriver(connectionId);
  const safeLimit = mode === 'read' ? capLimit(params.limit) : undefined;

  const args: unknown[] = [];
  switch (params.method) {
    case 'find':
      args.push(params.filter ?? {}, { projection: params.projection });
      break;
    case 'aggregate':
      args.push(params.pipeline ?? []);
      break;
    case 'countDocuments':
      args.push(params.filter ?? {});
      break;
    case 'insertOne':
      args.push(params.document ?? {});
      break;
    case 'insertMany':
      args.push(params.documents ?? []);
      break;
    case 'updateOne':
    case 'updateMany':
      args.push(params.filter ?? {}, params.update ?? {});
      break;
    case 'deleteOne':
    case 'deleteMany':
      args.push(params.filter ?? {});
      break;
    case 'createIndex':
      args.push(params.keys ?? {}, params.options ?? {});
      break;
    case 'dropIndex':
      args.push(params.indexName ?? '');
      break;
  }

  const result = mode === 'read'
    ? await driver.dispatchToCollection(
      database, params.collection, params.method, args, { limit: safeLimit, maxTimeMS: READ_TIMEOUT_MS },
    ).catch(rethrowReadTimeout)
    : await driver.dispatchToCollection(database, params.collection, params.method, args);

  if ('affectedRows' in result) {
    return makeResult({ affectedRows: result.affectedRows });
  }
  return makeResult({
    rows: result.docs,
    rowCount: result.docs.length,
  });
}

async function routeKafka(
  mode: RouteMode, connectionId: string, query: string, drivers: DriverSource,
) {
  const params = parseKafkaQuery(query);
  const readSet = new Set(READ_ACTIONS as readonly string[]);

  if (mode === 'read' && !readSet.has(params.action)) {
    return makeError(
      `Action '${params.action}' not allowed in db_read. Use db_execute for write operations.`,
      ErrorCode.READONLY_VIOLATION,
    );
  }

  const driver = drivers.getKafkaDriver(connectionId);

  switch (params.action) {
    case 'listTopics':
      return makeResult(await driver.listTopics());
    case 'describeTopic':
      if (!params.topic) {
        return makeError('Missing required field: topic', ErrorCode.PARSE_FAILED);
      }
      return makeResult(await driver.getTopicPartitions(params.topic));
    case 'fetch': {
      if (!params.topic) {
        return makeError('Missing required field: topic', ErrorCode.PARSE_FAILED);
      }
      const limit = capLimit(params.limit);
      const result = await driver.fetchMessages(
        params.topic, params.partition ?? 0, params.offset ?? '0', limit,
      );
      return makeResult(result);
    }
    case 'produce': {
      if (!params.topic || params.value === undefined) {
        return makeError('Missing required fields: topic, value', ErrorCode.PARSE_FAILED);
      }
      const result = await driver.produceMessage(
        params.topic, params.key ?? null, params.value, params.headers ?? {}, params.partition,
      );
      return makeResult(result);
    }
    default:
      return makeError(`Unknown action: ${params.action}`, ErrorCode.UNSUPPORTED_COMMAND);
  }
}

async function routeRabbitMQ(
  mode: RouteMode, connectionId: string, query: string, drivers: DriverSource,
) {
  if (mode === 'execute') {
    return makeError(
      'RabbitMQ does not support write operations yet.',
      ErrorCode.UNSUPPORTED_COMMAND,
    );
  }

  const params = parseRabbitMQQuery(query);
  const driver = drivers.getRabbitMQDriver(connectionId);

  switch (params.action) {
    case 'listQueues':
      return makeResult(await driver.listQueues());
    case 'peek': {
      if (!params.queue) {
        return makeError('Missing required field: queue', ErrorCode.PARSE_FAILED);
      }
      return makeResult(await driver.peekMessages(params.queue, params.count ?? 10));
    }
    default:
      return makeError(`Unknown action: ${params.action}`, ErrorCode.UNSUPPORTED_COMMAND);
  }
}
