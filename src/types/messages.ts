import type { ConnectionConfig, DriverType } from './connection.js';
import type { AlterTableChanges, ColumnInfo, DetailedColumnInfo } from './query.js';
import type { RedisKeyInfo, RedisKeyType, RedisValue } from './redis.js';
import type { KafkaTopicInfo, KafkaPartitionInfo, KafkaMessage, KafkaProduceResult } from './kafka.js';
import type { RabbitMQQueueInfo, RabbitMQMessage } from './rabbitmq.js';

export interface ConnectionFormSSH {
  readonly sshEnabled: boolean;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUsername: string;
  readonly sshAuthType: 'password' | 'privateKey';
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
}

export interface UpdateConnectionConfig extends SaveConnectionConfig {
  readonly id: string;
}

// 镜像 webview-ui src/types/messages.ts 的同名 interface (两 package 各一份, 须手动保持同步)
export interface MongoExplainSummary {
  readonly stage: string;
  readonly indexName?: string;
  readonly docsExamined: number;
  readonly keysExamined: number;
  readonly nReturned: number;
  readonly executionTimeMillis: number;
  readonly isCollScan: boolean;
}

// Extension -> Webview
export type ExtensionMessage =
  | { type: 'tableData'; columns: ColumnInfo[]; rows: Record<string, unknown>[]; total: number; offset: number; limit: number }
  | { type: 'queryResult'; columns: ColumnInfo[]; rows: Record<string, unknown>[]; affectedRows: number; executionTime: number; error?: string }
  | { type: 'columnsResult'; columns: ColumnInfo[] }
  | { type: 'batchUpdateResult'; success: boolean; error?: string }
  | { type: 'insertRowResult'; success: boolean; error?: string }
  | { type: 'connectionTestResult'; success: boolean; error?: string }
  | { type: 'connectionList'; connections: ConnectionConfig[] }
  | { type: 'error'; message: string }
  | { type: 'viewInit'; view: ViewType; context?: Record<string, unknown> }
  | { type: 'schemaInfo'; schema: Record<string, string[]> }
  | { type: 'tableDetails'; columns: DetailedColumnInfo[]; tableName: string }
  | { type: 'alterTableResult'; success: boolean; error?: string; ddlPreview?: string }
  | { type: 'redisScanResult'; keys: readonly RedisKeyInfo[]; cursor: string; done: boolean }
  | { type: 'redisValueResult'; key: string; keyType: RedisKeyType; value: RedisValue; ttl: number }
  | { type: 'redisOperationResult'; success: boolean; error?: string }
  | { type: 'redisDbList'; databases: readonly { readonly index: number; readonly keyCount: number }[] }
  | { type: 'redisDeleteKeysResult'; success: boolean; deletedKeys: readonly string[] }
  | { type: 'redisCommandResult'; output: string }
  | { type: 'redisHashScanResult'; key: string; cursor: string; fields: Record<string, string>; done: boolean }
  | { type: 'redisImportResult'; success: boolean; importedCount?: number; error?: string }
  | { type: 'redisAddKeyResult'; key: string }
  | { type: 'kafkaTopicList'; topics: readonly KafkaTopicInfo[] }
  | { type: 'kafkaPartitionList'; topic: string; partitions: readonly KafkaPartitionInfo[] }
  | { type: 'kafkaMessageList'; topic: string; partition: number; messages: readonly KafkaMessage[] }
  | { type: 'kafkaProduceResult'; success: boolean; partition?: number; offset?: string; error?: string }
  | { type: 'rmqQueueList'; queues: readonly RabbitMQQueueInfo[] }
  | { type: 'rmqMessageList'; queue: string; messages: readonly RabbitMQMessage[] }
  | { type: 'mongoDatabaseList'; databases: readonly string[] }
  | { type: 'mongoCollectionList'; collections: readonly { readonly name: string; readonly count: number }[] }
  | { type: 'mongoDocumentList'; columns: readonly ColumnInfo[]; rows: readonly Record<string, unknown>[]; total: number; error?: string }
  | { type: 'mongoAllCollectionList'; collections: readonly { readonly database: string; readonly name: string; readonly count: number }[] }
  | { type: 'mongoOperationResult'; success: boolean; error?: string; affectedRows?: number }
  | { type: 'mongoExportResult'; success: boolean; count?: number; error?: string }
  | { type: 'mongoImportResult'; success: boolean; inserted?: number; error?: string }
  | { type: 'mongoCollectionCreated'; success: boolean; error?: string }
  | { type: 'mongoCollectionDropped'; success: boolean; database?: string; collection?: string; error?: string }
  | { type: 'mongoQueryResult'; columns: readonly ColumnInfo[]; rows: readonly Record<string, unknown>[]; affectedRows: number; executionTime: number; truncated: boolean; error?: string }
  | { type: 'mongoExplainResult'; summary?: MongoExplainSummary; error?: string }
  | { type: 'databaseTableList'; databases: readonly { readonly name: string; readonly tables: readonly { readonly name: string; readonly rowCount: number }[] }[]; error?: string };

