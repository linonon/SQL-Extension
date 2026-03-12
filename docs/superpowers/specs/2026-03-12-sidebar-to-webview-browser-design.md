# Sidebar to Webview Browser

## Summary

将 sidebar 从树展开模式改为 flat 连接列表模式. 点击任何连接类型都直接打开对应的 webview tab, 不再在 sidebar 中展开子节点. 新增 DatabaseBrowser webview 给 MySQL/PostgreSQL, 提供左侧 database > table 列表 (含搜索过滤) + 右侧数据表.

## Motivation

- 表多时在 sidebar 树里找表很慢, 没有搜索/过滤能力
- MongoDB 已经实现了 "连接 -> 打开 browser webview" 的模式, 效果好, 应该统一
- sidebar 树展开层级深 (connection > database > table > column), 操作路径长

## Design Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| 改动范围 | 统一所有连接类型 | 一致的用户体验 |
| sidebar 展开 | 完全不展开, flat 连接列表 | 简洁, sidebar 变纯连接管理器 |
| 左侧面板层级 | database > table 两级 | column 信息在右侧数据表体现 |
| 搜索过滤 | 支持 `keyword` 和 `db.keyword` 格式 | 多 database 场景下需要按 db 过滤 |
| 右键菜单 | 全部迁移到 webview 内右键菜单 | 功能完整不丢失 |
| Redis/Kafka/RMQ | browser webview 不改 | 只改 sidebar 触发方式, 避免 scope creep |
| 实施方式 | 一步到位 | 避免过渡期代码共存 |

## Architecture

### 1. Sidebar (ConnectionTreeProvider)

改动后:
- `getChildren(undefined)`: 返回 `ConnectionTreeItem[]` (不变)
- `getChildren(ConnectionTreeItem)`: 返回空数组 (不再展开)
- `ConnectionTreeItem.collapsibleState`: 全部改为 `TreeItemCollapsibleState.None` (不再区分 connected/disconnected)
- 删除所有 `get*Items` / `subdivideRedisKeys` 方法
- 保留 drag-and-drop 排序

### 2. 连接点击路由

点击 `ConnectionTreeItem` -> 未连接则先连接 -> 按 driverType 打开 webview tab:

| driverType | viewType |
|---|---|
| mysql, postgresql | `db-browser` (新增) |
| redis | `redis-browser` (已有), 默认 `database: 0` |
| kafka | `kafka-browser` (已有), 不传 `topic` (browser 内选择) |
| rabbitmq | `rmq-browser` (已有), 不传 queue (browser 内选择) |
| mongodb | `mongo-browser` (已有) |

同一 connectionId 不重复打开, 已有 tab 则 reveal. panelKey 格式: `{viewType}:{connectionId}` (如 `db-browser:conn-123`). Redis 改为 per-connection 单 tab (panelKey 不含 db index, 因为 db 切换在 webview 内完成).

**Redis db 选择**: RedisBrowser 内已有 db 下拉选择器, 默认打开 db0, 用户可在 webview 内切换. 不丢失功能.

**Kafka/RMQ**: KafkaBrowser 和 RmqBrowser 不指定初始 topic/queue 时, 内部已支持显示列表让用户选择.

**需要修改的现有逻辑**:
- `sqlext.connect` command handler: 连接成功后按 driverType 路由打开 webview (目前只对 MongoDB 做了)
- `connectionManager.onDidChange` listener: 泛化为所有 driverType (目前只处理 MongoDB)
- `sqlext.openMongoBrowser` command: 删除, 统一为连接点击路由

**路由函数伪代码** (在 extension.ts 或 table-view-provider.ts 中):

```typescript
function openBrowserForConnection(connectionId: string, connectionName: string, driverType: DriverType): void {
  switch (driverType) {
    case 'mysql':
    case 'postgresql':
      viewProvider.openDbBrowser(connectionId, connectionName, driverType);
      break;
    case 'redis':
      viewProvider.openRedisBrowser(connectionId, 0);
      break;
    case 'kafka':
      viewProvider.openKafkaBrowser(connectionId);
      break;
    case 'rabbitmq':
      viewProvider.openRabbitMQBrowser(connectionId);
      break;
    case 'mongodb':
      viewProvider.openMongoBrowser(connectionId, connectionName, driverType);
      break;
  }
}
```

### 3. DatabaseBrowser webview (新增)

```
DatabaseBrowser
  ├── DatabaseObjectList (左侧面板)
  │   ├── Filter input
  │   └── Database > Table 列表 (分组头 + 列表项, 显示行数)
  ├── Resize handle
  └── 右侧面板
      ├── 未选中: 空状态提示
      └── 选中 table: QueryEditor (复用, autoExecute)
```

#### Filter 逻辑

- `user` -> 跨所有 database, 匹配 table 名包含 "user"
- `prod.user` -> database 名包含 "prod" 且 table 名包含 "user"
- 大小写不敏感
- 过滤后无 table 的 database 分组自动隐藏

#### 右键菜单

- Database 分组头: New Query, Import SQL
- Table 项: Open Table, Edit Table, Show DDL, Dump Struct, Dump Struct and Data, Import SQL

#### 消息协议

**数据加载**:

```typescript
// webview -> extension: 请求所有 database 和 table
interface ListDatabasesAndTablesMessage {
  type: 'listDatabasesAndTables';
}

// extension -> webview: 返回结果
interface DatabaseTableListMessage {
  type: 'databaseTableList';
  databases: Array<{
    name: string;
    tables: Array<{ name: string; rowCount: number }>;
  }>;
  error?: string;
}

// webview -> extension: 刷新 (CREATE/DROP TABLE 后)
interface RefreshDatabasesMessage {
  type: 'refreshDatabases';
}
```

