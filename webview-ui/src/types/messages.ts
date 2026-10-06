import type { AlterTableChanges, ColumnInfo, DetailedColumnInfo } from './database';
import type { RedisKeyInfo, RedisKeyType, RedisValue } from './redis';
import type { KafkaTopicInfo, KafkaPartitionInfo, KafkaMessage } from './kafka';

export type DriverType = 'mysql' | 'postgresql' | 'redis' | 'mongodb' | 'kafka' | 'rabbitmq';
export type SSHAuthType = 'password' | 'privateKey';
export type ViewType = 'query' | 'connection-form' | 'edit-table' | 'redis-browser' | 'kafka-browser' | 'mongo-browser' | 'db-browser';

export interface ConnectionFormSSH {
  readonly sshEnabled: boolean;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUsername: string;
  readonly sshAuthType: SSHAuthType;
  readonly sshPassword: string;
  readonly sshPrivateKeyPath: string;
}

interface ConnectionFormBase extends ConnectionFormSSH {
  readonly driverType: DriverType;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly authSource?: string;
  readonly separator?: string;
}

export interface SaveConnectionConfig extends ConnectionFormBase {
  readonly name: string;
  readonly readOnly: boolean;
}

// 编辑表单拿不到已存的密码: password / sshPassword 为空串表示保留已存的值
export interface UpdateConnectionConfig extends SaveConnectionConfig {
  readonly id: string;
}

// 镜像 ext-host src/types/messages.ts 的同名 interface (两 package 各一份, 须手动保持同步)
export interface MongoExplainSummary {
  readonly stage: string;
  readonly indexName?: string;
  readonly isCollScan: boolean;
}

export type StatementStatus = 'ok' | 'error' | 'skipped';

export interface StatementResult {
  readonly index: number;
  readonly sql: string;
  readonly status: StatementStatus;
  readonly executionTime?: number;
  readonly affectedRows?: number;
  readonly columns?: ColumnInfo[];
  readonly rows?: Record<string, unknown>[];
  readonly error?: string;
  // 结果集语句才有: 语句返回的总行数. rows 只在网格展示的那个结果集上带, 至多 RESULT_ROW_CAP 行, truncated 表示截掉了尾部
  readonly rowCount?: number;
  readonly truncated?: boolean;
}

