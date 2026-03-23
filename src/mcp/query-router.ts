import type { ConnectionPool } from './connection-pool.js';
import type { IpcClient } from './ipc-client.js';
import { isPoolConnection, ErrorCode } from './utils.js';
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

export type RouteMode = 'read' | 'execute';

export async function routeQuery(
  mode: RouteMode,
  connectionId: string,
  query: string,
  database: string | undefined,
  pool: ConnectionPool,
  ipc: IpcClient,
) {
  try {
    let driverType: string;
    if (isPoolConnection(connectionId)) {
      driverType = pool.getEntry(connectionId).driverType;
    } else if (ipc.connected) {
      const result = await ipc.request(mode, { connectionId, query, database });
      return makeResult(result);
    } else {
      return makeError(
        `Connection '${connectionId}' not found. Use db_list_connections to see available connections.`,
        ErrorCode.CONNECTION_NOT_FOUND,
      );
    }

    switch (driverType) {
      case 'mysql':
      case 'postgresql':
        return await routeSQL(mode, connectionId, query, database, pool);
      case 'redis':
        return await routeRedis(mode, connectionId, query, database, pool);
      case 'mongodb':
        return await routeMongo(mode, connectionId, query, database, pool);
      case 'kafka':
        return await routeKafka(mode, connectionId, query, pool);
      case 'rabbitmq':
        return await routeRabbitMQ(mode, connectionId, query, pool);
      default:
        return makeError(`Unsupported driver type: ${driverType}`, ErrorCode.UNSUPPORTED_COMMAND);
    }
  } catch (err) {
    return makeError(toErrorMessage(err), ErrorCode.QUERY_FAILED);
  }
}

async function routeSQL(
  mode: RouteMode, connectionId: string, query: string,
  database: string | undefined, pool: ConnectionPool,
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
    query = enforceLimit(query);
  }

  const driver = pool.getDriver(connectionId);
  const entry = pool.getEntry(connectionId);
  let result: QueryResultData;
  if (database && entry.driverType === 'mysql') {
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
  database: string | undefined, pool: ConnectionPool,
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

  const driver = pool.getRedisDriver(connectionId);
  if (database !== undefined) {
    const dbIndex = parseInt(database, 10);
    if (isNaN(dbIndex) || dbIndex < 0 || dbIndex > 15) {
      return makeError(
        `Redis database must be 0-15, got '${database}'.`,
        ErrorCode.INVALID_DATABASE,
      );
    }
    await driver.selectDatabase(dbIndex);
  }

  const result = await driver.executeCommand(safeArgs);
  return makeResult(result);
}

async function routeMongo(
  mode: RouteMode, connectionId: string, query: string,
  database: string | undefined, pool: ConnectionPool,
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

  const driver = pool.getMongoDriver(connectionId);
  const limit = mode === 'read' ? (params.limit ?? MAX_LIMIT) : undefined;
  const safeLimit = limit ? Math.min(limit, MAX_LIMIT) : undefined;

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
  mode: RouteMode, connectionId: string, query: string, pool: ConnectionPool,
) {
  const params = parseKafkaQuery(query);
  const readSet = new Set(READ_ACTIONS as readonly string[]);

  if (mode === 'read' && !readSet.has(params.action)) {
    return makeError(
      `Action '${params.action}' not allowed in db_read. Use db_execute for write operations.`,
      ErrorCode.READONLY_VIOLATION,
    );
  }

  const driver = pool.getKafkaDriver(connectionId);

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
      const limit = Math.min(params.limit ?? MAX_LIMIT, MAX_LIMIT);
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
  mode: RouteMode, connectionId: string, query: string, pool: ConnectionPool,
) {
  if (mode === 'execute') {
    return makeError(
      'RabbitMQ does not support write operations yet.',
      ErrorCode.UNSUPPORTED_COMMAND,
    );
  }

  const params = parseRabbitMQQuery(query);
  const driver = pool.getRabbitMQDriver(connectionId);

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
