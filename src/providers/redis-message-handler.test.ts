import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleRedisMessage, parseCommandArgs, exportRedisKeys, importRedisKeys, validateTtlInput } from './redis-message-handler';
import type { IRedisDriver } from '../types/redis-driver';
import type { WebviewMessage } from '../types/messages';

function createMockDriver(): IRedisDriver {
  return {
    driverType: 'redis',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    ping: vi.fn(),
    listDatabases: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue({ cursor: '0', keys: [], scanned: 0 }),
    getString: vi.fn().mockResolvedValue(null),
    hashScan: vi.fn().mockResolvedValue({ cursor: '0', fields: {} }),
    getList: vi.fn().mockResolvedValue([]),
    getSet: vi.fn().mockResolvedValue({ cursor: '0', members: [] }),
    getZSet: vi.fn().mockResolvedValue([]),
    setString: vi.fn(),
    setHashField: vi.fn(),
    deleteHashField: vi.fn(),
    listPush: vi.fn(),
    listSet: vi.fn(),
    listRemove: vi.fn(),
    setAdd: vi.fn(),
    setRemove: vi.fn(),
    zsetAdd: vi.fn(),
    zsetRemove: vi.fn(),
    deleteKey: vi.fn(),
    getKeyType: vi.fn().mockResolvedValue('string'),
    getTTL: vi.fn().mockResolvedValue(-1),
    setTTL: vi.fn(),
    removeTTL: vi.fn(),
    getListLength: vi.fn().mockResolvedValue(0),
    getZSetLength: vi.fn().mockResolvedValue(0),
    scanAllKeys: vi.fn().mockResolvedValue([]),
    readKeyRaw: vi.fn(),
    countExistingKeys: vi.fn().mockResolvedValue(0),
    writeKeyRaw: vi.fn(),
    executeCommandInDb: vi.fn().mockResolvedValue('OK'),
  };
}

describe('parseCommandArgs', () => {
  it('简单空格分割', () => {
    expect(parseCommandArgs('SET key value')).toEqual(['SET', 'key', 'value']);
  });

  it('双引号包裹带空格参数 (#10)', () => {
    expect(parseCommandArgs('SET key "hello world"')).toEqual(['SET', 'key', 'hello world']);
  });

  it('单引号包裹', () => {
    expect(parseCommandArgs("SET key 'hello world'")).toEqual(['SET', 'key', 'hello world']);
  });

  it('多余空格', () => {
    expect(parseCommandArgs('  GET   mykey  ')).toEqual(['GET', 'mykey']);
  });

  it('空字符串', () => {
    expect(parseCommandArgs('')).toEqual([]);
  });

  it('只有一个命令', () => {
    expect(parseCommandArgs('PING')).toEqual(['PING']);
  });

  it('双引号内 \\" 和 \\\\ 转义, 其余反斜杠原样; 空引号保留为空参数', () => {
    expect(parseCommandArgs('SET k "{\\"open\\":true}"')).toEqual(['SET', 'k', '{"open":true}']);
    expect(parseCommandArgs('SET k "a\\\\b\\n"')).toEqual(['SET', 'k', 'a\\b\\n']);
    expect(parseCommandArgs('HSET h f ""')).toEqual(['HSET', 'h', 'f', '']);
    expect(parseCommandArgs("SET k ''")).toEqual(['SET', 'k', '']);
  });
});