// Extension -> Webview
export type ExtensionMessage =
  | { type: 'mongoExplainResult'; summary?: MongoExplainSummary; error?: string }
  | { type: 'queryResult'; requestId: number; columns: ColumnInfo[]; rows: Record<string, unknown>[]; affectedRows: number; executionTime: number; error?: string }
  | { type: 'queryBatchResult'; requestId: number; statements: StatementResult[]; warning?: string }
  | { type: 'columnsResult'; requestId: number; columns: ColumnInfo[] }
  | { type: 'batchUpdateResult'; success: boolean; error?: string }
  | { type: 'insertRowResult'; success: boolean; error?: string }
  | { type: 'deleteRowsResult'; success: boolean; error?: string; cancelled?: boolean }
  | { type: 'connectionTestResult'; success: boolean; error?: string }
  | { type: 'error'; message: string }
  | { type: 'viewInit'; view: ViewType; context?: Record<string, unknown> }
  | { type: 'schemaInfo'; schema: Record<string, string[]> }
  | { type: 'aiChunk'; id: string; text: string }
  | { type: 'aiDone'; id: string; model?: string; error?: string }
  | { type: 'aiModels'; models: { id: string; name: string }[]; selected: string; error?: string }
  | { type: 'tableDetails'; columns: DetailedColumnInfo[]; tableName: string }
  | { type: 'alterTableResult'; success: boolean; error?: string }
  // previewAlterTable 的回执: ddl 为空串表示没有改动
  | { type: 'alterTablePreview'; ddl: string }
  // scanned: 本次请求扫过的 key 数估值; keys 为空且 done 为 false 表示这一段没匹配到, 可从 cursor 接着扫
  | { type: 'redisScanResult'; requestId: number; keys: readonly RedisKeyInfo[]; cursor: string; done: boolean; scanned: number }
  | { type: 'redisValueResult'; key: string; database: number; keyType: RedisKeyType; value: RedisValue; ttl: number }
  | { type: 'redisOperationResult'; success: boolean; error?: string }
  | { type: 'redisDeleteKeysResult'; success: boolean; deletedKeys: readonly string[] }
  | { type: 'redisDbList'; databases: readonly { readonly index: number; readonly keyCount: number }[] }
  | { type: 'redisCommandResult'; output: string }
  | { type: 'redisHashScanResult'; key: string; database: number; cursor: string; fields: Record<string, string>; done: boolean }
  | { type: 'redisImportResult'; success: boolean; importedCount?: number; error?: string }
  | { type: 'redisAddKeyResult'; key: string }
  // kafka 列表类回执带 error 表示该请求失败 (列表为空)
  | { type: 'kafkaTopicList'; topics: readonly KafkaTopicInfo[]; error?: string }
  | { type: 'kafkaPartitionList'; topic: string; partitions: readonly KafkaPartitionInfo[]; error?: string }
  // timedOut: 加入 group 后等满 3 秒一条消息也没收到
  | { type: 'kafkaMessageList'; topic: string; partition: number; messages: readonly KafkaMessage[]; timedOut: boolean; error?: string }
  | { type: 'kafkaProduceResult'; success: boolean; partition?: number; offset?: string; error?: string }
  | { type: 'mongoDocumentList'; requestId: number; columns: readonly ColumnInfo[]; rows: readonly Record<string, unknown>[]; error?: string }
  // mongoFindDocuments 带 count 时另发: total 为 null 表示计数失败或超时 (总数未知)
  | { type: 'mongoDocumentCount'; requestId: number; total: number | null }
  | { type: 'mongoAllCollectionList'; collections: readonly { readonly database: string; readonly name: string; readonly count: number }[] }
  | { type: 'mongoOperationResult'; success: boolean; error?: string; affectedRows?: number; message?: string }
  | { type: 'mongoExportResult'; success: boolean; count?: number; error?: string }
  | { type: 'mongoImportResult'; success: boolean; inserted?: number; error?: string }
  | { type: 'mongoCollectionCreated'; success: boolean; error?: string }
  | { type: 'mongoCollectionDropped'; success: boolean; database?: string; collection?: string; error?: string }
  | { type: 'databaseTableList'; databases: readonly { readonly name: string; readonly tables: readonly { readonly name: string; readonly rowCount: number }[] }[]; error?: string };

