import type { ConnectionPool } from './connection-pool.js';
import type { IpcClient } from './ipc-client.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { IRedisDriver } from '../types/redis-driver.js';
import type { IKafkaDriver } from '../types/kafka-driver.js';
import type { IRabbitMQDriver } from '../types/rabbitmq-driver.js';
import type { MongoDriver } from '../drivers/mongo-driver.js';
import { ErrorCode } from './utils.js';
import { isReadonlySQL, enforceLimit, isMultiStatement } from './sql-validator.js';
import { parseRedisCommand } from './parsers/redis-parser.js';
import { parseMongoQuery, READ_METHODS } from './parsers/mongo-parser.js';
import { parseKafkaQuery, READ_ACTIONS } from './parsers/kafka-parser.js';
import { parseRabbitMQQuery } from './parsers/rabbitmq-parser.js';
import { makeResult, makeError, toErrorMessage } from './tools/mcp-result.js';
import type { QueryResultData } from './tools/types.js';

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

// 0 / 负数 / 非整数都会让驱动取消上限, 一律回落到 MAX_LIMIT
const capLimit = (n: unknown): number =>
  Number.isInteger(n) && (n as number) > 0 ? Math.min(n as number, MAX_LIMIT) : MAX_LIMIT;

export type RouteMode = 'read' | 'execute';
export type ToolResult = ReturnType<typeof makeResult> | ReturnType<typeof makeError>;

// 取 driver 的来源: MCP 进程内的 standalone pool, 或 VS Code 扩展里的 ConnectionManager
export interface DriverSource {
  getDriver(id: string): IDatabaseDriver;
  getRedisDriver(id: string): IRedisDriver;
  getMongoDriver(id: string): MongoDriver;
  getKafkaDriver(id: string): IKafkaDriver;
  getRabbitMQDriver(id: string): IRabbitMQDriver;
}

// standalone 连接在本进程执行; 其余 id 视为 VS Code 已保存连接, 整条转给扩展,
// 扩展侧同样经 routeByDriver 执行, 两条路径共用全部只读 / 上限校验.
export async function routeQuery(
  mode: RouteMode,
  connectionId: string,
  query: string,
  database: string | undefined,
  pool: ConnectionPool,
  ipc: IpcClient,
): Promise<ToolResult> {
  try {
    if (pool.has(connectionId)) {
      const entry = pool.getEntry(connectionId);
      return await routeByDriver(mode, entry.driverType, connectionId, query, database || entry.database || undefined, pool);
    }
    return await ipc.request(mode, { connectionId, query, database }) as ToolResult;
  } catch (err) {
    return makeError(toErrorMessage(err), ErrorCode.QUERY_FAILED);
  }
}

/** database 为调用方显式值, 缺省时应已回落到连接配置的默认库. */
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

  // MySQL 池连接会残留 UI 编辑器的 USE, 不带库执行落在哪个 schema 不确定 (读写同理)
  const isMysql = driverType === 'mysql';
  if (isMysql && !database) {
    return makeError(
      'database is required for MySQL (the connection has no default). Pass any existing schema, e.g. information_schema, for server-level statements.',
      ErrorCode.MISSING_DATABASE,
    );
  }

  const driver = drivers.getDriver(connectionId);
  if (mode === 'read' && !driver.executeReadOnly) {
    return makeError(`Driver '${driverType}' has no read-only execution.`, ErrorCode.UNSUPPORTED_COMMAND);
  }
  let result: QueryResultData;
  if (mode === 'read') {
    result = await driver.executeReadOnly!(query, isMysql ? database : undefined) as QueryResultData;
  } else if (isMysql) {
    const { promise } = driver.executeCancellable(query, undefined, database);
    result = await promise as QueryResultData;
  } else {
    result = await driver.execute(query) as QueryResultData;
  }

  return makeResult({
    columns: result.columns?.map(c => ({ name: c.name, dataType: c.dataType })) ?? [],
    rows: result.rows,
    rowCount: result.rows.length,
    affectedRows: result.affectedRows,
    executionTime: result.executionTime,
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

  const result = await driver.dispatchToCollection(
    database, params.collection, params.method, args,
    safeLimit ? { limit: safeLimit } : undefined,
  );

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
