# MCP 工具重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 6 个 MCP 工具重构为 5 个 (db_connect, db_disconnect, db_list_connections, db_read, db_execute), 统一查询入口, 读写分离, 覆盖全部 6 种 DB 类型, 新增 MCP Resources 元数据.

**Architecture:** 拆除按 DB 类型分离的工具 (redis.ts, mongo.ts), 统一成 query-router 按 driverType 内部路由. Parsers 层负责将各类 query 字符串解析为结构化调用. MCP Resources 通过 ResourceTemplate 暴露 schema 元数据.

**Tech Stack:** TypeScript, MCP SDK v1.27+ (registerTool/registerResource), Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-03-23-mcp-refactor-design.md`

---

### Task 1: 公共工具函数 + 错误码

**Files:**
- Create: `src/mcp/utils.ts`
- Test: `src/mcp/utils.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// src/mcp/utils.test.ts
import { describe, it, expect } from 'vitest';
import { isPoolConnection } from './utils.js';

describe('isPoolConnection', () => {
  it('should return true for pool connection IDs', () => {
    expect(isPoolConnection('conn_1_1234567890')).toBe(true);
    expect(isPoolConnection('conn_99_1234567890')).toBe(true);
  });
  it('should return false for IPC connection IDs', () => {
    expect(isPoolConnection('abc-def-123')).toBe(false);
    expect(isPoolConnection('')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/mcp/utils.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: 实现**

```typescript
// src/mcp/utils.ts
export function isPoolConnection(id: string): boolean {
  return id.startsWith('conn_');
}

// 统一错误码
export const ErrorCode = {
  CONNECTION_NOT_FOUND: 'CONNECTION_NOT_FOUND',
  NOT_CONNECTED: 'NOT_CONNECTED',
  PARSE_FAILED: 'PARSE_FAILED',
  UNSUPPORTED_COMMAND: 'UNSUPPORTED_COMMAND',
  MISSING_DATABASE: 'MISSING_DATABASE',
  INVALID_METHOD: 'INVALID_METHOD',
  QUERY_FAILED: 'QUERY_FAILED',
  INVALID_DATABASE: 'INVALID_DATABASE',
  DANGEROUS_OPERATION: 'DANGEROUS_OPERATION',
  MULTI_STATEMENT: 'MULTI_STATEMENT',
  READONLY_VIOLATION: 'READONLY_VIOLATION',
} as const;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/mcp/utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/utils.ts src/mcp/utils.test.ts
git commit -m "feat(mcp): add isPoolConnection utility and error codes"
```

---

### Task 2: Redis parser

**Files:**
- Create: `src/mcp/parsers/redis-parser.ts`
- Test: `src/mcp/parsers/redis-parser.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// src/mcp/parsers/redis-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseRedisCommand } from './redis-parser.js';

describe('parseRedisCommand', () => {
  it('should parse simple command', () => {
    expect(parseRedisCommand('GET user:1')).toEqual(['GET', 'user:1']);
  });
  it('should parse multi-arg command', () => {
    expect(parseRedisCommand('SET key val EX 60')).toEqual(['SET', 'key', 'val', 'EX', '60']);
  });
  it('should handle quoted values with spaces', () => {
    expect(parseRedisCommand('SET key "hello world"')).toEqual(['SET', 'key', 'hello world']);
  });
  it('should handle single-quoted values', () => {
    expect(parseRedisCommand("SET key 'hello world'")).toEqual(['SET', 'key', 'hello world']);
  });
  it('should parse single-word command', () => {
    expect(parseRedisCommand('FLUSHDB')).toEqual(['FLUSHDB']);
  });
  it('should trim whitespace', () => {
    expect(parseRedisCommand('  GET  key  ')).toEqual(['GET', 'key']);
  });
  it('should throw on empty input', () => {
    expect(() => parseRedisCommand('')).toThrow();
    expect(() => parseRedisCommand('   ')).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/mcp/parsers/redis-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/mcp/parsers/redis-parser.ts

export function parseRedisCommand(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('Empty Redis command.');
  }

  const args: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    // 跳过空格
    while (i < trimmed.length && trimmed[i] === ' ') { i++; }
    if (i >= trimmed.length) { break; }

    // 引号包裹
    if (trimmed[i] === '"' || trimmed[i] === "'") {
      const quote = trimmed[i];
      i++;
      let val = '';
      while (i < trimmed.length && trimmed[i] !== quote) {
        val += trimmed[i];
        i++;
      }
      i++; // 跳过结束引号
      args.push(val);
    } else {
      // 普通 token
      let val = '';
      while (i < trimmed.length && trimmed[i] !== ' ') {
        val += trimmed[i];
        i++;
      }
      args.push(val);
    }
  }
  return args;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/mcp/parsers/redis-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/parsers/redis-parser.ts src/mcp/parsers/redis-parser.test.ts
git commit -m "feat(mcp): add Redis command string parser"
```

---

### Task 3: MongoDB parser

**Files:**
- Create: `src/mcp/parsers/mongo-parser.ts`
- Test: `src/mcp/parsers/mongo-parser.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// src/mcp/parsers/mongo-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseMongoQuery, READ_METHODS, WRITE_METHODS } from './mongo-parser.js';

describe('parseMongoQuery', () => {
  it('should parse find query', () => {
    const result = parseMongoQuery('{"collection":"users","method":"find","filter":{"age":{"$gt":20}}}');
    expect(result.collection).toBe('users');
    expect(result.method).toBe('find');
    expect(result.filter).toEqual({ age: { $gt: 20 } });
  });

  it('should parse aggregate query', () => {
    const result = parseMongoQuery('{"collection":"users","method":"aggregate","pipeline":[]}');
    expect(result.method).toBe('aggregate');
    expect(result.pipeline).toEqual([]);
  });

  it('should parse insertOne', () => {
    const result = parseMongoQuery('{"collection":"users","method":"insertOne","document":{"name":"foo"}}');
    expect(result.method).toBe('insertOne');
    expect(result.document).toEqual({ name: 'foo' });
  });

  it('should throw on missing collection', () => {
    expect(() => parseMongoQuery('{"method":"find"}')).toThrow('collection');
  });

  it('should throw on missing method', () => {
    expect(() => parseMongoQuery('{"collection":"users"}')).toThrow('method');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseMongoQuery('not json')).toThrow();
  });

  it('should throw on unknown method', () => {
    expect(() => parseMongoQuery('{"collection":"users","method":"drop"}')).toThrow();
  });
});

describe('method lists', () => {
  it('READ_METHODS should contain read methods', () => {
    expect(READ_METHODS).toContain('find');
    expect(READ_METHODS).toContain('aggregate');
    expect(READ_METHODS).toContain('countDocuments');
  });
  it('WRITE_METHODS should contain write methods', () => {
    expect(WRITE_METHODS).toContain('insertOne');
    expect(WRITE_METHODS).toContain('deleteMany');
    expect(WRITE_METHODS).toContain('createIndex');
    expect(WRITE_METHODS).toContain('dropIndex');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/mcp/parsers/mongo-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/mcp/parsers/mongo-parser.ts

export const READ_METHODS = ['find', 'aggregate', 'countDocuments'] as const;
export const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'aggregate', 'createIndex', 'dropIndex',
] as const;

const ALL_METHODS = new Set([...READ_METHODS, ...WRITE_METHODS]);

export interface MongoQueryParams {
  collection: string;
  method: string;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  projection?: Record<string, number>;
  limit?: number;
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  update?: Record<string, unknown>;
  keys?: Record<string, number>;
  options?: Record<string, unknown>;
  indexName?: string;
}

export function parseMongoQuery(query: string): MongoQueryParams {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error(
      `Invalid JSON in query. Expected format: {"collection":"...","method":"find","filter":{}}`,
    );
  }

  const collection = parsed.collection as string | undefined;
  const method = parsed.method as string | undefined;

  if (!collection || typeof collection !== 'string') {
    throw new Error('Missing required field: collection');
  }
  if (!method || typeof method !== 'string') {
    throw new Error('Missing required field: method');
  }
  if (!ALL_METHODS.has(method)) {
    throw new Error(
      `Unknown method '${method}'. Allowed: ${[...ALL_METHODS].join(', ')}`,
    );
  }

  return {
    collection,
    method,
    filter: parsed.filter as Record<string, unknown> | undefined,
    pipeline: parsed.pipeline as Record<string, unknown>[] | undefined,
    projection: parsed.projection as Record<string, number> | undefined,
    limit: parsed.limit as number | undefined,
    document: parsed.document as Record<string, unknown> | undefined,
    documents: parsed.documents as Record<string, unknown>[] | undefined,
    update: parsed.update as Record<string, unknown> | undefined,
    keys: parsed.keys as Record<string, number> | undefined,
    options: parsed.options as Record<string, unknown> | undefined,
    indexName: parsed.indexName as string | undefined,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/mcp/parsers/mongo-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/parsers/mongo-parser.ts src/mcp/parsers/mongo-parser.test.ts
git commit -m "feat(mcp): add MongoDB JSON query parser"
```

---

### Task 4: Kafka parser

**Files:**
- Create: `src/mcp/parsers/kafka-parser.ts`
- Test: `src/mcp/parsers/kafka-parser.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// src/mcp/parsers/kafka-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseKafkaQuery, READ_ACTIONS, WRITE_ACTIONS } from './kafka-parser.js';

describe('parseKafkaQuery', () => {
  it('should parse listTopics', () => {
    const r = parseKafkaQuery('{"action":"listTopics"}');
    expect(r.action).toBe('listTopics');
  });
  it('should parse describeTopic', () => {
    const r = parseKafkaQuery('{"action":"describeTopic","topic":"my-topic"}');
    expect(r.action).toBe('describeTopic');
    expect(r.topic).toBe('my-topic');
  });
  it('should parse fetch', () => {
    const r = parseKafkaQuery('{"action":"fetch","topic":"t1","partition":0,"offset":"0","limit":10}');
    expect(r.action).toBe('fetch');
    expect(r.topic).toBe('t1');
    expect(r.partition).toBe(0);
    expect(r.offset).toBe('0');
    expect(r.limit).toBe(10);
  });
  it('should parse produce', () => {
    const r = parseKafkaQuery('{"action":"produce","topic":"t1","key":"k","value":"v"}');
    expect(r.action).toBe('produce');
  });
  it('should throw on invalid JSON', () => {
    expect(() => parseKafkaQuery('not json')).toThrow();
  });
  it('should throw on unknown action', () => {
    expect(() => parseKafkaQuery('{"action":"delete"}')).toThrow();
  });
  it('should throw on missing action', () => {
    expect(() => parseKafkaQuery('{"topic":"t1"}')).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/mcp/parsers/kafka-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/mcp/parsers/kafka-parser.ts

export const READ_ACTIONS = ['listTopics', 'describeTopic', 'fetch'] as const;
export const WRITE_ACTIONS = ['produce'] as const;

const ALL_ACTIONS = new Set([...READ_ACTIONS, ...WRITE_ACTIONS]);

export interface KafkaQueryParams {
  action: string;
  topic?: string;
  partition?: number;
  offset?: string;
  limit?: number;
  key?: string;
  value?: string;
  headers?: Record<string, string>;
}

export function parseKafkaQuery(query: string): KafkaQueryParams {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error(
      'Invalid JSON in query. Expected format: {"action":"listTopics"}',
    );
  }

  const action = parsed.action as string | undefined;
  if (!action || typeof action !== 'string') {
    throw new Error('Missing required field: action');
  }
  if (!ALL_ACTIONS.has(action)) {
    throw new Error(
      `Unknown action '${action}'. Allowed: ${[...ALL_ACTIONS].join(', ')}`,
    );
  }

  return {
    action,
    topic: parsed.topic as string | undefined,
    partition: parsed.partition as number | undefined,
    offset: parsed.offset as string | undefined,
    limit: parsed.limit as number | undefined,
    key: parsed.key as string | undefined,
    value: parsed.value as string | undefined,
    headers: (parsed.headers as Record<string, string> | undefined) ?? undefined,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/mcp/parsers/kafka-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/parsers/kafka-parser.ts src/mcp/parsers/kafka-parser.test.ts
git commit -m "feat(mcp): add Kafka JSON query parser"
```

---

### Task 5: RabbitMQ parser

**Files:**
- Create: `src/mcp/parsers/rabbitmq-parser.ts`
- Test: `src/mcp/parsers/rabbitmq-parser.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// src/mcp/parsers/rabbitmq-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseRabbitMQQuery, READ_ACTIONS } from './rabbitmq-parser.js';

describe('parseRabbitMQQuery', () => {
  it('should parse listQueues', () => {
    const r = parseRabbitMQQuery('{"action":"listQueues"}');
    expect(r.action).toBe('listQueues');
  });
  it('should parse peek with count', () => {
    const r = parseRabbitMQQuery('{"action":"peek","queue":"my-queue","count":10}');
    expect(r.action).toBe('peek');
    expect(r.queue).toBe('my-queue');
    expect(r.count).toBe(10);
  });
  it('should default peek count to 10', () => {
    const r = parseRabbitMQQuery('{"action":"peek","queue":"q1"}');
    expect(r.count).toBe(10);
  });
  it('should cap peek count at 50', () => {
    const r = parseRabbitMQQuery('{"action":"peek","queue":"q1","count":999}');
    expect(r.count).toBe(50);
  });
  it('should throw on unknown action', () => {
    expect(() => parseRabbitMQQuery('{"action":"publish"}')).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/mcp/parsers/rabbitmq-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// src/mcp/parsers/rabbitmq-parser.ts

export const READ_ACTIONS = ['listQueues', 'peek'] as const;

const ALL_ACTIONS = new Set<string>([...READ_ACTIONS]);
const MAX_PEEK_COUNT = 50;
const DEFAULT_PEEK_COUNT = 10;

export interface RabbitMQQueryParams {
  action: string;
  queue?: string;
  count?: number;
}

export function parseRabbitMQQuery(query: string): RabbitMQQueryParams {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error(
      'Invalid JSON in query. Expected format: {"action":"listQueues"}',
    );
  }

  const action = parsed.action as string | undefined;
  if (!action || typeof action !== 'string') {
    throw new Error('Missing required field: action');
  }
  if (!ALL_ACTIONS.has(action)) {
    throw new Error(
      `Unknown action '${action}'. Allowed: ${[...ALL_ACTIONS].join(', ')}`,
    );
  }

  let count: number | undefined;
  if (action === 'peek') {
    const raw = (parsed.count as number | undefined) ?? DEFAULT_PEEK_COUNT;
    count = Math.min(raw, MAX_PEEK_COUNT);
  }

  return {
    action,
    queue: parsed.queue as string | undefined,
    count,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/mcp/parsers/rabbitmq-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/parsers/rabbitmq-parser.ts src/mcp/parsers/rabbitmq-parser.test.ts
git commit -m "feat(mcp): add RabbitMQ JSON query parser"
```

---

### Task 6: 提取 isMultiStatement

将多语句检测从 `isReadonlySQL` 中提取为独立函数, 供 query-router 的 read 和 execute 模式共用.

**Files:**
- Modify: `src/mcp/sql-validator.ts`
- Modify: `src/mcp/sql-validator.test.ts`

- [ ] **Step 1: 新增 `isMultiStatement` 函数**

在 `src/mcp/sql-validator.ts` 中新增:

```typescript
export function isMultiStatement(sql: string): boolean {
  const noStrings = sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  const semiIdx = noStrings.indexOf(';');
  return semiIdx >= 0 && noStrings.slice(semiIdx + 1).trim().length > 0;
}
```

并更新 `isReadonlySQL` 使用它:

```typescript
export function isReadonlySQL(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  if (!ALLOWED_PREFIXES.some(p => trimmed.startsWith(p))) { return false; }
  if (trimmed.startsWith('SELECT') && trimmed.includes(' INTO ')) { return false; }
  if (isMultiStatement(sql)) { return false; }
  return true;
}
```

- [ ] **Step 2: 补充测试**

在 `src/mcp/sql-validator.test.ts` 中添加 `isMultiStatement` 的测试:

```typescript
describe('isMultiStatement', () => {
  it('should return false for single statement', () => {
    expect(isMultiStatement('SELECT 1')).toBe(false);
  });
  it('should return false for trailing semicolon', () => {
    expect(isMultiStatement('SELECT 1;')).toBe(false);
  });
  it('should return true for multiple statements', () => {
    expect(isMultiStatement('SELECT 1; DROP TABLE users')).toBe(true);
  });
  it('should ignore semicolons in strings', () => {
    expect(isMultiStatement("SELECT * FROM t WHERE name = 'a;b'")).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/mcp/sql-validator.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/sql-validator.ts src/mcp/sql-validator.test.ts
git commit -m "refactor(mcp): extract isMultiStatement from sql-validator"
```

---

### Task 7: MongoDriver.dispatchMethod 重构

将 module-level `dispatchMethod` 提升为 MongoDriver public 方法, 参数化 limit, 新增 createIndex/dropIndex case.

**Files:**
- Modify: `src/drivers/mongo-driver.ts:213-271` (dispatchMethod 函数) 和 `:100-135` (executeCancellable 调用处)

- [ ] **Step 1: 将 `dispatchMethod` 从 module function 移入 `MongoDriver` 类**

把 `src/drivers/mongo-driver.ts:213-271` 的 `async function dispatchMethod(coll, method, args)` 改为 `MongoDriver` 类的 public 方法:

```typescript
// 新签名 (在 MongoDriver 类内部)
async dispatchToCollection(
  database: string,
  collection: string,
  method: string,
  args: readonly unknown[],
  options?: { limit?: number },
): Promise<DispatchResult> {
  this.assertConnected();
  const coll = this.client!.db(database).collection(collection);
  // ... 原有 switch 逻辑 ...
}
```

- [ ] **Step 2: 修改 find case -- limit 参数化**

```typescript
case 'find': {
  const filter = autoConvertIds(convertEjsonToBson(args[0] ?? {}) as Record<string, unknown>);
  const opts = (args[1] ?? {}) as Record<string, unknown>;
  const limit = options?.limit ?? 1000;
  const docs = await coll.find(filter, { projection: opts.projection }).limit(limit).toArray();
  return { docs };
}
```

- [ ] **Step 3: 修改 aggregate case -- 加 limit 截断**

```typescript
case 'aggregate': {
  const pipeline = convertEjsonToBson(args[0] ?? []) as unknown[];
  let docs = await coll.aggregate(pipeline).toArray();
  if (options?.limit && docs.length > options.limit) {
    docs = docs.slice(0, options.limit);
  }
  return { docs };
}
```

- [ ] **Step 4: 新增 createIndex 和 dropIndex case**

```typescript
case 'createIndex': {
  const keys = args[0] as Record<string, number>;
  const indexOptions = (args[1] ?? {}) as Record<string, unknown>;
  const indexName = await coll.createIndex(keys, indexOptions);
  return { affectedRows: 1, docs: [{ indexName }] } as unknown as DispatchResult;
}
case 'dropIndex': {
  const indexName = args[0] as string;
  await coll.dropIndex(indexName);
  return { affectedRows: 1 };
}
```

- [ ] **Step 5: 更新 executeCancellable 调用**

`src/drivers/mongo-driver.ts:114` 将 `dispatchMethod(coll, cmd.method, cmd.args)` 改为 `this.dispatchToCollection(dbName, cmd.collection, cmd.method, cmd.args)`.

删除旧的 `const coll = this.client!.db(dbName).collection(cmd.collection);` (line 111), 因为 `dispatchToCollection` 内部会处理.

- [ ] **Step 6: 删除原 module-level dispatchMethod 函数**

删除 `src/drivers/mongo-driver.ts:213-271` 的独立函数, 已经移入类中.

- [ ] **Step 7: 运行全量测试确认不回归**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/drivers/mongo-driver.ts
git commit -m "refactor(mongo): promote dispatchMethod to MongoDriver public method"
```

---

### Task 8: ConnectionPool.getMongoDriver

**Files:**
- Modify: `src/mcp/connection-pool.ts:127-157` (在 getDriver 后面新增)

- [ ] **Step 1: 新增 getMongoDriver 方法**

在 `src/mcp/connection-pool.ts` 的 `getDriver` 方法之后 (line 133), 新增:

```typescript
getMongoDriver(id: string): MongoDriver {
  const entry = this.getEntry(id);
  if (entry.driverType !== 'mongodb') {
    throw new Error(`Connection ${id} is not MongoDB`);
  }
  return entry.driver as MongoDriver;
}
```

需要在文件顶部 import `MongoDriver`:

```typescript
import { MongoDriver } from '../drivers/mongo-driver.js';
```

注意: `MongoDriver` 已经在 line 4 import 了, 但作为 `new MongoDriver()` 使用. 检查是否需要额外 type import.

- [ ] **Step 2: 运行测试确认不回归**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/mcp/connection-pool.ts
git commit -m "feat(mcp): add ConnectionPool.getMongoDriver method"
```

---

### Task 9: 查询路由器 query-router

核心路由逻辑, db_read 和 db_execute 共享.

**Files:**
- Create: `src/mcp/query-router.ts`
- Ref: `src/mcp/parsers/redis-parser.ts`, `src/mcp/parsers/mongo-parser.ts`, `src/mcp/parsers/kafka-parser.ts`, `src/mcp/parsers/rabbitmq-parser.ts`
- Ref: `src/mcp/sql-validator.ts` (isReadonlySQL, enforceLimit, 多语句检测)
- Ref: `src/mcp/tools/redis.ts` (ALLOWED_COMMANDS, capScanCount -- 需要从这里拿逻辑)
- Ref: `src/mcp/tools/mongo.ts` (validatePipeline -- 需要从这里拿逻辑)
- Ref: `src/mcp/utils.ts` (isPoolConnection, ErrorCode)

- [ ] **Step 1: 创建 query-router.ts**

这个文件负责:
1. 通过 connectionId 获取 driverType (pool 模式从 entry, IPC 模式需要先查)
2. 根据 driverType + mode 路由到对应 parser + driver 调用
3. 返回统一的 MCP result

```typescript
// src/mcp/query-router.ts
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

// Redis 只读命令白名单 (从 redis.ts 迁移)
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

// MongoDB $out/$merge 检测
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
    // 获取 driverType
    let driverType: string;
    if (isPoolConnection(connectionId)) {
      driverType = pool.getEntry(connectionId).driverType;
    } else if (ipc.connected) {
      // IPC 模式: 需要先拿连接列表确定 driverType
      // 将 driverType 判断委托给 IPC server, 直接发 read/execute 请求
      const result = await ipc.request(mode, { connectionId, query, database });
      return makeResult(result);
    } else {
      return makeError(
        `Connection '${connectionId}' not found. Use db_list_connections to see available connections.`,
        ErrorCode.CONNECTION_NOT_FOUND,
      );
    }

    // Standalone mode: 按 driverType 路由
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
  // 多语句检测 (read + execute 都检)
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

  // SCAN COUNT 上限
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

  // Redis database 参数 (0-15)
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

  // method 权限检查
  const readSet = new Set(READ_METHODS as readonly string[]);
  if (mode === 'read') {
    if (!readSet.has(params.method)) {
      return makeError(
        `Method '${params.method}' not allowed in db_read. Use db_execute for write operations.`,
        ErrorCode.INVALID_METHOD,
      );
    }
    // aggregate 禁止 $out/$merge
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
    // execute mode
    // 空 filter 防护
    if (
      (params.method === 'deleteMany' || params.method === 'updateMany') &&
      params.filter && Object.keys(params.filter).length === 0
    ) {
      return makeError(
        'Empty filter on bulk operation is dangerous. Use {"_all": true} in filter to confirm.',
        ErrorCode.DANGEROUS_OPERATION,
      );
    }
    // _all: true 转换
    if (params.filter && '_all' in params.filter && params.filter._all === true) {
      params.filter = {};
    }
  }

  const driver = pool.getMongoDriver(connectionId);
  const limit = mode === 'read' ? (params.limit ?? MAX_LIMIT) : undefined;
  const safeLimit = limit ? Math.min(limit, MAX_LIMIT) : undefined;

  // 构造 dispatchToCollection 的 args
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
```

- [ ] **Step 2: 运行编译确认无类型错误**

Run: `npx tsc --noEmit`
Expected: 无错误 (或只有与本文件无关的已有错误)

- [ ] **Step 3: Commit**

```bash
git add src/mcp/query-router.ts
git commit -m "feat(mcp): add unified query router with read/execute mode"
```

---

### Task 10: db_read 工具注册

重构 `src/mcp/tools/query.ts`, 从 `db_query` 改为 `db_read`, 使用 `registerTool` API, 委托给 query-router.

**Files:**
- Modify: `src/mcp/tools/query.ts` (全部重写)

- [ ] **Step 1: 重写 query.ts**

```typescript
// src/mcp/tools/query.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { routeQuery } from '../query-router.js';

const DB_READ_DESCRIPTION = [
  'Execute read-only queries. Query format by database type:',
  '- MySQL/PostgreSQL: SQL string, e.g. "SELECT * FROM users LIMIT 10"',
  '- Redis: command string, e.g. "GET key1", "HGETALL myhash"',
  '- MongoDB: JSON, e.g. {"collection":"users","method":"find","filter":{}}',
  '- Kafka: JSON, e.g. {"action":"listTopics"}, {"action":"fetch","topic":"t1","partition":0,"offset":"0","limit":10}',
  '- RabbitMQ: JSON, e.g. {"action":"listQueues"}, {"action":"peek","queue":"q1","count":10}',
  'The database parameter is optional for MySQL (schema context), required for MongoDB, and for Redis it selects db index (0-15).',
].join('\n');

export function registerReadTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.registerTool(
    'db_read',
    {
      title: 'Read Query',
      description: DB_READ_DESCRIPTION,
      inputSchema: {
        connectionId: z.string().describe('Connection ID'),
        query: z.string().describe('Query string (format depends on database type)'),
        database: z.string().optional().describe('Database/schema name (MySQL context, MongoDB required, Redis db index 0-15)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => routeQuery('read', params.connectionId, params.query, params.database, pool, ipc),
  );
}
```

- [ ] **Step 2: 运行编译检查**

Run: `npx tsc --noEmit`
Expected: 类型检查通过 (server.ts 会报错因为还在调用旧的 registerQueryTools, 稍后处理)

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/query.ts
git commit -m "refactor(mcp): rewrite query.ts as db_read tool with registerTool API"
```

---

### Task 11: db_execute 工具注册

**Files:**
- Create: `src/mcp/tools/execute.ts`

- [ ] **Step 1: 创建 execute.ts**

```typescript
// src/mcp/tools/execute.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectionPool } from '../connection-pool.js';
import type { IpcClient } from '../ipc-client.js';
import { routeQuery } from '../query-router.js';

const DB_EXECUTE_DESCRIPTION = [
  'Execute write operations and DDL. Query format by database type:',
  '- MySQL/PostgreSQL: SQL string, e.g. "INSERT INTO users (name) VALUES (\'foo\')", "DROP TABLE ..."',
  '- Redis: command string, e.g. "SET key val EX 60", "DEL key1", "FLUSHDB"',
  '- MongoDB: JSON, e.g. {"collection":"users","method":"insertOne","document":{"name":"foo"}}',
  '- Kafka: JSON, e.g. {"action":"produce","topic":"t1","key":"k","value":"v"}',
  '- RabbitMQ: not supported yet',
  'The database parameter is optional for MySQL (schema context), required for MongoDB, and for Redis it selects db index (0-15).',
].join('\n');

export function registerExecuteTools(server: McpServer, pool: ConnectionPool, ipc: IpcClient): void {
  server.registerTool(
    'db_execute',
    {
      title: 'Execute Query',
      description: DB_EXECUTE_DESCRIPTION,
      inputSchema: {
        connectionId: z.string().describe('Connection ID'),
        query: z.string().describe('Query string (format depends on database type)'),
        database: z.string().optional().describe('Database/schema name (MySQL context, MongoDB required, Redis db index 0-15)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => routeQuery('execute', params.connectionId, params.query, params.database, pool, ipc),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/tools/execute.ts
git commit -m "feat(mcp): add db_execute tool with registerTool API"
```

---

### Task 12: connect.ts 迁移到 registerTool API

**Files:**
- Modify: `src/mcp/tools/connect.ts`

- [ ] **Step 1: 替换所有 `server.tool(...)` 为 `server.registerTool(...)`**

对 `db_connect`, `db_disconnect`, `db_list_connections` 三个工具:
- 用 `server.registerTool(name, { title, description, inputSchema, annotations }, handler)` 替换 `server.tool(name, description, schema, handler)`
- 添加 Tool Annotations (见 spec 工具总览表)
- 替换 `params.connectionId.startsWith('conn_')` 为 `isPoolConnection(params.connectionId)`

注意: 保持 inputSchema 使用 flat optional fields, 不要用 `z.discriminatedUnion()`.

- [ ] **Step 2: 运行编译检查**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/connect.ts
git commit -m "refactor(mcp): migrate connect tools to registerTool API with annotations"
```

---

### Task 13: 更新 server.ts -- 组装新工具

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: 更新 imports 和注册调用**

```typescript
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionPool } from './connection-pool.js';
import { IpcClient } from './ipc-client.js';
import { registerConnectTools } from './tools/connect.js';
import { registerReadTools } from './tools/query.js';
import { registerExecuteTools } from './tools/execute.js';

const pool = new ConnectionPool();
const ipc = new IpcClient();

const server = new McpServer({
  name: 'sql-extension',
  version: '0.2.0',  // 版本号升级, breaking change
});

registerConnectTools(server, pool, ipc);
registerReadTools(server, pool, ipc);
registerExecuteTools(server, pool, ipc);

// ... 其余 cleanup/main 代码不变 ...
```

- [ ] **Step 2: 删除旧的 redis.ts 和 mongo.ts import**

移除:
```typescript
import { registerRedisTools } from './tools/redis.js';
import { registerMongoTools } from './tools/mongo.js';
```
和对应的:
```typescript
registerRedisTools(server, pool, ipc);
registerMongoTools(server, pool, ipc);
```

- [ ] **Step 3: 运行编译确认通过**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: 运行全量测试**

Run: `npx vitest run`
Expected: 旧的 redis.test.ts 和 mongo.test.ts 会失败 (import 路径问题), 这在 Task 14 处理

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor(mcp): update server to use db_read/db_execute, remove redis/mongo tools"
```

---

### Task 14: IPC 协议更新

**Files:**
- Modify: `src/services/ipc-server.ts:74-131`

- [ ] **Step 1: 新增 read/execute case, 删除 redisCommand/mongoQuery**

替换 `src/services/ipc-server.ts` 的 `dispatch` 方法中的 `query`/`redisCommand`/`mongoQuery` case:

```typescript
case 'read':
case 'execute': {
  const id = params.connectionId as string;
  const query = params.query as string;
  const database = params.database as string | undefined;
  // 查找 driverType
  const config = this.connectionManager.getConnections().find(c => c.id === id);
  if (!config) { throw new Error(`Connection not found: ${id}`); }
  const driverType = config.driverType;

  switch (driverType) {
    case 'mysql':
    case 'postgresql': {
      const driver = this.connectionManager.getDriver(id);
      if (database) {
        const { promise } = driver.executeCancellable(query, undefined, database);
        return await promise;
      }
      return await driver.execute(query);
    }
    case 'redis': {
      const { parseRedisCommand } = await import('../mcp/parsers/redis-parser.js');
      const args = parseRedisCommand(query);
      const driver = this.connectionManager.getRedisDriver(id);
      if (database !== undefined) {
        const dbIndex = parseInt(database, 10);
        if (!isNaN(dbIndex) && dbIndex >= 0 && dbIndex <= 15) {
          await driver.selectDatabase(dbIndex);
        }
      }
      return await driver.executeCommand(args);
    }
    case 'mongodb': {
      // MCP 传 JSON 格式 query, 需要用 mongo-parser 解析, 不能用 mongo shell parser
      const { parseMongoQuery } = await import('../mcp/parsers/mongo-parser.js');
      const parsed = parseMongoQuery(query);
      const driver = this.connectionManager.getDriver(id);
      // 构造 args (与 dispatchToCollection 的位置参数格式一致)
      const mArgs: unknown[] = [];
      switch (parsed.method) {
        case 'find': mArgs.push(parsed.filter ?? {}, { projection: parsed.projection }); break;
        case 'aggregate': mArgs.push(parsed.pipeline ?? []); break;
        case 'countDocuments': mArgs.push(parsed.filter ?? {}); break;
        case 'insertOne': mArgs.push(parsed.document ?? {}); break;
        case 'insertMany': mArgs.push(parsed.documents ?? []); break;
        case 'updateOne': case 'updateMany': mArgs.push(parsed.filter ?? {}, parsed.update ?? {}); break;
        case 'deleteOne': case 'deleteMany': mArgs.push(parsed.filter ?? {}); break;
        case 'createIndex': mArgs.push(parsed.keys ?? {}, parsed.options ?? {}); break;
        case 'dropIndex': mArgs.push(parsed.indexName ?? ''); break;
      }
      // MongoDriver 已经提升了 dispatchToCollection 为 public 方法
      const mongoDriver = driver as unknown as { dispatchToCollection: Function };
      return await mongoDriver.dispatchToCollection(database ?? 'test', parsed.collection, parsed.method, mArgs, parsed.limit ? { limit: parsed.limit } : undefined);
    }
    case 'kafka': {
      const { parseKafkaQuery } = await import('../mcp/parsers/kafka-parser.js');
      const params = parseKafkaQuery(query);
      const driver = this.connectionManager.getKafkaDriver(id);
      switch (params.action) {
        case 'listTopics': return await driver.listTopics();
        case 'describeTopic': return await driver.getTopicPartitions(params.topic!);
        case 'fetch': return await driver.fetchMessages(params.topic!, params.partition ?? 0, params.offset ?? '0', params.limit ?? 500);
        case 'produce': return await driver.produceMessage(params.topic!, params.key ?? null, params.value ?? '', params.headers ?? {}, params.partition);
        default: throw new Error(`Unknown Kafka action: ${params.action}`);
      }
    }
    case 'rabbitmq': {
      if (method === 'execute') { throw new Error('RabbitMQ does not support write operations yet.'); }
      const { parseRabbitMQQuery } = await import('../mcp/parsers/rabbitmq-parser.js');
      const params = parseRabbitMQQuery(query);
      const driver = this.connectionManager.getRabbitMQDriver(id);
      switch (params.action) {
        case 'listQueues': return await driver.listQueues();
        case 'peek': return await driver.peekMessages(params.queue!, params.count ?? 10);
        default: throw new Error(`Unknown RabbitMQ action: ${params.action}`);
      }
    }
    default:
      throw new Error(`Unsupported driver type: ${driverType}`);
  }
}
```

- [ ] **Step 2: 新增元数据 IPC case (供 Resources 使用)**

```typescript
case 'listDatabases': {
  const id = params.connectionId as string;
  const config = this.connectionManager.getConnections().find(c => c.id === id);
  if (!config) { throw new Error(`Connection not found: ${id}`); }
  if (config.driverType === 'redis') {
    return Array.from({ length: 16 }, (_, i) => ({ name: String(i) }));
  }
  if (config.driverType === 'kafka' || config.driverType === 'rabbitmq') {
    return { error: 'N/A for this database type' };
  }
  const driver = this.connectionManager.getDriver(id);
  return await driver.listDatabases();
}
case 'listTables': {
  const id = params.connectionId as string;
  const database = params.database as string;
  const config = this.connectionManager.getConnections().find(c => c.id === id);
  if (!config) { throw new Error(`Connection not found: ${id}`); }
  if (config.driverType === 'kafka') {
    return await this.connectionManager.getKafkaDriver(id).listTopics();
  }
  if (config.driverType === 'rabbitmq') {
    return await this.connectionManager.getRabbitMQDriver(id).listQueues();
  }
  if (config.driverType === 'redis') {
    return { error: 'N/A for Redis' };
  }
  const driver = this.connectionManager.getDriver(id);
  return await driver.listTables(database);
}
case 'listColumns': {
  const id = params.connectionId as string;
  const database = params.database as string;
  const table = params.table as string;
  const driver = this.connectionManager.getDriver(id);
  return await driver.listColumns(database, table);
}
case 'getTableDDL': {
  const id = params.connectionId as string;
  const database = params.database as string;
  const table = params.table as string;
  const driver = this.connectionManager.getDriver(id);
  return await driver.getTableDDL(database, table);
}
```

- [ ] **Step 3: 运行编译检查**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/services/ipc-server.ts
git commit -m "refactor(mcp): update IPC protocol for read/execute routing"
```

---

### Task 15: 清理旧文件 + 测试更新

**Files:**
- Delete: `src/mcp/tools/redis.ts`, `src/mcp/tools/mongo.ts`
- Delete: `src/mcp/tools/redis.test.ts`, `src/mcp/tools/mongo.test.ts`
- Modify: `src/mcp/tools/query.test.ts` (重写为 db_read 路由测试, 测试 parser 级别逻辑即可)

- [ ] **Step 1: 删除旧文件**

```bash
rm src/mcp/tools/redis.ts src/mcp/tools/mongo.ts
rm src/mcp/tools/redis.test.ts src/mcp/tools/mongo.test.ts
```

- [ ] **Step 2: 运行全量测试确认**

Run: `npx vitest run`
Expected: 旧测试文件已删, 新 parser 测试通过, sql-validator 测试通过

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(mcp): remove legacy redis/mongo tool files"
```

---

### Task 16: MCP Resources

**Files:**
- Create: `src/mcp/resources.ts`
- Modify: `src/mcp/server.ts` (添加 Resources 注册)

- [ ] **Step 1: 创建 resources.ts**

```typescript
// src/mcp/resources.ts
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
    async (uri, { connectionId }) => {
      const id = connectionId as string;
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
    async (uri, { connectionId, database }) => {
      const id = connectionId as string;
      const db = database as string;
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
    async (uri, { connectionId, database, table }) => {
      const id = connectionId as string;
      const db = database as string;
      const tbl = table as string;
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
    async (uri, { connectionId, database, table }) => {
      const id = connectionId as string;
      const db = database as string;
      const tbl = table as string;
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
```

- [ ] **Step 2: 在 server.ts 中注册 Resources**

在 `src/mcp/server.ts` 中添加:

```typescript
import { registerResources } from './resources.js';
// ... (在 registerExecuteTools 后面)
registerResources(server, pool, ipc);
```

- [ ] **Step 3: 运行编译确认**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/mcp/resources.ts src/mcp/server.ts
git commit -m "feat(mcp): add MCP Resources for database metadata"
```

---

### Task 17: 构建 + 全量验证

**Files:**
- N/A (验证步骤)

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 2: 构建 extension host**

Run: `npm run build`
Expected: `dist/extension.js` 和 `dist/mcp-server.js` 生成成功

- [ ] **Step 3: 验证 MCP server 启动**

Run: `node dist/mcp-server.js --help 2>&1 || true`
Expected: 不 crash, 打印启动信息或正常退出

- [ ] **Step 4: Commit (如有修复)**

```bash
git add -A
git commit -m "fix(mcp): fix build issues from refactor"
```

---

### Task 18: 最终集成测试 + 构建

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 2: 构建 webview + extension**

Run: `cd webview-ui && npm run build && cd .. && npm run build`
Expected: 构建成功

- [ ] **Step 3: 验证 MCP server**

Run: `echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' | node dist/mcp-server.js 2>/dev/null | head -1`
Expected: 返回 JSON-RPC response, 包含 tools 列表 (db_connect, db_disconnect, db_list_connections, db_read, db_execute)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(mcp): final build verification after refactor"
```
