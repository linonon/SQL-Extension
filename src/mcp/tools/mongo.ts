import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';

const ALLOWED_METHODS = new Set(['find', 'aggregate', 'countDocuments']);
const FORBIDDEN_STAGES = new Set(['$out', '$merge']);

/**
 * 校验 aggregate pipeline, 禁止 $out / $merge stage.
 */
export function validatePipeline(pipeline: readonly Record<string, unknown>[]): void {
  for (const stage of pipeline) {
    for (const key of Object.keys(stage)) {
      if (FORBIDDEN_STAGES.has(key)) {
        throw new Error(`Aggregate stage "${key}" is not allowed. Only read-only stages are permitted.`);
      }
    }
  }
}

/**
 * 构造 mongo shell 语法字符串, 供 MongoDriver.executeCancellable 解析.
 */
export function buildMongoShellQuery(
  collection: string,
  method: string,
  filter?: Record<string, unknown>,
  pipeline?: readonly Record<string, unknown>[],
  projection?: Record<string, number>,
  limit?: number,
): string {
  switch (method) {
    case 'find': {
      const filterStr = JSON.stringify(filter ?? {});
      const opts = projection ? `, {"projection": ${JSON.stringify(projection)}}` : '';
      // parseMongoQuery 会解析出 find(filter, opts), dispatchMethod 会 .limit(1000)
      // 但我们需要限制更小, 所以在 filter 中无法控制 limit -- dispatchMethod 硬编码 1000
      // 这里只能依赖 dispatchMethod 的 limit(1000), 取回后再截断
      return `db.${collection}.find(${filterStr}${opts})`;
    }
    case 'aggregate': {
      return `db.${collection}.aggregate(${JSON.stringify(pipeline ?? [])})`;
    }
    case 'countDocuments': {
      return `db.${collection}.countDocuments(${JSON.stringify(filter ?? {})})`;
    }
    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

export function registerMongoTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.tool(
    'mongo_query',
    'Execute a read-only MongoDB query. Supports find, aggregate, and countDocuments methods. Aggregate pipelines with $out/$merge are rejected. Results limited to 500 documents.',
    {
      connectionId: z.string().describe('MongoDB connection ID'),
      database: z.string().describe('Database name'),
      collection: z.string().describe('Collection name'),
      method: z.enum(['find', 'aggregate', 'countDocuments']).default('find').describe('Query method'),
      filter: z.record(z.unknown()).optional().describe('Query filter for find/countDocuments'),
      pipeline: z.array(z.record(z.unknown())).optional().describe('Aggregation pipeline stages'),
      projection: z.record(z.number()).optional().describe('Field projection for find (1=include, 0=exclude)'),
      limit: z.number().int().min(1).max(500).default(20).describe('Max documents to return (1-500)'),
    },
    async (params) => {
      try {
        if (!ALLOWED_METHODS.has(params.method)) {
          return makeError(
            `Method "${params.method}" is not allowed. Only find, aggregate, countDocuments are permitted.`,
            'METHOD_NOT_ALLOWED',
          );
        }

        if (params.method === 'aggregate' && params.pipeline) {
          try {
            validatePipeline(params.pipeline);
          } catch (err) {
            return makeError(
              err instanceof Error ? err.message : String(err),
              'PIPELINE_VALIDATION_FAILED',
            );
          }
        }

        const query = buildMongoShellQuery(
          params.collection,
          params.method,
          params.filter,
          params.pipeline,
          params.projection,
          params.limit,
        );

        let result: QueryResultData;

        // IPC mode: 非 pool 连接
        if (!params.connectionId.startsWith('conn_') && ipc.connected) {
          result = await ipc.request('mongoQuery', {
            connectionId: params.connectionId,
            database: params.database,
            query,
          }) as QueryResultData;
        } else {
          // Standalone mode: pool 连接
          const driver = pool.getDriver(params.connectionId);
          const { promise } = driver.executeCancellable(query, undefined, params.database);
          result = await promise as QueryResultData;
        }

        // 截断到 limit
        const rows = result.rows.slice(0, params.limit);

        return makeResult({
          columns: result.columns?.map(c => ({ name: c.name, dataType: c.dataType })) ?? [],
          rows,
          rowCount: rows.length,
          executionTime: result.executionTime,
        });
      } catch (err) {
        return makeError(err instanceof Error ? err.message : String(err), 'MONGO_QUERY_FAILED');
      }
    }
  );
}

interface QueryResultData {
  readonly columns: ReadonlyArray<{ name: string; dataType: string }>;
  readonly rows: readonly Record<string, unknown>[];
  readonly affectedRows: number;
  readonly executionTime: number;
}

function makeResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function makeError(message: string, code: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}
