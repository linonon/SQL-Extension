# MCP 工具重构设计

## 背景

当前 MCP 层暴露 6 个工具 (`db_connect`, `db_disconnect`, `db_list_connections`, `db_query`, `redis_command`, `mongo_query`), 存在以下问题:

1. 查询工具按 DB 类型拆分 (`db_query` / `redis_command` / `mongo_query`), AI 难以分辨该用哪个
2. 所有工具都是 read-only, 无法执行写操作
3. Kafka / RabbitMQ 没有暴露任何 MCP 工具
4. `listDatabases` / `listTables` / `listColumns` 等元数据查询未暴露
5. 没有使用 MCP Tool Annotations, 客户端无法判断操作风险级别

## 设计目标

- 将 6 个工具重构为 5 个, 按职责清晰划分
- 统一查询入口, 按 driverType 内部路由
- 读写分离: `db_read` (安全) vs `db_execute` (危险), 配合 MCP Tool Annotations
- 覆盖全部 6 种 DB 类型 (MySQL, PostgreSQL, Redis, MongoDB, Kafka, RabbitMQ)
- 使用 MCP Resources 暴露数据库元数据 (schema/tables/columns)

## SDK API

使用 MCP SDK v1.27+ 的 `server.registerTool()` API (替代已 deprecated 的 `server.tool()`):

```typescript
server.registerTool('db_read', {
  title: 'Read Query',
  description: '...',
  inputSchema: { ... },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, handler);
```

## 工具定义

### 1. `db_connect`

连接到数据库.

```typescript
// 连接已保存的连接 (IPC 模式)
db_connect({ connectionId: "xxx" })
// 返回: { connectionId, driverType, host, database }

// 新建连接 (standalone 模式)
db_connect({ driverType, host, port, username?, password?, database?, ssh?: { host, port, username, password?, privateKey? } })
// 返回: { connectionId, driverType, host, database }
```

Annotations: `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }`

### 2. `db_disconnect`

```typescript
db_disconnect({ connectionId: "xxx" })
```

Annotations: `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }`

无变更.

### 3. `db_list_connections`

```typescript
db_list_connections()
// 返回: { connections: [{ id, name, driverType, host, port, database, connected }] }
```

Annotations: `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`

无变更.

### 4. `db_read`

只读查询入口, 按连接的 driverType 内部路由. 保留安全限制.

```typescript
db_read({ connectionId: "xxx", query: "...", database?: "..." })
```

Annotations: `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`

Tool description 须包含各 driverType 的 query 格式示例, 让 LLM 知道该传什么格式:

```
Execute read-only queries. Query format by database type:
- MySQL/PostgreSQL: SQL string, e.g. "SELECT * FROM users LIMIT 10"
- Redis: command string, e.g. "GET key1", "HGETALL myhash"
- MongoDB: JSON, e.g. {"collection":"users","method":"find","filter":{}}
- Kafka: JSON, e.g. {"action":"listTopics"}, {"action":"fetch","topic":"t1","partition":0,"offset":"0","limit":10}
- RabbitMQ: JSON, e.g. {"action":"listQueues"}, {"action":"peek","queue":"q1","count":10}
The database parameter is optional for MySQL (schema context), required for MongoDB, and for Redis it selects db index (0-15).
```

#### 路由规则

| driverType | query 格式 | 内部处理 |
|------------|-----------|---------|
| mysql | SQL 字符串 | `driver.execute(sql, [], database)` |
| postgresql | SQL 字符串 | `driver.execute(sql, [], database)` |
| redis | Redis 命令字符串 | 解析为 args 数组, 调用 `driver.executeCommand(args)` |
| mongodb | JSON 字符串 | 解析为结构化查询, 路由到 driver |
| kafka | JSON 字符串 | 解析后路由到对应 driver 方法 |
| rabbitmq | JSON 字符串 | 解析后路由到对应 driver 方法 |

#### MySQL / PostgreSQL

只允许只读 SQL (保留现有 `sql-validator.ts` 白名单逻辑):

