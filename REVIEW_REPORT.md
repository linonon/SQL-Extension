# SQL Extension 全面 Review 报告

> 生成时间: 2026-02-18
> 分析范围: Extension Host (src/) + Webview UI (webview-ui/src/) + Tests
> 代码规模: ~18,836 行 | 审查维度: 架构/代码质量/安全/测试覆盖/性能

---

## 总览

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 (立即修复) | 3 | 影响数据正确性的 bug |
| P1 (下个迭代) | 11 | 架构违规/安全风险/稳定性 |
| P2 (技术债) | 17 | 潜在风险/覆盖缺口/代码质量 |
| P3 (长期优化) | 10 | 性能优化/DX 改进/规范 |

---

## P0 — 立即修复 (影响数据正确性)

---

### [P0-1] mongo-driver.ts insertMany 缺少 EJSON 转换

位置: `src/drivers/mongo-driver.ts:166`
描述: `insertMany` 直接 `const docs = args[0] as unknown[]` 传给 `coll.insertMany()`, 没有调用 `convertEjsonToBson()`. 而 `insertOne` (line 161) 已正确调用.
影响: 用户通过 `insertMany` 插入含 EJSON 格式的文档 (如 `{"$oid": "..."}`) 时, 数据以原始 JSON 字符串存入 MongoDB 而非正确的 BSON 类型, 导致数据类型不一致, 查询异常.
修复:
```typescript
// 将 line 166 从:
const docs = args[0] as unknown[];
// 改为:
const docs = convertEjsonToBson(args[0] ?? []) as unknown[];
```

---

### [P0-2] alter-table-builder.ts 无任何测试

位置: `src/utils/alter-table-builder.ts`
描述: 生成 ALTER TABLE SQL 的核心工具函数完全无测试. 涉及 MySQL/PostgreSQL 双方言, rename table/column, add/drop/modify column 等多种操作.
影响: ALTER TABLE 语句错误直接导致数据库 schema 损坏. 这是风险最高的无测试区域 — 纯函数, 无外部依赖, 却完全未覆盖.
修复: 创建 `src/utils/alter-table-builder.test.ts`, 必须覆盖:
- MySQL/PG 各操作的 SQL 正确性
- `buildDefaultClause`: null/数值/字符串/含单引号字符串
- `escId`: MySQL 反引号/PG 双引号/特殊字符标识符
- 恶意 table/column 名 (SQL 注入防护验证)
- 空 changes 返回空数组

---

### [P0-3] rabbitmq-driver.ts 无任何测试

位置: `src/drivers/rabbitmq-driver.ts`
描述: RabbitMQ driver 是新增功能, HTTP API 调用、vhost encoding、响应解析、错误处理全部未测试. 同类的 mysql/pg/redis/kafka/mongo driver 都有测试文件.
影响: RabbitMQ 作为支持的数据源之一, 基础连接和消息浏览功能的正确性无任何保障.
修复: 创建 `src/drivers/rabbitmq-driver.test.ts`, 必须覆盖:
- `connect`: authHeader Base64 生成, vhost 默认值, HTTP 4xx/5xx/网络错误
- `disconnect`: 状态重置
- `listQueues`: vhost URL encoding, 字段映射, 未连接时抛错
- `peekMessages`: count 上限截断 (50), POST body, `properties.headers` 为 null 时降级为 `{}`
- `request`: HTTP vs HTTPS 选择, 10s 超时, error 事件处理

---

## P1 — 下个迭代 (架构违规/安全风险/稳定性)

---

### [P1-1] table-view-provider.ts 严重违反 SRP (738 行)

位置: `src/providers/table-view-provider.ts:1-738`
描述: 单文件同时承担 5 个不同职责:
1. Webview panel 生命周期管理 (L36-254)
2. SQL 数据操作消息路由 (L265-443, 16 个 case)
3. NoSQL 消息委托+确认拦截 (L446-598, ~150 行嵌套 if-else)
4. 连接表单管理+driver 实例化 (L121-217, L633-727)
5. Schema 缓存 (L42, L422-443)