// Webview -> Extension
export type WebviewMessage =
  | { type: 'fetchRows'; database: string; table: string; offset: number; limit: number }
  | { type: 'insertRow'; database: string; table: string; row: Record<string, unknown> }
  | { type: 'updateRow'; database: string; table: string; primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }
  | { type: 'deleteRows'; database: string; table: string; primaryKeys: Record<string, unknown>[] }
  | { type: 'executeQuery'; database: string; sql: string }
  | { type: 'cancelQuery' }
  | { type: 'requestSchema'; database: string }
  | { type: 'refreshSchema'; database: string }
  | { type: 'testConnection'; config: ConnectionFormBase }
  | { type: 'saveConnection'; config: SaveConnectionConfig }
  | { type: 'updateConnection'; config: UpdateConnectionConfig }
  | { type: 'listColumns'; database: string; table: string }
  | { type: 'batchUpdate'; database: string; table: string; updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[] }
  | { type: 'fetchTableDetails'; database: string; table: string }
  | { type: 'previewAlterTable'; database: string; table: string; changes: AlterTableChanges }
  | { type: 'alterTable'; database: string; table: string; changes: AlterTableChanges }
  | { type: 'exportCsv'; content: string; defaultFileName: string }
  | { type: 'ready' }
  | { type: 'redisScan'; database: number; pattern: string; cursor: string; count: number }
  | { type: 'redisGetValue'; key: string; database: number; setCursor?: string; listStart?: number; zsetStart?: number }
  | { type: 'redisSetString'; key: string; value: string; database: number; ttl?: number }
  | { type: 'redisHashSet'; key: string; field: string; value: string; database: number }
  | { type: 'redisHashDelete'; key: string; field: string; database: number }
  | { type: 'redisListPush'; key: string; value: string; position: 'head' | 'tail'; database: number }
  | { type: 'redisListSet'; key: string; index: number; value: string; database: number }
  | { type: 'redisListRemove'; key: string; index: number; database: number }
  | { type: 'redisListBatchSet'; key: string; entries: ReadonlyArray<{ readonly index: number; readonly value: string }>; database: number }
  | { type: 'redisSetAdd'; key: string; member: string; database: number }
  | { type: 'redisSetRemove'; key: string; member: string; database: number }
  | { type: 'redisZSetAdd'; key: string; member: string; score: number; database: number }
  | { type: 'redisZSetRemove'; key: string; member: string; database: number }
  | { type: 'redisSetEdit'; key: string; oldMember: string; newMember: string; database: number }
  | { type: 'redisHashBatchSet'; key: string; entries: ReadonlyArray<{ field: string; value: string }>; database: number }
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
  | { type: 'redisExportKeys'; keys: readonly string[]; database: number }
  | { type: 'redisImport'; database: number }
  | { type: 'redisAddKeyPrompt'; database: number }
  | { type: 'kafkaListTopics' }
  | { type: 'kafkaGetPartitions'; topic: string }
  | { type: 'kafkaFetchMessages'; topic: string; partition: number; offset: string; limit: number }
  | { type: 'kafkaFetchByTimestamp'; topic: string; partition: number; timestamp: number; limit: number }
  | { type: 'kafkaProduceMessage'; topic: string; key: string | null; value: string; headers: Record<string, string>; partition?: number }
  | { type: 'rmqListQueues' }
  | { type: 'rmqPeekMessages'; queue: string; count: number }
  | { type: 'mongoListDatabases' }
  | { type: 'mongoListCollections'; database: string }
  | { type: 'mongoFindDocuments'; database: string; collection: string; filter: string; sort: string; projection?: string; skip: number; limit: number }
  | { type: 'mongoCountDocuments'; database: string; collection: string; filter: string }
  | { type: 'mongoListAllCollections' }
  | { type: 'mongoInsertDocument'; database: string; collection: string; document: Record<string, unknown> }
  | { type: 'mongoUpdateDocument'; database: string; collection: string; id: string; document: Record<string, unknown> }
  | { type: 'mongoUpdateField'; database: string; collection: string; id: string; path: string; value: unknown }
  | { type: 'mongoExplainQuery'; database: string; collection: string; filter: string; sort: string }
  | { type: 'mongoDeleteDocument'; database: string; collection: string; id: string }
  | { type: 'mongoExportCollection'; database: string; collection: string; filter: string; sort: string; projection?: string }
  | { type: 'mongoImportCollection'; database: string; collection: string }
  | { type: 'mongoCreateCollection'; database: string; collection: string }
  | { type: 'mongoDropCollection'; database: string; collection: string }
  | { type: 'mongoRunQuery'; database: string; query: string }
  | { type: 'mongoCancelQuery' }
  | { type: 'listDatabasesAndTables' }
  | { type: 'refreshDatabases' }
  | { type: 'showTableDDL'; database: string; table: string }
  | { type: 'dumpTable'; database: string; table: string; includeData: boolean }
  | { type: 'importSql'; database: string; table?: string }
  | { type: 'editTable'; database: string; table: string }
  | { type: 'newQuery'; database: string };

export type ViewType = 'table' | 'query' | 'connection-form' | 'edit-table' | 'redis-browser' | 'kafka-browser' | 'rmq-browser' | 'mongo-browser' | 'mongo-query' | 'db-browser';