```
"SELECT * FROM users WHERE id = 1"
"SHOW DATABASES"
"SHOW TABLES"
"DESCRIBE users"
"EXPLAIN SELECT ..."
```

- 保留 read-only 白名单: SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH
- 保留自动 LIMIT 兜底: 最大 500 行 (无 LIMIT 时自动追加, 已有 LIMIT 且 > 500 时截断), 与现有代码一致
- 保留多语句注入检测 (去掉字符串后检查分号), 降低 prompt injection 攻击面
- `database` 参数可选, 用于 MySQL 的 `USE database` 上下文切换

#### Redis

命令字符串解析为 args 数组, 只允许读命令:

```
"GET user:1"           -> ["GET", "user:1"]
"HGETALL session:abc"  -> ["HGETALL", "session:abc"]
"SCAN 0 MATCH user:*"  -> ["SCAN", "0", "MATCH", "user:*"]
"KEYS pattern"         -> ["KEYS", "pattern"]
```

- 保留命令白名单 (现有 26 个读命令)
- `database` 参数用于 SELECT db (0-15). 类型为 string, 路由层做 `parseInt` 转换并校验范围 0-15, 超出范围返回 `INVALID_DATABASE` 错误
- SCAN COUNT 上限保持 1000
- 解析规则: 按空格分割, 支持引号包裹含空格的值 (如 `GET "key with spaces"`)

#### MongoDB

JSON 字符串, 只允许读操作:

```json
{"collection":"users","method":"find","filter":{"age":{"$gt":20}},"projection":{"name":1},"limit":100}
{"collection":"users","method":"aggregate","pipeline":[{"$group":{"_id":"$status","count":{"$sum":1}}}]}
{"collection":"users","method":"countDocuments","filter":{}}
```

- 允许的 method: `find`, `aggregate`, `countDocuments`
- aggregate 禁止 `$out` / `$merge` stage, 结果最大 500 条 (兜底截断)
- find 结果最大 500 条 (兜底 LIMIT)
- `database` 参数必填 (runtime 校验, 缺少时返回 `MISSING_DATABASE` 错误)
- `JSON.parse` 后做 runtime validation: `collection` 和 `method` 必填

#### Kafka

JSON 字符串, 只允许读操作:

```json
{"action":"listTopics"}
{"action":"describeTopic","topic":"my-topic"}
{"action":"fetch","topic":"my-topic","partition":0,"offset":"0","limit":10}
```

- 允许的 action: `listTopics`, `describeTopic`, `fetch`
- action 到 driver 方法映射: `listTopics` -> `driver.listTopics()`, `describeTopic` -> `driver.getTopicPartitions(topic)`, `fetch` -> `driver.fetchMessages(topic, partition, offset, limit)`
- `fetch` 的 offset 保持 string 类型 (driver 接口要求)
- `fetch` 的 limit 上限 500

#### RabbitMQ

JSON 字符串, 只允许读操作:

```json
{"action":"listQueues"}
{"action":"peek","queue":"my-queue","count":10}
```

- 允许的 action: `listQueues`, `peek`
- `peek` 的 count 默认 10, 上限 50 (driver 层已有限制)

### 5. `db_execute`

写操作/DDL 入口, 按连接的 driverType 内部路由.

```typescript
db_execute({ connectionId: "xxx", query: "...", database?: "..." })
```