影响: 任何职责变更都需修改这个 738 行文件. 新增 driver 类型需同时修改消息路由和连接表单. 无任何测试覆盖.
修复: 按以下阶段拆分 (完成后 table-view-provider.ts 降至 ~250 行):
- **Phase 1**: 抽取 `src/providers/sql-message-handler.ts` (~200 行) — 处理所有 SQL/关系型 DB 的 fetchRows/CRUD/schema 操作
- **Phase 2**: 将 Redis 确认逻辑 (L477-594) 统一回 `redis-message-handler.ts`, 用 Action 返回模式 (`{ action: 'confirm', prompt, onConfirm }`)
- **Phase 3**: 抽取 `src/providers/connection-form-handler.ts` (~120 行) — 处理 testConnection/saveConnection 和 driver 工厂

---

### [P1-2] handleMessage default 分支 ~150 行嵌套 if-else

位置: `src/providers/table-view-provider.ts:445-598`
描述: `default` 分支用 `startsWith()` prefix 路由, Redis 部分有 8 个需要 `vscode.window` 交互的特殊 case 直接内联, 导致 Redis 消息处理逻辑分散在 `table-view-provider.ts` 和 `redis-message-handler.ts` 两处.
影响: 维护 Redis 功能时必须同时看两个文件, 容易遗漏. Mongo 的 deleteDocument 确认也嵌在这里 (L461-465).
修复: 同 P1-1 Phase 2.

---

### [P1-3] 9 处未验证的 message 类型断言

位置: `src/providers/table-view-provider.ts:478,500,508,531,555,564,572,580,589`
描述: Redis 消息处理中 9 处将 `message` 直接断言为特定类型, 无任何运行时验证. 实际来自 `webview.onDidReceiveMessage` 的消息是 `any`.
影响: webview 发送结构不匹配的消息 (bug 或被篡改) 会导致运行时 undefined 访问, 影响 Redis export/import/TTL/delete 等关键路径.
修复: 在 handler 入口用 discriminated union type guard 做一次类型收窄, 后续代码无需断言.

---

### [P1-4] SSH Host Key 未验证 (MITM 风险)

位置: `src/services/ssh-tunnel.ts:79`
描述: `sshClient.connect(connectConfig)` 未设置 `hostVerifier`, ssh2 默认接受任何 host key.
影响: 不受信任的网络环境下 (公共 WiFi, 被入侵路由器), 攻击者可伪造 SSH server, 截获数据库凭证和查询数据.
修复: 实现 "Trust on First Use" (TOFU) 模式 — 首次连接弹窗显示 fingerprint 让用户确认, 后续连接自动验证存储的 fingerprint. 使用 `credentialStore` 存储已信任的 host key.

---

### [P1-5] MongoDB collection name 未转义直接拼接

位置: `src/utils/sql-builder.ts:40,54,67,82,103,136`
描述: `buildInsert/buildUpdate/buildDelete` 等函数将来自 webview `message.table` 的 collection name 直接拼接到 shell 命令字符串. `parseMongoQuery` 的正则 `[a-zA-Z_$][\w$]*` 能阻断执行, 但不阻断生成异常字符串.
影响: 如果 collection name 含特殊字符, 生成的命令被 `parseMongoQuery` 误解析或产生意外行为.
修复:
```typescript
function escapeMongoCollection(name: string): string {
  if (!/^[a-zA-Z_$][\w$]*$/.test(name)) {
    throw new Error(`Invalid collection name: ${name}`);
  }
  return name;
}
// 所有 MongoDB 路径的 table 参数替换为 escapeMongoCollection(table)
```

---

### [P1-6] 连接池无 error 事件监听 (可能导致 Extension Host Crash)