// Webview -> Extension
export type WebviewMessage =
  | { type: 'insertRow'; database: string; table: string; row: Record<string, unknown> }
  | { type: 'deleteRows'; database: string; table: string; primaryKeys: Record<string, unknown>[] }
  | { type: 'executeQuery'; requestId: number; database: string; sql: string }
  | { type: 'cancelQuery' }
  // lastError: 编辑器上一次执行失败时的报错
  | { type: 'aiAsk'; id: string; database: string; question: string; sql: string; selection: string; lastError?: string }
  | { type: 'aiCancel' }
  | { type: 'aiListModels' }
  | { type: 'aiSetModel'; id: string }
  | { type: 'requestSchema'; database: string }
  | { type: 'refreshSchema'; database: string }
  // 从编辑表单发出时, 留空的密码由宿主取 panel 所编辑连接的已存值
  | { type: 'testConnection'; config: ConnectionFormBase }
  | { type: 'saveConnection'; config: SaveConnectionConfig }
  | { type: 'updateConnection'; config: UpdateConnectionConfig }
  | { type: 'listColumns'; requestId: number; database: string; table: string }
  | { type: 'batchUpdate'; database: string; table: string; updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[] }
  | { type: 'fetchTableDetails'; database: string; table: string }
  | { type: 'previewAlterTable'; database: string; table: string; changes: AlterTableChanges }
  | { type: 'alterTable'; database: string; table: string; changes: AlterTableChanges }
  | { type: 'exportCsv'; content: string; defaultFileName: string }
  | { type: 'ready' }
  // count: 本次请求期望凑够的 key 数 (宿主循环 SCAN 直到凑够或扫满预算)
  | { type: 'redisScan'; requestId: number; database: number; pattern: string; cursor: string; count: number }
  | { type: 'redisGetValue'; key: string; database: number; setCursor?: string; listStart?: number; zsetStart?: number }
  | { type: 'redisSetString'; key: string; value: string; database: number; ttl?: number }
  | { type: 'redisHashDelete'; key: string; field: string; database: number }
  | { type: 'redisListPush'; key: string; value: string; position: 'head' | 'tail'; database: number }
  | { type: 'redisListRemove'; key: string; index: number; database: number }
  | { type: 'redisListBatchSet'; key: string; entries: ReadonlyArray<{ readonly index: number; readonly value: string }>; database: number }
  | { type: 'redisSetAdd'; key: string; member: string; database: number }
  | { type: 'redisSetRemove'; key: string; member: string; database: number }
  | { type: 'redisZSetAdd'; key: string; member: string; score: number; database: number }
  | { type: 'redisZSetRemove'; key: string; member: string; database: number }
  | { type: 'redisSetBatchEdit'; key: string; edits: ReadonlyArray<{ oldMember: string; newMember: string }>; database: number }
  | { type: 'redisHashBatchEdit'; key: string; edits: ReadonlyArray<{ oldField: string; newField: string; value: string }>; database: number }
  | { type: 'redisZSetBatchEdit'; key: string; edits: ReadonlyArray<{ oldMember: string; newMember: string; score: number }>; database: number }
  | { type: 'redisDeleteKeys'; keys: readonly string[]; database: number }
  | { type: 'redisSetTTLPrompt'; key: string; database: number }
  | { type: 'redisSetTTL'; key: string; ttl: number; database: number }
  | { type: 'redisRemoveTTL'; key: string; database: number }
  | { type: 'redisExecuteCommand'; command: string; database: number }
  | { type: 'redisHashScan'; key: string; database: number; cursor: string; count: number }
  | { type: 'redisListDatabases' }
  | { type: 'redisExportPattern'; database: number; pattern: string }
  | { type: 'redisExportKey'; database: number; key: string }
  | { type: 'redisImport'; database: number }
  | { type: 'redisAddKeyPrompt'; database: number }
  | { type: 'kafkaListTopics' }
  | { type: 'kafkaGetPartitions'; topic: string }
  | { type: 'kafkaFetchMessages'; topic: string; partition: number; offset: string; limit: number }
  // 宿主现取 high watermark, 拉最后 limit 条
  | { type: 'kafkaFetchLatest'; topic: string; partition: number; limit: number }
  | { type: 'kafkaFetchByTimestamp'; topic: string; partition: number; timestamp: number; limit: number }
  | { type: 'kafkaProduceMessage'; topic: string; key: string | null; value: string; headers: Record<string, string>; partition?: number }
  | { type: 'mongoFindDocuments'; requestId: number; database: string; collection: string; filter: string; sort: string; projection?: string; skip: number; limit: number; count: boolean }
  | { type: 'mongoListAllCollections' }
  | { type: 'mongoInsertDocument'; database: string; collection: string; document: Record<string, unknown> }
  // 编辑保存 / Clone: original 是编辑器打开时的文档, document 是编辑结果, 宿主按 path 对比后只写改动.
  // id / sourceId 是行 _id 还原成的 EJSON 值 (按真实类型定位文档)
  | { type: 'mongoUpdateDocument'; database: string; collection: string; id: unknown; original: Record<string, unknown>; document: Record<string, unknown> }
  | { type: 'mongoCloneDocument'; database: string; collection: string; sourceId: unknown; original: Record<string, unknown>; document: Record<string, unknown> }
  | { type: 'mongoExplainQuery'; database: string; collection: string; filter: string; sort: string }
  | { type: 'mongoDeleteDocument'; database: string; collection: string; id: unknown }
  | { type: 'mongoExportCollection'; database: string; collection: string; filter: string; sort: string; projection?: string }
  | { type: 'mongoImportCollection'; database: string; collection: string }
  | { type: 'mongoCreateCollection'; database: string; collection: string }
  | { type: 'mongoDropCollection'; database: string; collection: string }
  | { type: 'listDatabasesAndTables' }
  | { type: 'refreshDatabases' }
  | { type: 'showTableDDL'; database: string; table: string }
  | { type: 'dumpTable'; database: string; table: string; includeData: boolean }
  | { type: 'importSql'; database: string }
  | { type: 'editTable'; database: string; table: string }
  | { type: 'newQuery'; database: string };