Annotations: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }`

Tool description 须包含各 driverType 的 query 格式示例:

```
Execute write operations and DDL. Query format by database type:
- MySQL/PostgreSQL: SQL string, e.g. "INSERT INTO users (name) VALUES ('foo')", "DROP TABLE ..."
- Redis: command string, e.g. "SET key val EX 60", "DEL key1", "FLUSHDB"
- MongoDB: JSON, e.g. {"collection":"users","method":"insertOne","document":{"name":"foo"}}
- Kafka: JSON, e.g. {"action":"produce","topic":"t1","key":"k","value":"v"}
- RabbitMQ: not supported yet
The database parameter is optional for MySQL (schema context), required for MongoDB, and for Redis it selects db index (0-15).
```

#### MySQL / PostgreSQL

直接执行任意 SQL:

```
"INSERT INTO users (name, email) VALUES ('foo', 'foo@bar.com')"
"UPDATE users SET name = 'bar' WHERE id = 1"
"DELETE FROM users WHERE id = 1"
"CREATE TABLE ..."
"ALTER TABLE ..."
"DROP TABLE ..."
```

- 无白名单限制, 所有 SQL 均可执行
- 无自动 LIMIT (写操作不需要)
- 保留多语句注入检测 (禁止分号分隔的多语句), 降低 prompt injection 攻击面
- `database` 参数可选

注意: 多语句注入检测仅适用于 MySQL/PostgreSQL 的 SQL 字符串. Redis/MongoDB/Kafka/RabbitMQ 使用结构化格式 (命令字符串或 JSON), 不存在多语句问题.

#### Redis

命令字符串, 允许所有命令:

```
"SET key val EX 60"    -> ["SET", "key", "val", "EX", "60"]
"DEL key1 key2"        -> ["DEL", "key1", "key2"]
"FLUSHDB"              -> ["FLUSHDB"]
```

- 无命令白名单, 允许所有 Redis 命令
- `database` 参数: 同 `db_read`
- 解析规则: 同 `db_read`

#### MongoDB

JSON 字符串, 允许写操作:

```json
{"collection":"users","method":"insertOne","document":{"name":"foo","age":30}}
{"collection":"users","method":"insertMany","documents":[{"name":"a"},{"name":"b"}]}
{"collection":"users","method":"updateOne","filter":{"_id":"xxx"},"update":{"$set":{"name":"bar"}}}
{"collection":"users","method":"updateMany","filter":{"status":"old"},"update":{"$set":{"status":"new"}}}
{"collection":"users","method":"deleteOne","filter":{"_id":"xxx"}}
{"collection":"users","method":"deleteMany","filter":{"status":"deleted"}}
{"collection":"users","method":"aggregate","pipeline":[{"$match":{}},{"$out":"backup"}]}
{"collection":"users","method":"createIndex","keys":{"email":1},"options":{"unique":true}}
{"collection":"users","method":"dropIndex","indexName":"email_1"}
```

- 允许的 method: `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `aggregate` (允许 `$out`/`$merge`), `createIndex`, `dropIndex`
- `database` 参数必填 (runtime 校验)
- **空 filter 防护**: `deleteMany` / `updateMany` 的 filter 为空对象 `{}` 时, 返回错误 `{ error: "empty filter on bulk operation is dangerous, use {\"_all\": true} to confirm", code: "DANGEROUS_OPERATION" }`. 传 `{"_all": true}` 时转换为 `{}` 执行
- **`dispatchMethod` 重构**: 当前 `dispatchMethod` 是 `mongo-driver.ts` 的 module-level 私有函数, 不是 `MongoDriver` 类的方法. 需要:
  1. 将其提升为 `MongoDriver` 的 **public 方法**, 签名改为 `dispatchMethod(database: string, collection: string, method: string, args: Record<string, unknown>, options?: { limit?: number }): Promise<QueryResult>`
  2. 扩展 switch 增加 `createIndex`, `dropIndex` case (其余写操作 `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany` 及读操作 `find`, `aggregate`, `countDocuments` 已有)
  3. `find` case 的 limit 参数化: 从 `options.limit` 读取, 不再硬编码 1000
  4. `aggregate` 结果也加 limit 截断 (db_read 时 500 条兜底)
- `db_read` 和 `db_execute` 的 MongoDB 路由都走 `driver.dispatchMethod()`, 由 mode 参数控制允许的 method 集合
- **`ConnectionPool` 类型路由**: 当前 `getDriver()` 返回 `IDatabaseDriver`, MongoDB 需要访问 `dispatchMethod`. 新增 `ConnectionPool.getMongoDriver(id): MongoDriver` 方法 (与已有的 `getRedisDriver`/`getKafkaDriver`/`getRabbitMQDriver` 对齐)