位置: `src/drivers/mysql-driver.ts:11-20`, `src/drivers/pg-driver.ts:11-20`
描述: MySQL 和 PostgreSQL 连接池创建后, 没有注册 `pool.on('error', ...)`. 空闲连接因网络中断断开时, pool 会 emit `error` 事件. Node.js 中未监听的 `error` 事件会触发 uncaught exception.
影响: 网络不稳定时 (尤其通过 SSH tunnel), 空闲连接断开可能导致 Extension Host 进程崩溃, 所有打开的 webview 数据丢失.
修复:
```typescript
// mysql-driver.ts 和 pg-driver.ts 的 constructor 中:
this.pool.on('error', (err) => {
  // 记录到 VS Code Output Channel, 不让 error 冒泡
  console.error('[Pool] Idle client error:', err.message);
});
```

---

### [P1-7] Schema 缓存无过期机制和大小限制

位置: `src/providers/table-view-provider.ts:42`
描述: `schemaCache = new Map<string, ...>()`, 无 TTL, 无 entry 上限, panel 关闭/连接断开后不清理.
影响: 长时间使用后缓存无限积累, 且可能展示过期 schema 信息 (用户在外部修改了表结构后, autocomplete 还显示旧列名).
修复: 增加 TTL + 最大 entry 限制 + 连接断开时清理 (详见 P2-12).

---

### [P1-8] ssh-tunnel.ts 无测试

位置: `src/services/ssh-tunnel.ts`
描述: SSH 隧道是所有数据库类型的共用核心组件 (CLAUDE.md 明确要求所有 driver 支持 SSH Tunnel), 但完全无测试.
影响: 隧道逻辑 bug 影响所有通过 SSH 连接的用户.
修复: 创建 `src/services/ssh-tunnel.test.ts`, mock `ssh2` 和 `net` 模块, 覆盖密码/私钥认证、连接成功/失败、TCP server error、close() 清理.

---

### [P1-9] rabbitmq-message-handler.ts 无测试

位置: `src/providers/rabbitmq-message-handler.ts`
描述: 同类的 `redis-message-handler.test.ts` 和 `kafka-message-handler.test.ts` 都有完整测试, 唯独 RabbitMQ 缺失.
影响: RabbitMQ UI 交互的消息路由正确性无保障.
修复: 参照 `redis-message-handler.test.ts` 模式创建测试文件.

---

### [P1-10] mongo-message-handler.ts 无测试

位置: `src/providers/mongo-message-handler.ts`
描述: 同上, MongoDB 消息 handler 无测试.
影响: MongoDB UI 交互正确性无保障.
修复: 参照现有 message handler 测试模式创建测试文件.

---

### [P1-11] mysql-driver.test.ts 记录了已知 bug 但未修复

位置: `src/drivers/mysql-driver.test.ts:56-77`
描述: 测试注释明确写 "当前实现在连接验证失败时没有清理 pool, 这是 bug". 测试检测到了 bug 但只是绕过, 没有 fix 实现也没有 fail.
影响: 连接失败后 driver 可能处于不一致状态 (pool 存在但 connected 未知), 可能导致后续操作异常.
修复: 在 `mysql-driver.ts` 的 connect 失败路径中, 确保 pool 被销毁并重置为 null.

---

## P2 — 技术债 (潜在风险/覆盖缺口/代码质量)

---

### [P2-1] Driver 工厂硬编码 6 层三元链

位置: `src/providers/table-view-provider.ts:637-645`
描述: `testConnection` 用 6 层嵌套三元运算符创建 driver, 新增 driver 类型时需手动修改且没有编译期保护 (漏写 fallback 到 PgDriver).
修复:
```typescript
const DRIVER_FACTORIES: Record<DriverType, () => IDatabaseDriver> = {
  mysql: () => new MySQLDriver(),
  postgresql: () => new PgDriver(),
  redis: () => new RedisDriver(),
  kafka: () => new KafkaDriver(),
  mongodb: () => new MongoDriver(),
  rabbitmq: () => new RabbitMQDriver(),
};
const driver = DRIVER_FACTORIES[config.driverType]();
```

