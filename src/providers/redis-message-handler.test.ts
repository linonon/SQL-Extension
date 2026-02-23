import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRedisMessage, parseCommandArgs, exportRedisKeys, importRedisKeys } from './redis-message-handler';
import type { IRedisDriver } from '../types/redis-driver';
import type { WebviewMessage } from '../types/messages';

function createMockDriver(): IRedisDriver {
  return {
    driverType: 'redis',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    selectDatabase: vi.fn(),
    listDatabases: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue({ cursor: '0', keys: [] }),
    getString: vi.fn().mockResolvedValue(null),
    getHash: vi.fn().mockResolvedValue({}),
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
    executeCommand: vi.fn().mockResolvedValue('OK'),
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
});

describe('handleRedisMessage', () => {
  let driver: IRedisDriver;
  let postMessage: ReturnType<typeof vi.fn>;

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
    it('调用 driver.selectDatabase + scan, 返回 redisScanResult', async () => {
      (driver.scan as any).mockResolvedValue({
        cursor: '5',
        keys: [{ key: 'k1', type: 'string', ttl: -1 }],
      });

      const msg = { type: 'redisScan', database: 2, pattern: '*', cursor: '0', count: 100 } as WebviewMessage;
      const handled = await handleRedisMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.selectDatabase).toHaveBeenCalledWith(2);
      expect(driver.scan).toHaveBeenCalledWith('*', '0', 100);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisScanResult',
        keys: [{ key: 'k1', type: 'string', ttl: -1 }],
        cursor: '5',
        done: false,
      });
    });
  });

  describe('redisGetValue', () => {
    it('string 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('string');
      (driver.getString as any).mockResolvedValue('hello');
      (driver.getTTL as any).mockResolvedValue(300);

      const msg = { type: 'redisGetValue', key: 'mykey', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisValueResult',
        key: 'mykey',
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
          value: { type: 'list', value: ['a', 'b'], total: 5 },
        })
      );
    });

    it('set 类型用默认 cursor', async () => {
      (driver.getKeyType as any).mockResolvedValue('set');
      (driver.getSet as any).mockResolvedValue({ cursor: '3', members: ['m1'] });

      const msg = { type: 'redisGetValue', key: 's', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.getSet).toHaveBeenCalledWith('s', '0', 100);
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

      expect(driver.getSet).toHaveBeenCalledWith('s', '5', 100);
    });

    it('zset 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('zset');
      (driver.getZSetLength as any).mockResolvedValue(10);
      (driver.getZSet as any).mockResolvedValue([{ member: 'm', score: 1 }]);

      const msg = { type: 'redisGetValue', key: 'z', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          value: { type: 'zset', value: [{ member: 'm', score: 1 }], total: 10 },
        })
      );
    });
  });

  describe('写操作', () => {
    it('redisSetString', async () => {
      const msg = { type: 'redisSetString', key: 'k', value: 'v', database: 0, ttl: 60 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.setString).toHaveBeenCalledWith('k', 'v', 60);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('redisHashSet', async () => {
      const msg = { type: 'redisHashSet', key: 'h', field: 'f', value: 'v', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setHashField).toHaveBeenCalledWith('h', 'f', 'v');
    });

    it('redisHashDelete', async () => {
      const msg = { type: 'redisHashDelete', key: 'h', field: 'f', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.deleteHashField).toHaveBeenCalledWith('h', 'f');
    });

    it('redisListPush', async () => {
      const msg = { type: 'redisListPush', key: 'l', value: 'v', position: 'head' as const, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.listPush).toHaveBeenCalledWith('l', 'v', 'head');
    });

    it('redisSetAdd', async () => {
      const msg = { type: 'redisSetAdd', key: 's', member: 'm', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setAdd).toHaveBeenCalledWith('s', 'm');
    });

    it('redisSetRemove', async () => {
      const msg = { type: 'redisSetRemove', key: 's', member: 'm', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setRemove).toHaveBeenCalledWith('s', 'm');
    });

    it('redisZSetAdd', async () => {
      const msg = { type: 'redisZSetAdd', key: 'z', member: 'm', score: 1.5, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.zsetAdd).toHaveBeenCalledWith('z', 'm', 1.5);
    });

    it('redisZSetRemove', async () => {
      const msg = { type: 'redisZSetRemove', key: 'z', member: 'm', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.zsetRemove).toHaveBeenCalledWith('z', 'm');
    });

    it('redisSetEdit 原子 SREM+SADD', async () => {
      const msg = { type: 'redisSetEdit', key: 's', oldMember: 'old', newMember: 'new', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setRemove).toHaveBeenCalledWith('s', 'old');
      expect(driver.setAdd).toHaveBeenCalledWith('s', 'new');
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('redisDeleteKeys 多 key', async () => {
      const msg = { type: 'redisDeleteKeys', keys: ['a', 'b', 'c'], database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.deleteKey).toHaveBeenCalledTimes(3);
    });

    it('redisSetTTL', async () => {
      const msg = { type: 'redisSetTTL', key: 'k', ttl: 300, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.setTTL).toHaveBeenCalledWith('k', 300);
    });

    it('redisRemoveTTL', async () => {
      const msg = { type: 'redisRemoveTTL', key: 'k', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.removeTTL).toHaveBeenCalledWith('k');
    });
  });

  describe('redisListSet', () => {
    it('调用 driver.listSet', async () => {
      const msg = { type: 'redisListSet', key: 'l', index: 2, value: 'new', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.listSet).toHaveBeenCalledWith('l', 2, 'new');
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });
  });

  describe('redisListRemove', () => {
    it('调用 driver.listRemove', async () => {
      const msg = { type: 'redisListRemove', key: 'l', index: 1, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.listRemove).toHaveBeenCalledWith('l', 1);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });
  });

  describe('redisListBatchSet', () => {
    it('循环调用 driver.listSet', async () => {
      const entries = [{ index: 0, value: 'a' }, { index: 2, value: 'c' }];
      const msg = { type: 'redisListBatchSet', key: 'l', entries, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);
      expect(driver.listSet).toHaveBeenCalledTimes(2);
      expect(driver.listSet).toHaveBeenCalledWith('l', 0, 'a');
      expect(driver.listSet).toHaveBeenCalledWith('l', 2, 'c');
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
      (driver.executeCommand as any).mockResolvedValue('PONG');

      const msg = { type: 'redisExecuteCommand', command: 'PING', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisCommandResult',
        output: 'PONG',
      });
    });

    it('非 string 结果 JSON 序列化', async () => {
      (driver.executeCommand as any).mockResolvedValue([1, 2, 3]);

      const msg = { type: 'redisExecuteCommand', command: 'KEYS *', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'redisCommandResult',
        output: JSON.stringify([1, 2, 3], null, 2),
      });
    });

    it('引号参数应该被正确解析 (#10)', async () => {
      const msg = { type: 'redisExecuteCommand', command: 'SET key "hello world"', database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.executeCommand).toHaveBeenCalledWith(['SET', 'key', 'hello world']);
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
      expect(driver.setHashField).toHaveBeenCalledWith('h', 'f2', 'val');
      expect(driver.deleteHashField).toHaveBeenCalledWith('h', 'f1');
      expect(setCall).toBeLessThan(delCall);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('纯 value edit: 不调 deleteHashField', async () => {
      const edits = [{ oldField: 'f1', newField: 'f1', value: 'newval' }];
      const msg = { type: 'redisHashBatchEdit', key: 'h', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.setHashField).toHaveBeenCalledWith('h', 'f1', 'newval');
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
      expect(driver.zsetAdd).toHaveBeenCalledWith('z', 'm2', 1.5);
      expect(driver.zsetRemove).toHaveBeenCalledWith('z', 'm1');
      expect(addCall).toBeLessThan(rmCall);
      expect(postMessage).toHaveBeenCalledWith({ type: 'redisOperationResult', success: true });
    });

    it('纯 score edit: 不调 zsetRemove', async () => {
      const edits = [{ oldMember: 'm1', newMember: 'm1', score: 9.9 }];
      const msg = { type: 'redisZSetBatchEdit', key: 'z', edits, database: 0 } as WebviewMessage;
      await handleRedisMessage(msg, driver, postMessage);

      expect(driver.zsetAdd).toHaveBeenCalledWith('z', 'm1', 9.9);
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
    it('导出 string 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('string');
      (driver.getTTL as any).mockResolvedValue(-1);
      (driver.getString as any).mockResolvedValue('hello');

      const result = await exportRedisKeys(driver, 0, ['greeting']);
      const data = JSON.parse(result.json);

      expect(result.keyCount).toBe(1);
      expect(result.errors).toEqual([]);
      expect(data.version).toBe(1);
      expect(data.database).toBe(0);
      expect(data.keys[0]).toEqual({ key: 'greeting', type: 'string', ttl: -1, value: 'hello' });
    });

    it('导出 hash 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('hash');
      (driver.getTTL as any).mockResolvedValue(-1);
      (driver.getHash as any).mockResolvedValue({ name: 'Alice', age: '30' });

      const result = await exportRedisKeys(driver, 0, ['user:1']);
      const data = JSON.parse(result.json);

      expect(data.keys[0]).toEqual({ key: 'user:1', type: 'hash', ttl: -1, value: { name: 'Alice', age: '30' } });
    });

    it('导出 list 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('list');
      (driver.getTTL as any).mockResolvedValue(300);
      (driver.getList as any).mockResolvedValue(['a', 'b', 'c']);

      const result = await exportRedisKeys(driver, 0, ['mylist']);
      const data = JSON.parse(result.json);

      expect(data.keys[0]).toEqual({ key: 'mylist', type: 'list', ttl: 300, value: ['a', 'b', 'c'] });
    });

    it('导出 set 类型 - SSCAN 循环收集全部 members', async () => {
      (driver.getKeyType as any).mockResolvedValue('set');
      (driver.getTTL as any).mockResolvedValue(-1);
      (driver.getSet as any)
        .mockResolvedValueOnce({ cursor: '5', members: ['x', 'y'] })
        .mockResolvedValueOnce({ cursor: '0', members: ['z'] });

      const result = await exportRedisKeys(driver, 0, ['myset']);
      const data = JSON.parse(result.json);

      expect(driver.getSet).toHaveBeenCalledTimes(2);
      expect(data.keys[0]).toEqual({ key: 'myset', type: 'set', ttl: -1, value: ['x', 'y', 'z'] });
    });

    it('导出 zset 类型', async () => {
      (driver.getKeyType as any).mockResolvedValue('zset');
      (driver.getTTL as any).mockResolvedValue(-1);
      (driver.getZSet as any).mockResolvedValue([{ member: 'a', score: 1.0 }, { member: 'b', score: 2.0 }]);

      const result = await exportRedisKeys(driver, 0, ['scores']);
      const data = JSON.parse(result.json);

      expect(data.keys[0]).toEqual({
        key: 'scores', type: 'zset', ttl: -1,
        value: [{ member: 'a', score: 1.0 }, { member: 'b', score: 2.0 }],
      });
    });

    it('stream/unknown 类型跳过', async () => {
      (driver.getKeyType as any).mockResolvedValue('stream');
      (driver.getTTL as any).mockResolvedValue(-1);

      const result = await exportRedisKeys(driver, 0, ['mystream']);

      expect(result.keyCount).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('单 key 失败不阻塞其他 key', async () => {
      (driver.getKeyType as any)
        .mockResolvedValueOnce('string')
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce('string');
      (driver.getTTL as any).mockResolvedValue(-1);
      (driver.getString as any).mockResolvedValue('val');

      const result = await exportRedisKeys(driver, 0, ['ok1', 'bad', 'ok2']);

      expect(result.keyCount).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('bad');
    });
  });

  describe('importRedisKeys', () => {
    it('导入 string 类型 - 不调 deleteKey', async () => {
      const data = { version: 1, exportedAt: '', database: 0, keys: [
        { key: 'k1', type: 'string', ttl: -1, value: 'hello' },
      ] };

      const result = await importRedisKeys(driver, 0, JSON.stringify(data));

      expect(result.importedCount).toBe(1);
      expect(driver.setString).toHaveBeenCalledWith('k1', 'hello');
      expect(driver.deleteKey).not.toHaveBeenCalled();
      expect(driver.setTTL).not.toHaveBeenCalled();
    });

    it('导入 hash 类型 - 先 deleteKey', async () => {
      const data = { version: 1, exportedAt: '', database: 0, keys: [
        { key: 'h1', type: 'hash', ttl: -1, value: { f1: 'v1', f2: 'v2' } },
      ] };

      await importRedisKeys(driver, 0, JSON.stringify(data));

      expect(driver.deleteKey).toHaveBeenCalledWith('h1');
      expect(driver.setHashField).toHaveBeenCalledWith('h1', 'f1', 'v1');
      expect(driver.setHashField).toHaveBeenCalledWith('h1', 'f2', 'v2');
    });

    it('导入 list 类型 - 先 deleteKey', async () => {
      const data = { version: 1, exportedAt: '', database: 0, keys: [
        { key: 'l1', type: 'list', ttl: -1, value: ['a', 'b'] },
      ] };

      await importRedisKeys(driver, 0, JSON.stringify(data));

      expect(driver.deleteKey).toHaveBeenCalledWith('l1');
      expect(driver.listPush).toHaveBeenCalledWith('l1', 'a', 'tail');
      expect(driver.listPush).toHaveBeenCalledWith('l1', 'b', 'tail');
    });

    it('导入 set 类型 - 先 deleteKey', async () => {
      const data = { version: 1, exportedAt: '', database: 0, keys: [
        { key: 's1', type: 'set', ttl: -1, value: ['x', 'y'] },
      ] };

      await importRedisKeys(driver, 0, JSON.stringify(data));

      expect(driver.deleteKey).toHaveBeenCalledWith('s1');
      expect(driver.setAdd).toHaveBeenCalledWith('s1', 'x');
      expect(driver.setAdd).toHaveBeenCalledWith('s1', 'y');
    });

    it('导入 zset 类型 - 先 deleteKey', async () => {
      const data = { version: 1, exportedAt: '', database: 0, keys: [
        { key: 'z1', type: 'zset', ttl: -1, value: [{ member: 'a', score: 1.0 }] },
      ] };

      await importRedisKeys(driver, 0, JSON.stringify(data));

      expect(driver.deleteKey).toHaveBeenCalledWith('z1');
      expect(driver.zsetAdd).toHaveBeenCalledWith('z1', 'a', 1.0);
    });

    it('TTL > 0 时调 setTTL', async () => {
      const data = { version: 1, exportedAt: '', database: 0, keys: [
        { key: 'k1', type: 'string', ttl: 300, value: 'hello' },
      ] };

      await importRedisKeys(driver, 0, JSON.stringify(data));

      expect(driver.setTTL).toHaveBeenCalledWith('k1', 300);
    });

    it('version 不匹配抛错', async () => {
      const data = { version: 2, exportedAt: '', database: 0, keys: [] };

      await expect(importRedisKeys(driver, 0, JSON.stringify(data)))
        .rejects.toThrow('Unsupported export version: 2');
    });

    it('keys 数组缺失抛错', async () => {
      const data = { version: 1, exportedAt: '', database: 0 };

      await expect(importRedisKeys(driver, 0, JSON.stringify(data)))
        .rejects.toThrow('Invalid export file: missing keys array');
    });

    it('单 key 导入失败不阻塞其他', async () => {
      (driver.setString as any)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('write error'))
        .mockResolvedValueOnce(undefined);
      const data = { version: 1, exportedAt: '', database: 0, keys: [
        { key: 'ok1', type: 'string', ttl: -1, value: 'a' },
        { key: 'bad', type: 'string', ttl: -1, value: 'b' },
        { key: 'ok2', type: 'string', ttl: -1, value: 'c' },
      ] };

      const result = await importRedisKeys(driver, 0, JSON.stringify(data));

      expect(result.importedCount).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('bad');
    });
  });

  describe('错误处理', () => {
    it('driver 抛错时发 redisOperationResult { success: false }', async () => {
      (driver.selectDatabase as any).mockRejectedValue(new Error('Connection lost'));

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
});