#### Kafka

JSON 字符串, 允许写操作:

```json
{"action":"produce","topic":"my-topic","key":"k1","value":"v1"}
{"action":"produce","topic":"my-topic","key":"k1","value":"v1","partition":0,"headers":{"source":"mcp"}}
```

- 允许的 action: `produce`
- `headers` 默认 `{}`, `partition` 默认 undefined

#### RabbitMQ

当前 driver 无写操作, `db_execute` 暂不支持 RabbitMQ. 收到 RabbitMQ connectionId 时返回 `{ error: "RabbitMQ does not support write operations yet.", code: "UNSUPPORTED_COMMAND" }`. 后续扩展 PUBLISH 等操作时再添加.

## MCP Resources

使用 MCP Resources 原语暴露数据库元数据, 比通过 `db_read` 执行 `SHOW DATABASES` 更语义化, 且天然 read-only.

### Resource URI 模式

```
sqlext://{connectionId}/databases                          -> 数据库列表
sqlext://{connectionId}/{database}/tables                  -> 表/集合列表
sqlext://{connectionId}/{database}/{table}/columns         -> 列/字段信息
sqlext://{connectionId}/{database}/{table}/ddl             -> DDL (CREATE TABLE 语句)
```

### 支持矩阵

| Resource | MySQL | PostgreSQL | MongoDB | Redis | Kafka | RabbitMQ |
|----------|-------|------------|---------|-------|-------|----------|
| databases | listDatabases() | listDatabases() | listDatabases() | 返回 db 0-15 | N/A | N/A |
| tables | listTables(db) | listTables(db) | listTables(db) | N/A | listTopics() | listQueues() |
| columns | listColumns(db, t) | listColumns(db, t) | listColumns(db, t) | N/A | N/A | N/A |
| ddl | getTableDDL(db, t) | getTableDDL(db, t) | getTableDDL(db, t) | N/A | N/A | N/A |

### 实现方式

使用 MCP Resource Templates (动态 URI):