---

### [P2-2] Webview 消息无运行时 schema 校验

位置: `src/types/messages.ts:68-128`, `src/providers/table-view-provider.ts`
描述: `WebviewMessage` 是纯 TypeScript union type, 编译时有效但运行时无效. 来自 `webview.onDidReceiveMessage` 的 payload 实际是 `any`.
修复: 用 zod 定义消息 schema 并在 `handleMessage` 入口做一次 `parse()`, 校验失败时 log 警告而非 crash.

---

### [P2-3] mongo-driver.ts 类型断言无保护

位置: `src/drivers/mongo-driver.ts:150-198`
描述: `dispatchMethod` 中 `args` 元素被频繁断言为 `Record<string, unknown>`, 如果 args 结构不符预期 (null/非对象), `convertEjsonToBson` 可能产生意外行为.
修复: 在 `parseMongoQuery` 返回时校验 args 结构, 不匹配时抛出描述性错误.

---

### [P2-4] pg-driver.ts 通过双重 as 访问内部属性

位置: `src/drivers/pg-driver.ts:217`
描述: `(client as unknown as { processID: number }).processID` 访问 `pg.PoolClient` 的非公开属性.
修复: 加注释说明为何需要访问 `processID` 和对应 pg 内部实现. 或改用 `pg` 的 `on('connect')` callback 获取 PID.

---

### [P2-5] mongo-driver.ts 空 catch 无 log

位置: `src/drivers/mongo-driver.ts:46-48`, `src/drivers/mongo-driver.ts:69-71`
描述: 两处空 catch 静默忽略错误, 调试时无法知道是否发生了错误.
修复: 加 `// intentionally swallowed - reason: ...` 注释, 或加 debug level log.

---

### [P2-6] SSH 私钥文件无权限检查

位置: `src/services/ssh-tunnel.ts:35`
描述: `fs.readFileSync(expandHome(config.privateKeyPath))` 无权限模式检查, 用户可能无意中使用 0644 的私钥文件.
修复:
```typescript
const stat = fs.statSync(keyPath);
if ((stat.mode & 0o077) !== 0) {
  throw new Error(`Private key ${keyPath} permissions too open (${(stat.mode & 0o777).toString(8)}). Run: chmod 600`);
}
```

---

### [P2-7] Raw SQL 执行无破坏性操作确认

位置: `src/providers/table-view-provider.ts:338-356`
描述: QueryEditor 执行 `DROP TABLE`, `DELETE FROM` (无 WHERE), `TRUNCATE` 等操作时没有确认步骤. 相比之下, UI 删除行有 modal 确认.
修复:
```typescript
const DANGEROUS_PATTERN = /^\s*(DROP|TRUNCATE|DELETE\s+FROM\s+\w+\s*(?:;|$))/im;
if (DANGEROUS_PATTERN.test(message.sql)) {
  const ok = await vscode.window.showWarningMessage(
    'This query contains a destructive operation. Continue?',
    { modal: true }, 'Execute'
  );
  if (ok !== 'Execute') { break; }
}
```

---

### [P2-8] CSP 缺少明确的 img-src/connect-src 指令

位置: `src/providers/webview-helper.ts:18-22`
描述: 虽然 `default-src 'none'` 是安全的基线, 但缺少明确声明意味着未来维护者可能误放松 default-src 而非添加具体指令.
修复: 显式声明所有指令提高可读性和维护安全性.

---

### [P2-9] dump-service.ts 无测试

位置: `src/services/dump-service.ts`
描述: SQL dump 功能涉及值转义逻辑, 转义错误可能导致导出 SQL 语法错误或注入风险.
修复: 创建测试文件, 优先覆盖 `escapeValue` 纯函数部分 (null/number/boolean/Date/string/含单引号字符串).

---