**右键菜单操作** (新增 message types, handler 在 `table-view-provider.ts` 中实现, 调用 extension.ts 中已有的底层逻辑):

```typescript
// Show DDL
interface ShowTableDDLMessage {
  type: 'showTableDDL';
  database: string;
  table: string;
}

// Dump Struct / Dump Struct and Data
interface DumpTableMessage {
  type: 'dumpTable';
  database: string;
  table: string;
  includeData: boolean;
}

// Import SQL
interface ImportSqlMessage {
  type: 'importSql';
  database: string;
  table?: string; // 可选, 不传时 import 到 database 级别
}

// Edit Table (打开 edit-table webview)
interface EditTableMessage {
  type: 'editTable';
  database: string;
  table: string;
}

// New Query (打开 query webview)
interface NewQueryMessage {
  type: 'newQuery';
  database: string;
}
```

**Loading/Error 状态**: DatabaseBrowser 有 `loading` 状态, 加载 database/table 列表时显示 spinner. 网络错误时显示 error 信息.

**操作结果反馈**: DDL/dump/import 等操作的结果通过 `vscode.window.showInformationMessage` / `showErrorMessage` 通知用户 (在 extension host 中, 不需要回传 webview). Import 成功后, handler 自动向 webview post `databaseTableList` 消息触发左侧列表刷新.

**ViewType 新增**: `webview-ui/src/types/messages.ts` 的 `ViewType` union 新增 `'db-browser'`.

**TableViewProvider 新增方法**:

```typescript
openDbBrowser(connectionId: string, connectionName: string, driverType: DriverType): void
```

### 4. 删除清单

#### tree-items.ts
删除: `DatabaseTreeItem`, `TableTreeItem`, `ColumnTreeItem`, `RedisDbTreeItem`, `RedisKeyTreeItem`, `RedisKeyGroupTreeItem`, `MoreKeysTreeItem`, `KafkaTopicTreeItem`, `RabbitMQQueueTreeItem`, `MongoDatabaseTreeItem`, `MongoCollectionTreeItem`.
保留: `ConnectionTreeItem`.

#### connection-tree-provider.ts
删除: `getDatabaseItems`, `getTableItems`, `getColumnItems`, `getRedisDbItems`, `getRedisKeyItems`, `subdivideRedisKeys`, `getKafkaTopicItems`, `getRabbitMQQueueItems`, `getMongoDatabaseItems`, `getMongoCollectionItems`.

#### package.json
- commands: 删除从 sidebar 触发的 commands: `sqlext.openRedisDb`, `sqlext.refreshRedisDb`, `sqlext.deleteRedisKey`, `sqlext.openKafkaTopic`, `sqlext.openRabbitMQQueue`, `sqlext.mongoCreateCollection`, `sqlext.mongoDropCollection`, `sqlext.openRedisKey`, `sqlext.exportRedisDb`, `sqlext.importRedisDb` (操作迁移到 webview 内部, Redis/MongoDB browser webview 已有替代)
- commands: 保留但修改 handler: `sqlext.openTable`, `sqlext.editTable`, `sqlext.showTableDDL`, `sqlext.dumpStruct`, `sqlext.dumpStructAndData`, `sqlext.importSql`, `sqlext.newQuery` -- 移除 `instanceof TreeItem` 检查, 改为接受 `{ connectionId, database, table }` 参数 (同时支持 command palette 和 webview message 调用)
- commands: 删除 `sqlext.openMongoBrowser` (统一为连接点击路由)
- menus.view/item/context: 删除所有非 `connection-*` 的 viewItem 菜单项

#### extension.ts
- `sqlext.connect` command: 泛化连接成功后的 webview 打开逻辑 (目前仅 MongoDB)
- `connectionManager.onDidChange` listener: 泛化为所有 driverType
- 删除对 `DatabaseTreeItem`, `TableTreeItem` 等已删类型的 instanceof 检查

#### 测试
- `tree-items.test.ts`: 删除已删 TreeItem 类型的测试
- `connection-tree-provider.test.ts`: 更新为只测 flat 连接列表行为

### 5. 有意的取舍

- **Column 信息不再在左侧面板显示**: 当前 sidebar 可展开到 column 级别查看字段名/类型/PK/nullable. 重构后需要通过 Show DDL 或 Edit Table 查看. 这是有意简化, column 信息在右侧数据表的列头已有基本体现.
- **Redis export/import 不从 sidebar 触发**: Redis browser webview 内部已有 export/import 功能 (`redisExportKeys` / `redisImport` message handler), sidebar 的 command 可安全删除.

### 6. 不变的部分

- SchemaService: DatabaseBrowser 的 message handler 使用
- 各 driver: 不改
- Redis/Kafka/RMQ/MongoDB 的 browser webview: 不改, 只改 sidebar 触发方式
- QueryEditor / DataGrid 组件: 复用
- MCP server: 不受影响

## New Files

- `webview-ui/src/components/db-browser/DatabaseBrowser.tsx`
- `webview-ui/src/components/db-browser/DatabaseObjectList.tsx`
- `webview-ui/src/styles/db-browser.css`

## Modified Files

- `src/providers/connection-tree-provider.ts` -- 删除所有展开逻辑
- `src/providers/tree-items.ts` -- 删除非 Connection 的 TreeItem 类型
- `src/providers/table-view-provider.ts` -- 新增 `db-browser` viewType handler
- `src/extension.ts` -- 统一连接点击路由
- `webview-ui/src/App.tsx` -- 新增 `db-browser` view case
- `webview-ui/src/types/messages.ts` -- 新增消息类型
- `package.json` -- 清理 commands 和 menus
- `src/providers/tree-items.test.ts` -- 更新测试
- `src/providers/connection-tree-provider.test.ts` -- 更新测试