```typescript
server.registerResource(
  'database-list',
  new ResourceTemplate('sqlext://{connectionId}/databases', {
    list: async () => {
      // 返回所有活跃连接的 database resource URI, 提高可发现性
      // SDK 要求返回 { resources: [...] } 格式 (ListResourcesResult)
      const connections = await getActiveConnections();
      return { resources: connections.map(c => ({ uri: `sqlext://${c.id}/databases` })) };
    }
  }),
  {
    title: 'Database List',
    description: 'List all databases for a connection',
    mimeType: 'application/json',
  },
  async (uri, { connectionId }) => { ... }
);
```

注意: `db_connect` 的 inputSchema 保持 flat optional fields 方案, 不要用 `z.discriminatedUnion()` (SDK bug #1643 会静默丢弃 schema).

IPC 模式下通过 `IpcClient` 调用 `listDatabases` 等方法, standalone 模式下通过 `ConnectionPool` 直接调用 driver.

## 公共逻辑

### `isPoolConnection(id: string): boolean`

抽取到 `src/mcp/utils.ts`, 替代各文件中散落的 `id.startsWith('conn_')` 硬编码.

### 查询路由器

`db_read` 和 `db_execute` 共享路由逻辑, 差异仅在:
1. 允许的操作集合不同
2. Tool Annotations 不同
3. 是否有 LIMIT 兜底

建议抽取 `src/mcp/query-router.ts`, 接收 `mode: 'read' | 'execute'` 参数控制行为.

## 删除的文件/代码

| 文件 | 操作 |
|------|------|
| `src/mcp/tools/redis.ts` | 删除, 逻辑合入查询路由器 |
| `src/mcp/tools/mongo.ts` | 删除, 逻辑合入查询路由器 |

## 重构的文件

| 文件 | 操作 |
|------|------|
| `src/mcp/tools/query.ts` | 重构为 `db_read` 注册, 使用 `registerTool()` API |
| `src/mcp/tools/connect.ts` | 迁移到 `registerTool()` API |
| `src/mcp/sql-validator.ts` | 保留, 仅供 `db_read` 使用; `db_execute` 仅用多语句检测部分 |
| `src/mcp/server.ts` | 更新工具注册: 移除 redis/mongo, 新增 db_read/db_execute, 新增 Resources |

## 新增的代码

| 文件 | 职责 |
|------|------|
| `src/mcp/tools/execute.ts` | `db_execute` 工具注册 + 路由 |
| `src/mcp/query-router.ts` | 统一查询路由器, db_read/db_execute 共享 |
| `src/mcp/parsers/redis-parser.ts` | Redis 命令字符串 -> args 数组 |
| `src/mcp/parsers/mongo-parser.ts` | MongoDB JSON 解析 + validation |
| `src/mcp/parsers/kafka-parser.ts` | Kafka JSON 解析 |
| `src/mcp/parsers/rabbitmq-parser.ts` | RabbitMQ JSON 解析 |
| `src/mcp/resources.ts` | MCP Resources 注册 (databases/tables/columns/ddl) |
| `src/mcp/utils.ts` | `isPoolConnection()` 等公共函数 |

## 参数命名变更

当前 `query.ts` 的 MCP schema 参数名为 `sql`, 重构后统一改为 `query` (因为不再只是 SQL). 这是 breaking change, 使用旧参数名的 MCP client 配置需要更新.

## 错误码

统一错误码体系. 错误消息应 actionable, 告诉 LLM 如何修复:

| 错误码 | 含义 | 错误消息示例 |
|--------|------|-------------|
| `CONNECTION_NOT_FOUND` | connectionId 对应的连接不存在 | "Connection 'xxx' not found. Use db_list_connections to see available connections." |
| `NOT_CONNECTED` | 连接未建立 | "Connection 'xxx' is not connected. Use db_connect first." |
| `PARSE_FAILED` | query 解析失败 | "Invalid JSON in query. Expected format: {\"collection\":\"...\",\"method\":\"find\",\"filter\":{}}" |
| `UNSUPPORTED_COMMAND` | 不支持的命令 | "Unknown action 'xxx'. Allowed actions in db_read: listTopics, describeTopic, fetch." |
| `MISSING_DATABASE` | MongoDB 缺少 database 参数 | "database parameter is required for MongoDB. Specify the target database name." |
| `INVALID_METHOD` | MongoDB method 不在允许列表中 | "Method 'deleteOne' not allowed in db_read. Use db_execute for write operations." |
| `QUERY_FAILED` | 查询执行失败 (driver 层错误) | 透传 driver 错误消息 |
| `INVALID_DATABASE` | Redis database 不在 0-15 范围 | "Redis database must be 0-15, got 'xxx'." |
| `DANGEROUS_OPERATION` | MongoDB 空 filter 防护触发 | "Empty filter on deleteMany is dangerous. Use {\"_all\": true} in filter to confirm." |
| `MULTI_STATEMENT` | SQL 包含多语句 | "Multiple SQL statements not allowed. Send one statement at a time." |
| `READONLY_VIOLATION` | db_read 收到写操作 | "db_read only accepts SELECT/SHOW/DESCRIBE/EXPLAIN. Use db_execute for write operations." |

## 测试变更

| 文件 | 操作 |
|------|------|
| `src/mcp/tools/__tests__/query.test.ts` | 重写为 db_read 测试: 覆盖全部 6 种 driverType 的只读路由 |
| `src/mcp/tools/__tests__/execute.test.ts` | 新增: db_execute 测试, 覆盖写操作路由 + 空 filter 防护 |
| `src/mcp/tools/__tests__/redis.test.ts` | 删除 |
| `src/mcp/tools/__tests__/mongo.test.ts` | 删除 |
| `src/mcp/__tests__/sql-validator.test.ts` | 保留, 可能需要微调 |
| `src/mcp/parsers/__tests__/redis-parser.test.ts` | 新增: 空格分割, 引号处理, 边界情况 |
| `src/mcp/parsers/__tests__/mongo-parser.test.ts` | 新增: JSON 解析, method 校验, 空 filter 防护 |
| `src/mcp/parsers/__tests__/kafka-parser.test.ts` | 新增: 各 action 解析 |
| `src/mcp/parsers/__tests__/rabbitmq-parser.test.ts` | 新增: 各 action 解析 |
| `src/mcp/__tests__/resources.test.ts` | 新增: Resource URI 解析, 各 driverType 元数据查询 |

## IPC 协议变更

`src/services/ipc-server.ts` 的 `dispatch` 方法需要同步更新:

- 删除 `redisCommand` / `mongoQuery` case
- 新增 `read` / `execute` case, 与 MCP 工具对应
- 通过 `connectionId` 查找对应连接的 `driverType` (已有接口: `getConnections().find(c => c.id === id)?.driverType`, 或通过各 `getXxxDriver()` 方法的类型守卫), 按类型路由:
  - `mysql` / `postgresql`: 调用 `getDriver(connId).execute(sql, [], database)`
  - `redis`: 解析命令字符串, 调用 `getRedisDriver(connId).executeCommand(args)`, 若有 database 参数先 `selectDatabase(db)`
  - `mongodb`: 解析 JSON, 统一走 `MongoDriver.dispatchMethod()`, 由 mode 控制允许的 method 集合
  - `kafka`: 解析 JSON, 路由到 `getKafkaDriver(connId)` 的对应方法
  - `rabbitmq`: 解析 JSON, 路由到 `getRabbitMQDriver(connId)` 的对应方法
- 新增 `listDatabases` / `listTables` / `listColumns` / `getTableDDL` case (供 MCP Resources 使用)
- IPC 请求格式: `{ method: "read" | "execute" | "listDatabases" | ..., params: { connectionId, query?, database?, table? } }`

注意: `IpcClient` 本身是通用的 `request(method, params)` 接口, 代码不需要改, 只是调用时传的 method 从 `query`/`redisCommand`/`mongoQuery` 统一为 `read`/`execute` 等.

## 不变的部分

- `db_disconnect` 工具不变
- `db_list_connections` 工具不变
- `ConnectionPool` (`src/mcp/connection-pool.ts`) 需新增 `getMongoDriver(id): MongoDriver` 方法 (与已有的 `getRedisDriver`/`getKafkaDriver`/`getRabbitMQDriver` 对齐)
- `IpcClient` (`src/mcp/ipc-client.ts`) 不变
- 大部分 driver 实现不变, 仅 `MongoDriver.dispatchMethod()` 需扩展写操作 case
- MCP server 入口 (`src/mcp/server.ts`) 结构不变, 只是注册的工具和 Resources 变化

## 工具总览

| 工具 | 用途 | Annotations |
|------|------|-------------|
| `db_connect` | 连接数据库 | `readOnly: false, destructive: false, idempotent: true, openWorld: true` |
| `db_disconnect` | 断开连接 | `readOnly: false, destructive: false, idempotent: true, openWorld: false` |
| `db_list_connections` | 列出所有连接 | `readOnly: true, destructive: false, idempotent: true, openWorld: false` |
| `db_read` | 只读查询 (全类型) | `readOnly: true, destructive: false, idempotent: true, openWorld: true` |
| `db_execute` | 写操作/DDL (全类型) | `readOnly: false, destructive: true, idempotent: false, openWorld: true` |

## Resources 总览

| URI 模式 | 用途 | 支持的 driverType |
|----------|------|-------------------|
| `sqlext://{connId}/databases` | 数据库列表 | MySQL, PostgreSQL, MongoDB, Redis |
| `sqlext://{connId}/{db}/tables` | 表/集合/Topic/Queue 列表 | MySQL, PostgreSQL, MongoDB, Kafka, RabbitMQ |
| `sqlext://{connId}/{db}/{table}/columns` | 列/字段信息 | MySQL, PostgreSQL, MongoDB |
| `sqlext://{connId}/{db}/{table}/ddl` | DDL 定义 | MySQL, PostgreSQL, MongoDB |
