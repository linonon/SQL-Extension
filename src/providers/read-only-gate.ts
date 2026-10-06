import type { WebviewMessage } from '../types/messages.js';
import { REDIS_READ_COMMANDS } from '../services/query-router.js';
import { parseCommandArgs } from './redis-message-handler.js';

type Reply = Record<string, unknown>;

const failed = (type: string) => (error: string): Reply => ({ type, success: false, error });
// 宿主侧弹输入框 / 文件框的写消息: webview 不在等回执, 只弹提示
const noReply = (): null => null;

// 会写数据的 webview 消息 -> 拒绝时回给 webview 的回执 (结束它的等待状态)
const WRITE_MESSAGE_REPLIES: Partial<Record<WebviewMessage['type'], (reason: string) => Reply | null>> = {
  insertRow: failed('insertRowResult'),
  deleteRows: failed('deleteRowsResult'),
  batchUpdate: failed('batchUpdateResult'),
  alterTable: failed('alterTableResult'),
  importSql: noReply,
  mongoInsertDocument: failed('mongoOperationResult'),
  mongoUpdateDocument: failed('mongoOperationResult'),
  mongoCloneDocument: failed('mongoOperationResult'),
  mongoDeleteDocument: failed('mongoOperationResult'),
  mongoImportCollection: failed('mongoImportResult'),
  mongoCreateCollection: failed('mongoCollectionCreated'),
  mongoDropCollection: failed('mongoCollectionDropped'),
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
  redisSetTTL: failed('redisOperationResult'),
  redisRemoveTTL: failed('redisOperationResult'),
  redisDeleteKeys: (error) => ({ type: 'redisDeleteKeysResult', success: false, deletedKeys: [], error }),
  redisSetTTLPrompt: noReply,
  redisAddKeyPrompt: noReply,
  redisImport: failed('redisImportResult'),
  kafkaProduceMessage: failed('kafkaProduceResult'),
};

/**
 * 只读连接上收到 message 时的拒绝回执; null 表示拒绝但无需回执, 不是写消息 (可以照常处理) 返回 undefined.
 * Redis 命令栏按 MCP db_read 同一份只读命令白名单放行, 其余命令一律当写.
 * 读消息 (查询 / 导出 / dump / executeQuery) 不在此列: executeQuery 由只读会话兜底.
 */
export function readOnlyRejection(message: WebviewMessage, reason: string): Reply | null | undefined {
  if (message.type === 'redisExecuteCommand') {
    const cmd = parseCommandArgs(message.command)[0]?.toUpperCase() ?? '';
    return REDIS_READ_COMMANDS.has(cmd) ? undefined : { type: 'redisCommandResult', output: `(error) ${reason}: ${cmd} is not a read command` };
  }
  return WRITE_MESSAGE_REPLIES[message.type]?.(reason);
}
