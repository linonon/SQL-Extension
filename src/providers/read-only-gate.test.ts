import { describe, it, expect } from 'vitest';
import { readOnlyRejection } from './read-only-gate';
import type { WebviewMessage } from '../types/messages';

const reason = 'Connection release is read-only';
const reject = (m: object) => readOnlyRejection(m as WebviewMessage, reason);

describe('readOnlyRejection', () => {
  it('写消息回各自的失败回执, 让 webview 结束等待', () => {
    expect(reject({ type: 'batchUpdate' })).toEqual({ type: 'batchUpdateResult', success: false, error: reason });
    expect(reject({ type: 'alterTable' })).toEqual({ type: 'alterTableResult', success: false, error: reason });
    expect(reject({ type: 'mongoDeleteDocument' })).toEqual({ type: 'mongoOperationResult', success: false, error: reason });
    expect(reject({ type: 'kafkaProduceMessage' })).toEqual({ type: 'kafkaProduceResult', success: false, error: reason });
    // 宿主弹框的写入口, 以及 webview 只处理成功回执的写消息: 不回执 (null), 由宿主弹提示
    for (const type of ['importSql', 'redisAddKeyPrompt', 'redisImport', 'mongoImportCollection', 'redisDeleteKeys']) {
      expect(reject({ type })).toBeNull();
    }
  });

  it('SQL / Mongo / Redis / Kafka 的每个写消息都被拦', () => {
    const writes = [
      'insertRow', 'deleteRows', 'batchUpdate', 'alterTable', 'importSql',
      'mongoInsertDocument', 'mongoUpdateDocument', 'mongoCloneDocument', 'mongoDeleteDocument',
      'mongoImportCollection', 'mongoCreateCollection', 'mongoDropCollection',
      'redisSetString', 'redisHashDelete', 'redisListPush', 'redisListRemove', 'redisListBatchSet',
      'redisSetAdd', 'redisSetRemove', 'redisZSetAdd', 'redisZSetRemove', 'redisSetBatchEdit',
      'redisHashBatchEdit', 'redisZSetBatchEdit', 'redisDeleteKeys', 'redisSetTTLPrompt',
      'redisImport', 'redisAddKeyPrompt', 'kafkaProduceMessage',
    ];
    expect(writes.filter((type) => reject({ type }) === undefined)).toEqual([]);
  });

  it('读消息放行: 查询 / 浏览 / 导出 / dump / executeQuery (由只读会话兜底)', () => {
    const reads = [
      'executeQuery', 'listColumns', 'fetchTableDetails', 'previewAlterTable', 'dumpTable', 'exportCsv',
      'listDatabasesAndTables', 'showTableDDL', 'editTable', 'newQuery',
      'mongoFindDocuments', 'mongoListAllCollections', 'mongoExplainQuery', 'mongoExportCollection',
      'redisScan', 'redisGetValue', 'redisHashScan', 'redisListDatabases', 'redisExportPattern', 'redisExportKey',
      'kafkaListTopics', 'kafkaGetPartitions', 'kafkaFetchMessages', 'kafkaFetchLatest', 'kafkaFetchByTimestamp',
    ];
    expect(reads.filter((type) => reject({ type }) !== undefined)).toEqual([]);
  });

  it('Redis 命令栏: 只读命令白名单放行, 其余 (含清库) 写进命令输出', () => {
    expect(reject({ type: 'redisExecuteCommand', command: 'hscan user:1 0 COUNT 100' })).toBeUndefined();
    expect(reject({ type: 'redisExecuteCommand', command: 'XRANGE s - + COUNT 100' })).toBeUndefined();
    expect(reject({ type: 'redisExecuteCommand', command: 'SET k "v"' })).toEqual({
      type: 'redisCommandResult', output: `(error) ${reason}: SET is not a read command`,
    });
    expect(reject({ type: 'redisExecuteCommand', command: 'flushdb async' })).toMatchObject({ type: 'redisCommandResult' });
  });
});