describe('handleRedisMessage', () => {
  let driver: IRedisDriver;
  let postMessage: Mock<(msg: unknown) => void>;

  beforeEach(() => {
    driver = createMockDriver();
    postMessage = vi.fn();
  });

  it('非 redis 消息返回 false', async () => {
    const msg = { type: 'executeQuery', database: 'test', sql: 'SELECT 1' } as WebviewMessage;
    const handled = await handleRedisMessage(msg, driver, postMessage);
    expect(handled).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  describe('redisScan', () => {
    it('在消息指定的库上 scan, 返回 redisScanResult', async () => {
      (driver.scan as any).mockResolvedValue({
        cursor: '5',
        keys: [{ key: 'k1', type: 'string', ttl: -1 }],
        scanned: 3000,
      });

      const msg = { type: 'redisScan', requestId: 7, database: 2, pattern: '*', cursor: '0', count: 100 } as WebviewMessage;
      const handled = await handleRedisMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.scan).toHaveBeenCalledWith(2, '*', '0', 100);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisScanResult',
        requestId: 7,
        keys: [{ key: 'k1', type: 'string', ttl: -1 }],
        cursor: '5',
        done: false,
        scanned: 3000,
      });
    });
  });

  describe('redisHashScan', () => {
    it('回执带回 key 与 database, webview 据此丢弃已切走的 key 的分页', async () => {
      (driver.hashScan as any).mockResolvedValue({ cursor: '0', fields: { f2: 'v2' } });

      const msg = { type: 'redisHashScan', key: 'h', database: 5, cursor: '9', count: 100 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.hashScan).toHaveBeenCalledWith(5, 'h', '9', 100);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisHashScanResult', key: 'h', database: 5, cursor: '0', fields: { f2: 'v2' }, done: true,
      });
    });
  });

  describe('redisGetValue', () => {
    it('string 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('string');
      (driver.getString as any).mockResolvedValue('hello');
      (driver.getTTL as any).mockResolvedValue(300);

      const msg = { type: 'redisGetValue', key: 'mykey', database: 4 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisValueResult',
        key: 'mykey',
        database: 4,
        keyType: 'string',
        value: { type: 'string', value: 'hello' },
        ttl: 300,
      });
    });

    it('hash 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('hash');
      (driver.hashScan as any).mockResolvedValue({ cursor: '0', fields: { f1: 'v1' } });

      const msg = { type: 'redisGetValue', key: 'h', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          keyType: 'hash',
          value: { type: 'hash', value: { f1: 'v1' }, cursor: '0' },
        })
      );
    });

    it('list 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('list');
      (driver.getListLength as any).mockResolvedValue(5);
      (driver.getList as any).mockResolvedValue(['a', 'b']);

      const msg = { type: 'redisGetValue', key: 'l', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          value: { type: 'list', value: ['a', 'b'], total: 5, start: 0 },
        })
      );
    });

    it('list / zset 翻页: 回执带回本页起点 start, webview 用 start + i 作 Redis index', async () => {
      (driver.getKeyType as any).mockResolvedValue('list');
      (driver.getListLength as any).mockResolvedValue(250);
      (driver.getList as any).mockResolvedValue(['x']);
      await handleRedisMessage({ type: 'redisGetValue', key: 'l', database: 0, listStart: 200 }, driver, postMessage);
      expect(driver.getList).toHaveBeenCalledWith(0, 'l', 200, 299);
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        value: { type: 'list', value: ['x'], total: 250, start: 200 },
      }));

      (driver.getKeyType as any).mockResolvedValue('zset');
      (driver.getZSetLength as any).mockResolvedValue(150);
      (driver.getZSet as any).mockResolvedValue([{ member: 'm', score: 1 }]);
      await handleRedisMessage({ type: 'redisGetValue', key: 'z', database: 0, zsetStart: 100 }, driver, postMessage);
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        value: { type: 'zset', value: [{ member: 'm', score: 1 }], total: 150, start: 100 },
      }));
    });

    it('浏览器不能编辑的类型: 不读值, 回 unsupported 带 TYPE 原名', async () => {
      (driver.getKeyType as any).mockResolvedValue('ReJSON-RL');
      await handleRedisMessage({ type: 'redisGetValue', key: 'j', database: 0 }, driver, postMessage);
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        keyType: 'unknown',
        value: { type: 'unsupported', typeName: 'ReJSON-RL' },
      }));

      (driver.getKeyType as any).mockResolvedValue('stream');
      await handleRedisMessage({ type: 'redisGetValue', key: 's', database: 0 }, driver, postMessage);
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        keyType: 'stream',
        value: { type: 'unsupported', typeName: 'stream' },
      }));
      expect(driver.getString).not.toHaveBeenCalled();
    });

    it('set 类型用默认 cursor', async () => {
      (driver.getKeyType as any).mockResolvedValue('set');
      (driver.getSet as any).mockResolvedValue({ cursor: '3', members: ['m1'] });

      const msg = { type: 'redisGetValue', key: 's', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.getSet).toHaveBeenCalledWith(0, 's', '0', 100);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          value: { type: 'set', value: ['m1'], cursor: '3' },
        })
      );
    });

    it('set 类型用 setCursor 参数', async () => {
      (driver.getKeyType as any).mockResolvedValue('set');
      (driver.getSet as any).mockResolvedValue({ cursor: '0', members: ['m2'] });

      const msg = { type: 'redisGetValue', key: 's', database: 0, setCursor: '5' } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.getSet).toHaveBeenCalledWith(0, 's', '5', 100);
    });

    it('zset 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('zset');
      (driver.getZSetLength as any).mockResolvedValue(10);
      (driver.getZSet as any).mockResolvedValue([{ member: 'm', score: 1 }]);

      const msg = { type: 'redisGetValue', key: 'z', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          value: { type: 'zset', value: [{ member: 'm', score: 1 }], total: 10, start: 0 },
        })
      );
    });
  });

  describe('写操作', () => {
    it('redisSetString', async () => {
      const msg = { type: 'redisSetString', key: 'k', value: 'v', database: 0, ttl: 60 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.setString).toHaveBeenCalledWith(0, 'k', 'v', 60);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('redisHashDelete', async () => {
      const msg = { type: 'redisHashDelete', key: 'h', field: 'f', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.deleteHashField).toHaveBeenCalledWith(0, 'h', 'f');
    });

    it('redisListPush', async () => {
      const msg = { type: 'redisListPush', key: 'l', value: 'v', position: 'head' as const, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.listPush).toHaveBeenCalledWith(0, 'l', 'v', 'head');
    });

    it('redisSetAdd', async () => {
      const msg = { type: 'redisSetAdd', key: 's', member: 'm', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setAdd).toHaveBeenCalledWith(0, 's', 'm');
    });

    it('redisSetRemove', async () => {
      const msg = { type: 'redisSetRemove', key: 's', member: 'm', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setRemove).toHaveBeenCalledWith(0, 's', 'm');
    });

    it('redisZSetAdd', async () => {
      const msg = { type: 'redisZSetAdd', key: 'z', member: 'm', score: 1.5, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.zsetAdd).toHaveBeenCalledWith(0, 'z', 'm', 1.5);
    });

    it('redisZSetRemove', async () => {
      const msg = { type: 'redisZSetRemove', key: 'z', member: 'm', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.zsetRemove).toHaveBeenCalledWith(0, 'z', 'm');
    });

    it('redisDeleteKeys 多 key', async () => {
      const msg = { type: 'redisDeleteKeys', keys: ['a', 'b', 'c'], database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.deleteKey).toHaveBeenCalledTimes(3);
    });

    it('redisSetTTL', async () => {
      const msg = { type: 'redisSetTTL', key: 'k', ttl: 300, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setTTL).toHaveBeenCalledWith(0, 'k', 300);
    });

    it('redisRemoveTTL', async () => {
      const msg = { type: 'redisRemoveTTL', key: 'k', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.removeTTL).toHaveBeenCalledWith(0, 'k');
    });
  });

  describe('redisListRemove', () => {
    it('调用 driver.listRemove', async () => {
      const msg = { type: 'redisListRemove', key: 'l', index: 1, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.listRemove).toHaveBeenCalledWith(0, 'l', 1);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });
  });

  describe('redisListBatchSet', () => {
    it('循环调用 driver.listSet', async () => {
      const entries = [{ index: 0, value: 'a' }, { index: 2, value: 'c' }];
      const msg = { type: 'redisListBatchSet', key: 'l', entries, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.listSet).toHaveBeenCalledTimes(2);
      expect(driver.listSet).toHaveBeenCalledWith(0, 'l', 0, 'a');
      expect(driver.listSet).toHaveBeenCalledWith(0, 'l', 2, 'c');
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('部分失败时收集错误', async () => {
      (driver.listSet as any)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('index out of range'));
      const entries = [{ index: 0, value: 'ok' }, { index: 99, value: 'bad' }];
      const msg = { type: 'redisListBatchSet', key: 'l', entries, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisOperationResult',
        success: false,
        error: expect.stringContaining('[99]'),
      });
    });
  });

  describe('redisExecuteCommand (#4)', () => {
    it('应该发 redisCommandResult 而不是 redisValueResult', async () => {
      (driver.executeCommandInDb as any).mockResolvedValue('PONG');

      const msg = { type: 'redisExecuteCommand', command: 'PING', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisCommandResult',
        output: 'PONG',
      });
    });

    it('非 string 结果 JSON 序列化', async () => {
      (driver.executeCommandInDb as any).mockResolvedValue([1, 2, 3]);

      const msg = { type: 'redisExecuteCommand', command: 'KEYS *', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisCommandResult',
        output: JSON.stringify([1, 2, 3], null, 2),
      });
    });

    it('引号参数应该被正确解析 (#10)', async () => {
      const msg = { type: 'redisExecuteCommand', command: 'SET key "hello world"', database: 3 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      // 在消息指定库的一次性连接上跑, 不碰浏览用的 client
      expect(driver.executeCommandInDb).toHaveBeenCalledWith(3, ['SET', 'key', 'hello world']);
    });
  });

  describe('redisListDatabases', () => {
    it('调用 listDatabases 发 redisDbList', async () => {
      (driver.listDatabases as any).mockResolvedValue([
        { index: 0, keyCount: 10 },
        { index: 1, keyCount: 0 },
      ]);

      const msg = { type: 'redisListDatabases' } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisDbList',
        databases: [
          { index: 0, keyCount: 10 },
          { index: 1, keyCount: 0 },
        ],
      });
    });
  });

  describe('redisHashBatchEdit', () => {
    it('rename: 先 setHashField 再 deleteHashField', async () => {
      const edits = [{ oldField: 'f1', newField: 'f2', value: 'val' }];
      const msg = { type: 'redisHashBatchEdit', key: 'h', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      const setCall = (driver.setHashField as any).mock.invocationCallOrder[0];
      const delCall = (driver.deleteHashField as any).mock.invocationCallOrder[0];
      expect(driver.setHashField).toHaveBeenCalledWith(0, 'h', 'f2', 'val');
      expect(driver.deleteHashField).toHaveBeenCalledWith(0, 'h', 'f1');
      expect(setCall).toBeLessThan(delCall);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('纯 value edit: 不调 deleteHashField', async () => {
      const edits = [{ oldField: 'f1', newField: 'f1', value: 'newval' }];
      const msg = { type: 'redisHashBatchEdit', key: 'h', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.setHashField).toHaveBeenCalledWith(0, 'h', 'f1', 'newval');
      expect(driver.deleteHashField).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('部分失败时收集错误', async () => {
      (driver.setHashField as any)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('write failed'));
      const edits = [
        { oldField: 'f1', newField: 'f1', value: 'ok' },
        { oldField: 'f2', newField: 'f2', value: 'bad' },
      ];
      const msg = { type: 'redisHashBatchEdit', key: 'h', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisOperationResult',
        success: false,
        error: expect.stringContaining('f2'),
      });
    });
  });

  describe('redisZSetBatchEdit', () => {
    it('rename: 先 zsetAdd 再 zsetRemove', async () => {
      const edits = [{ oldMember: 'm1', newMember: 'm2', score: 1.5 }];
      const msg = { type: 'redisZSetBatchEdit', key: 'z', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      const addCall = (driver.zsetAdd as any).mock.invocationCallOrder[0];
      const rmCall = (driver.zsetRemove as any).mock.invocationCallOrder[0];
      expect(driver.zsetAdd).toHaveBeenCalledWith(0, 'z', 'm2', 1.5);
      expect(driver.zsetRemove).toHaveBeenCalledWith(0, 'z', 'm1');
      expect(addCall).toBeLessThan(rmCall);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('纯 score edit: 不调 zsetRemove', async () => {
      const edits = [{ oldMember: 'm1', newMember: 'm1', score: 9.9 }];
      const msg = { type: 'redisZSetBatchEdit', key: 'z', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.zsetAdd).toHaveBeenCalledWith(0, 'z', 'm1', 9.9);
      expect(driver.zsetRemove).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('部分失败时收集错误', async () => {
      (driver.zsetAdd as any)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('score invalid'));
      const edits = [
        { oldMember: 'm1', newMember: 'm1', score: 1 },
        { oldMember: 'm2', newMember: 'm2', score: -1 },
      ];
      const msg = { type: 'redisZSetBatchEdit', key: 'z', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisOperationResult',
        success: false,
        error: expect.stringContaining('m2'),
      });
    });
  });

  describe('exportRedisKeys', () => {
    const raw = (type: string, items: readonly (string | Buffer)[], ttl = -1) =>
      ({ type, ttl, items: items.map((v) => (typeof v === 'string' ? Buffer.from(v) : v)) });

    it('pattern 导出: 服务端整轮 SCAN 到的 key 全部导出, 读写都带库号', async () => {
      (driver.scanAllKeys as any).mockResolvedValue([Buffer.from('user:1'), Buffer.from('user:2')]);
      (driver.readKeyRaw as any)
        .mockResolvedValueOnce(raw('string', ['hello'], 300))
        .mockResolvedValueOnce(raw('list', ['a', 'b']));
      const progress = vi.fn();

      const result = await exportRedisKeys(driver, 3, { pattern: 'user:*' }, progress);
      const data = JSON.parse(result.json);

      expect(driver.scanAllKeys).toHaveBeenCalledWith(3, 'user:*');
      expect(driver.readKeyRaw).toHaveBeenCalledWith(3, Buffer.from('user:2'));
      expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
      expect(result).toMatchObject({ keyCount: 2, skipped: '', errors: [] });
      expect(data).toMatchObject({ version: 2, database: 3 });
      expect(data.keys).toEqual([
        { key: 'user:1', type: 'string', ttl: 300, value: 'hello' },
        { key: 'user:2', type: 'list', ttl: -1, value: ['a', 'b'] },
      ]);
    });

    it('单 key 导出不 SCAN', async () => {
      (driver.readKeyRaw as any).mockResolvedValue(raw('string', ['v']));

      const result = await exportRedisKeys(driver, 0, { key: 'k*' });

      expect(driver.scanAllKeys).not.toHaveBeenCalled();
      expect(driver.readKeyRaw).toHaveBeenCalledWith(0, Buffer.from('k*'));
      expect(result.keyCount).toBe(1);
    });

    it('onProgress 抛错 (用户取消) 立即中止导出, 不再读后续 key', async () => {
      (driver.scanAllKeys as any).mockResolvedValue([Buffer.from('a'), Buffer.from('b')]);
      (driver.readKeyRaw as any).mockResolvedValue(raw('string', ['v']));

      await expect(exportRedisKeys(driver, 0, { pattern: '*' }, () => { throw new Error('Export cancelled'); }))
        .rejects.toThrow('Export cancelled');
      expect(driver.readKeyRaw).toHaveBeenCalledTimes(1);
    });

    it('不支持的类型和 SCAN 后消失的 key 不写进文件, 按类型计数报出', async () => {
      (driver.scanAllKeys as any).mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map((k) => Buffer.from(k)));
      (driver.readKeyRaw as any)
        .mockResolvedValueOnce(raw('stream', []))
        .mockResolvedValueOnce(raw('ReJSON-RL', []))
        .mockResolvedValueOnce(raw('stream', []))
        .mockResolvedValueOnce(raw('none', []))
        .mockResolvedValueOnce(raw('set', ['m']));

      const result = await exportRedisKeys(driver, 0, { pattern: '*' });

      expect(result.keyCount).toBe(1);
      expect(result.skipped).toBe('skipped 4 key(s): stream x2, ReJSON-RL x1, vanished x1');
    });

    it('单 key 失败不阻塞其他 key', async () => {
      (driver.scanAllKeys as any).mockResolvedValue(['ok1', 'bad', 'ok2'].map((k) => Buffer.from(k)));
      (driver.readKeyRaw as any)
        .mockResolvedValueOnce(raw('string', ['v']))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(raw('string', ['v']));

      const result = await exportRedisKeys(driver, 0, { pattern: '*' });

      expect(result.keyCount).toBe(2);
      expect(result.errors).toEqual(['bad: timeout']);
    });
  });

  describe('导出导入往返', () => {
    it('非 utf8 字节带 base64 标记往返不变, 普通文本仍存字符串', async () => {
      const bin = Buffer.from([0xff, 0xfe]);
      const raw = (type: string, ttl: number, items: Buffer[]) => ({ type, ttl, items });
      const source: [Buffer, ReturnType<typeof raw>][] = [
        [Buffer.from('str'), raw('string', 120, [bin])],
        [Buffer.from('text'), raw('string', -1, [Buffer.from('héllo')])],
        [Buffer.from('h'), raw('hash', -1, [bin, Buffer.from('v'), Buffer.from('f'), bin])],
        [Buffer.from('l'), raw('list', -1, [Buffer.from('a'), bin])],
        [Buffer.from('s'), raw('set', -1, [bin])],
        [Buffer.from('z'), raw('zset', -1, [bin, Buffer.from('1.5'), Buffer.from('m'), Buffer.from('inf')])],
        [bin, raw('string', -1, [Buffer.from('binary key name')])],
      ];
      (driver.scanAllKeys as any).mockResolvedValue(source.map(([key]) => key));
      (driver.readKeyRaw as any).mockImplementation(async (_db: number, key: Buffer) =>
        source.find(([k]) => k.equals(key))![1]);

      const { json } = await exportRedisKeys(driver, 0, { pattern: '*' });
      const exported = JSON.parse(json).keys;
      const b64 = { encoding: 'base64', data: bin.toString('base64') };
      expect(exported[0].value).toEqual(b64);
      expect(exported[1].value).toBe('héllo');
      expect(exported[2].value).toEqual([{ field: b64, value: 'v' }, { field: 'f', value: b64 }]);
      expect(exported[5].value).toEqual([{ member: b64, score: 1.5 }, { member: 'm', score: 'inf' }]);
      expect(exported[6].key).toEqual(b64);

      const target = createMockDriver();
      const result = await importRedisKeys(target, 4, json, async () => true);

      expect(result).toEqual({ importedCount: source.length, errors: [] });
      expect((target.writeKeyRaw as any).mock.calls).toEqual(source.map(([key, r]) => [4, key, r]));
    });
  });

  describe('importRedisKeys', () => {
    const file = (keys: unknown[], version = 2) => JSON.stringify({ version, exportedAt: '', database: 0, keys });
    const confirmYes = async () => true;

    it('version 1 文件兼容: hash 为对象, 值无标记', async () => {
      await importRedisKeys(driver, 2, file([
        { key: 'h1', type: 'hash', ttl: 300, value: { f1: 'v1', f2: 'v2' } },
      ], 1), confirmYes);

      expect(driver.writeKeyRaw).toHaveBeenCalledWith(2, Buffer.from('h1'), {
        type: 'hash', ttl: 300, items: ['f1', 'v1', 'f2', 'v2'].map((v) => Buffer.from(v)),
      });
    });

    it('已有同名 key: 弹确认, 拒绝则一个 key 也不写', async () => {
      (driver.countExistingKeys as any).mockResolvedValue(2);
      const confirm = vi.fn().mockResolvedValue(false);
      const content = file([
        { key: 'a', type: 'string', ttl: -1, value: '1' },
        { key: 'b', type: 'string', ttl: -1, value: '2' },
      ]);

      const result = await importRedisKeys(driver, 5, content, confirm);

      expect(driver.countExistingKeys).toHaveBeenCalledWith(5, [Buffer.from('a'), Buffer.from('b')]);
      expect(confirm).toHaveBeenCalledWith(2);
      expect(result).toBeNull();
      expect(driver.writeKeyRaw).not.toHaveBeenCalled();

      confirm.mockResolvedValue(true);
      expect(await importRedisKeys(driver, 5, content, confirm)).toEqual({ importedCount: 2, errors: [] });
    });

    it('没有同名 key 时不弹确认', async () => {
      const confirm = vi.fn();
      await importRedisKeys(driver, 0, file([{ key: 'a', type: 'string', ttl: -1, value: '1' }]), confirm);
      expect(confirm).not.toHaveBeenCalled();
      expect(driver.writeKeyRaw).toHaveBeenCalledTimes(1);
    });

    it('version 不匹配抛错', async () => {
      await expect(importRedisKeys(driver, 0, file([], 3), confirmYes))
        .rejects.toThrow('Unsupported export version: 3');
    });

    it('keys 数组缺失抛错', async () => {
      await expect(importRedisKeys(driver, 0, JSON.stringify({ version: 2 }), confirmYes))
        .rejects.toThrow('Invalid export file: missing keys array');
    });

    it('单 key 失败或类型不支持不阻塞其他', async () => {
      (driver.writeKeyRaw as any)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('write error'))
        .mockResolvedValueOnce(undefined);
      const result = await importRedisKeys(driver, 0, file([
        { key: 'ok1', type: 'string', ttl: -1, value: 'a' },
        { key: 'bad', type: 'string', ttl: -1, value: 'b' },
        { key: 'st', type: 'stream', ttl: -1, value: [] },
        { key: 'ok2', type: 'string', ttl: -1, value: 'c' },
      ]), confirmYes);

      expect(result).toEqual({ importedCount: 2, errors: ['bad: write error', 'st: Unsupported type: stream'] });
    });
  });

  describe('错误处理', () => {
    it('driver 抛错时发 redisOperationResult { success: false }', async () => {
      (driver.scan as any).mockRejectedValue(new Error('Connection lost'));

      const msg = { type: 'redisScan', database: 0, pattern: '*', cursor: '0', count: 100 } as WebviewMessage;
      const handled = await handleRedisMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisOperationResult',
        success: false,
        error: 'Connection lost',
      });
    });
  });

  describe('validateTtlInput', () => {
    it('只接受 -1 或 >= 1 的整数 (0 会删 key)', () => {
      expect(validateTtlInput('-1')).toBeUndefined();
      expect(validateTtlInput('1')).toBeUndefined();
      expect(validateTtlInput(' 3600 ')).toBeUndefined();
      for (const bad of ['0', '-2', '1.5', 'abc']) {
        expect(validateTtlInput(bad)).toBe('Must be -1 (remove TTL) or an integer >= 1');
      }
      expect(validateTtlInput(' ')).toBe('TTL is required');
    });
  });
});