### [P2-10] Dump Service 大表导出全量内存积累

位置: `src/services/dump-service.ts:75-106`
描述: 所有 INSERT 语句拼接到 `parts: string[]` 最后 `join('\n')`. 百万行表约 200MB 字符串全部在内存中.
影响: VS Code Extension Host 进程可能 OOM.
修复: 改为流式写入, 每 PAGE_SIZE 行写一次文件, 不在内存中积累.

---

### [P2-11] fetchSchema N+1 串行查询

位置: `src/providers/table-view-provider.ts:622-631`
描述: 先 listTables 获取所有表, 再对每张表串行调用 listColumns.
影响: 100 张表的数据库需要 101 次查询全部串行, 通过 SSH tunnel 时可能 10-30 秒.
修复: 用单条 SQL 一次获取所有列信息 (MySQL: `information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`; PG: `information_schema.columns WHERE table_schema = 'public'`).

---

### [P2-12] schemaCache 连接断开后不清理

位置: `src/providers/table-view-provider.ts:42`, `src/providers/table-view-provider.ts:729-737`
描述: `dispose()` 不清除 schemaCache; 用户 disconnect 后重 connect 会使用过期缓存.
修复:
```typescript
// dispose() 中:
this.schemaCache.clear();
// 连接状态变化时:
connectionManager.onDidChange(() => {
  for (const key of this.schemaCache.keys()) {
    const connId = key.split(':')[0];
    if (!connectionManager.isConnected(connId)) {
      this.schemaCache.delete(key);
    }
  }
});
```

---

### [P2-13] 虚拟滚动实现不完整

位置: `webview-ui/src/components/data-grid/DataGrid.tsx:276-338`
描述: 使用 `@tanstack/react-virtual` 但缺少 container height 设置和行的 absolute 定位, 可能导致滚动跳动.
修复: 补全标准虚拟滚动实现: container `height = virtualizer.getTotalSize()px`, 行用 `position: absolute` + `transform: translateY(${virtualRow.start}px)`.

---

### [P2-14] table-view-provider.ts 无测试

位置: `src/providers/table-view-provider.ts`
描述: 最大的单文件, 无任何测试覆盖. 但由于强耦合 vscode API, 单元测试 ROI 低.
修复: 优先通过 E2E 测试覆盖核心流程. 完成 P1-1 重构后, 抽出的 sql-message-handler.ts 可以单元测试.

---

### [P2-15] connection-manager.test.ts dispose 测试不充分

位置: `src/services/connection-manager.test.ts:617-651`
描述: dispose 测试只验证 "不抛错", 未验证所有连接的 driver.disconnect 被调用.
修复: 添加 spy 验证每个 driver.disconnect 被调用一次.

---

### [P2-16] 所有 driver 测试缺少并发/竞态测试

描述: 没有测试并发调用 (同时 connect 和 disconnect, 或同时执行多个 query) 的行为.
修复: 对每个 driver 添加至少一个并发测试场景.

---

### [P2-17] query-service.test.ts 缺少错误路径测试

位置: `src/services/query-service.test.ts`
描述: 没有测试 driver.execute 抛错时 (网络断开/SQL 语法错误) 的 webview 响应.
修复: 添加 driver.execute reject 场景, 验证 webview 收到正确的 error 消息.

---

## P3 — 长期优化 (性能优化/DX 改进/规范)

---

### [P3-1] openXxxBrowser 方法重复模式 (~40 行)

位置: `src/providers/table-view-provider.ts:136-189`
描述: `openRedisBrowser/openKafkaBrowser/openRabbitMQBrowser/openMongoBrowser` 四个方法结构完全相同.
修复: 统一为 `openBrowser(prefix, connectionId, title, viewType, context)`.

---

### [P3-2] mongo-driver.ts 死代码 inferColumnsFromRows

位置: `src/drivers/mongo-driver.ts:308-328`
描述: `inferColumnsFromRows` 函数定义但从未被引用, 功能被 `inferSchema` (line 258) 替代.
修复: 直接删除.

