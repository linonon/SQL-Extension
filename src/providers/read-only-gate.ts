import type { ExtensionMessage, WebviewMessage } from '../types/messages.js';
import { REDIS_READ_COMMANDS } from '../services/query-router.js';
import { parseCommandArgs } from './redis-message-handler.js';

type Reply = ExtensionMessage;

// 回执形如 { type, success: false, error } 的消息类型
type FailureType = {
  [K in Reply['type']]: { type: K; success: false; error: string } extends Extract<Reply, { type: K }> ? K : never
}[Reply['type']];

const failed = (type: FailureType) => (error: string): Reply => ({ type, success: false, error });
// webview 不等也不显示失败回执的写消息 (宿主侧弹输入框 / 文件框的, 及只处理成功回执的): 不回执, 由宿主弹提示
const noReply = (): null => null;

// 每个 webview 消息类型的只读分类: 'read' 照常处理; 写消息给出拒绝时回给 webview 的回执 (结束它的等待状态).
// 完整 Record: 新增消息类型不分类就过不了 tsc
const READ_ONLY_POLICY: Record<WebviewMessage['type'], 'read' | ((reason: string) => Reply | null)> = {
  // SQL: executeQuery 由只读会话兜底; 预览 DDL / dump / 导出不写库
  executeQuery: 'read', cancelQuery: 'read', listQueryHistory: 'read', requestSchema: 'read', refreshSchema: 'read',
  listColumns: 'read', fetchTableDetails: 'read', previewAlterTable: 'read', exportCsv: 'read',
  listDatabasesAndTables: 'read', showTableDDL: 'read', dumpTable: 'read', editTable: 'read', newQuery: 'read',
  insertRow: failed('insertRowResult'),
  deleteRows: failed('deleteRowsResult'),
  batchUpdate: failed('batchUpdateResult'),
  alterTable: failed('alterTableResult'),
  importSql: noReply,
  // 连接表单 / Ask AI / 握手: 不碰库里的数据
  ready: 'read', testConnection: 'read', saveConnection: 'read', updateConnection: 'read',
  aiAsk: 'read', aiCancel: 'read', aiListModels: 'read', aiSetModel: 'read',
  mongoFindDocuments: 'read', mongoListAllCollections: 'read', mongoExplainQuery: 'read', mongoExportCollection: 'read',
  mongoInsertDocument: failed('mongoOperationResult'),
  mongoUpdateDocument: failed('mongoOperationResult'),
  mongoCloneDocument: failed('mongoOperationResult'),
  mongoDeleteDocument: failed('mongoOperationResult'),
  mongoImportCollection: noReply,
  mongoCreateCollection: failed('mongoCollectionCreated'),
  mongoDropCollection: failed('mongoCollectionDropped'),
  // redisExecuteCommand 按命令白名单判定, 见 readOnlyRejection
  redisScan: 'read', redisGetValue: 'read', redisHashScan: 'read', redisListDatabases: 'read',
  redisExportPattern: 'read', redisExportKey: 'read', redisExecuteCommand: 'read',
  redisSetString: failed('redisOperationResult'),
  redisHashDelete: failed('redisOperationResult'),
  redisListPush: failed('redisOperationResult'),
  redisListRemove: failed('redisOperationResult'),
  redisListBatchSet: failed('redisOperationResult'),
  redisSetAdd: failed('redisOperationResult'),
  redisSetRemove: failed('redisOperationResult'),
  redisZSetAdd: failed('redisOperationResult'),
  redisZSetRemove: failed('redisOperationResult'),
  redisSetBatchEdit: failed('redisOperationResult'),
  redisHashBatchEdit: failed('redisOperationResult'),
  redisZSetBatchEdit: failed('redisOperationResult'),
  redisDeleteKeys: noReply,
  redisSetTTLPrompt: noReply,
  redisAddKeyPrompt: noReply,
  redisImport: noReply,
  kafkaListTopics: 'read', kafkaGetPartitions: 'read', kafkaFetchMessages: 'read', kafkaFetchLatest: 'read', kafkaFetchByTimestamp: 'read',
  kafkaProduceMessage: failed('kafkaProduceResult'),
};

/**
 * 只读连接上收到 message 时的拒绝回执; null 表示拒绝但无需回执, 不是写消息 (可以照常处理) 返回 undefined.
 * Redis 命令栏按 MCP db_read 同一份只读命令白名单放行, 其余命令一律当写.
 */
export function readOnlyRejection(message: WebviewMessage, reason: string): Reply | null | undefined {
  if (message.type === 'redisExecuteCommand') {
    const cmd = parseCommandArgs(message.command)[0]?.toUpperCase() ?? '';
    return REDIS_READ_COMMANDS.has(cmd) ? undefined : { type: 'redisCommandResult', output: `(error) ${reason}: ${cmd} is not a read command` };
  }
  const policy = READ_ONLY_POLICY[message.type];
  return typeof policy === 'function' ? policy(reason) : undefined;
}