---

### [P3-3] table-view-provider.ts 重复变量声明

位置: `src/providers/table-view-provider.ts:544-545`
描述: `redisSetTTLPrompt` 分支内重复声明了外层已有的 `post` 和 `redisDriver`.
修复: 删除 line 544-545 的重复声明.

---

### [P3-4] 错误消息直接透传 err.message

位置: `src/providers/table-view-provider.ts:602-618`
描述: 完整的 `err.message` 发送到 webview, 可能包含连接字符串、文件路径等内部信息.
修复: 对敏感信息做脱敏处理, 或至少过滤掉 URL 格式的字符串.

---

### [P3-5] DataGrid cell 渲染 O(cols²) 查找

位置: `webview-ui/src/components/data-grid/DataGrid.tsx:295`
描述: 每个 cell 渲染时调用 `columns.find()` 判断是否为 PK 列.
修复:
```typescript
const pkColumnSet = useMemo(
  () => new Set(columns.filter(c => c.isPrimaryKey).map(c => c.name)),
  [columns]
);
```

---

### [P3-6] schema-service.ts / credential-store.ts / webview-helper.ts 无测试

位置: 上述三个文件
描述: 均为薄封装层, 测试 ROI 低.
修复: 低优先级, 可在修复其他问题时顺带补充.

---

### [P3-7] 测试中 mock 对象使用 any 类型

描述: 多数测试文件中 mock 对象类型为 `any`, 与实际接口不匹配时编译期不报错.
修复: 将高频使用的 mock 改为实现接口的 `Partial<Interface>` 或完整实现.

---

### [P3-8] pg-driver.ts 的 cancel 操作 catch 静默忽略

位置: `src/drivers/pg-driver.ts:247`, `src/drivers/mysql-driver.ts:183`
描述: `pg_cancel_backend` / `KILL QUERY` 的 `.catch(() => {})` 完全吞掉错误.
修复: 加 debug log, 让运维可见 cancel 失败的情况.

---

## 执行建议

### 最快 ROI 的修复顺序

1. **P0-1** (mongo insertMany bug): 5 分钟, 一行改动
2. **P1-6** (连接池 error 监听): 5 分钟, 防止 crash
3. **P2-1** (driver 工厂 Record): 15 分钟, 消除脆弱三元链
4. **P3-2** (删除死代码): 2 分钟
5. **P3-3** (删除重复声明): 2 分钟
6. **P0-2** (alter-table-builder 测试): 2-3 小时, 高风险纯函数
7. **P2-7** (危险 SQL 确认): 30 分钟
8. **P1-5** (MongoDB collection 名转义): 30 分钟

### 架构重构顺序 (分 3 个 PR)

- PR 1: table-view-provider 拆分 (P1-1, P1-2) — 最大降噪
- PR 2: 测试补全 (P0-3, P1-8, P1-9, P1-10) — 覆盖率从 61% 提升到 ~80%
- PR 3: 安全加固 (P1-4, P2-6, P2-7) — SSH TOFU + 权限检查 + 危险 SQL 确认

---

## 安全亮点 (做得好的地方)

1. SQL 参数化查询: MySQL/PG 使用 `?` / `$N` 占位符, 防止 SQL 注入
2. 凭证存储: 使用 VS Code SecretStorage API (系统 keychain), 不自实现加密
3. CSP 配置: `default-src 'none'` + nonce-based script-src
4. MongoDB 方法白名单: `SUPPORTED_METHODS` 阻止 `drop`/`dropDatabase` 等危险操作
5. 所有删除操作有 modal 确认: UI 级别的 CRUD 删除都有 `showWarningMessage({ modal: true })`
6. Webview localResourceRoots 限制: 只允许加载 `webview-ui/dist/`
7. 无硬编码密码/密钥: grep 搜索未发现任何字面量 secrets
