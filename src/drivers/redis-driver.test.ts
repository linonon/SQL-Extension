import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisDriver } from './redis-driver';

// Mock ioredis
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue('PONG'),
  status: 'ready',
  select: vi.fn().mockResolvedValue('OK'),
  info: vi.fn().mockResolvedValue(''),
  scan: vi.fn().mockResolvedValue(['0', []]),
  pipeline: vi.fn(),
  get: vi.fn().mockResolvedValue(null),
  hgetall: vi.fn().mockResolvedValue({}),
  lrange: vi.fn().mockResolvedValue([]),
  sscan: vi.fn().mockResolvedValue(['0', []]),
  zrange: vi.fn().mockResolvedValue([]),
  set: vi.fn().mockResolvedValue('OK'),
  hset: vi.fn().mockResolvedValue(1),
  hdel: vi.fn().mockResolvedValue(1),
  lpush: vi.fn().mockResolvedValue(1),
  rpush: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
  srem: vi.fn().mockResolvedValue(1),
  zadd: vi.fn().mockResolvedValue(1),
  zrem: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(1),
  type: vi.fn().mockResolvedValue('string'),
  ttl: vi.fn().mockResolvedValue(-1),
  expire: vi.fn().mockResolvedValue(1),
  persist: vi.fn().mockResolvedValue(1),
  llen: vi.fn().mockResolvedValue(0),
  zcard: vi.fn().mockResolvedValue(0),
  call: vi.fn().mockResolvedValue('OK'),
  lset: vi.fn().mockResolvedValue('OK'),
  lrem: vi.fn().mockResolvedValue(1),
};

vi.mock('ioredis', () => {
  // 用 class 模拟, 这样 new Redis() 能正常工作
  class MockRedis {
    connect = mockClient.connect;
    disconnect = mockClient.disconnect;
    ping = mockClient.ping;
    get status() { return mockClient.status; }
    select = mockClient.select;
    info = mockClient.info;
    scan = mockClient.scan;
    pipeline = mockClient.pipeline;
    get = mockClient.get;
    hgetall = mockClient.hgetall;
    lrange = mockClient.lrange;
    sscan = mockClient.sscan;
    zrange = mockClient.zrange;
    set = mockClient.set;
    hset = mockClient.hset;
    hdel = mockClient.hdel;
    lpush = mockClient.lpush;
    rpush = mockClient.rpush;
    sadd = mockClient.sadd;
    srem = mockClient.srem;
    zadd = mockClient.zadd;
    zrem = mockClient.zrem;
    del = mockClient.del;
    type = mockClient.type;
    ttl = mockClient.ttl;
    expire = mockClient.expire;
    persist = mockClient.persist;
    llen = mockClient.llen;
    zcard = mockClient.zcard;
    call = mockClient.call;
    lset = mockClient.lset;
    lrem = mockClient.lrem;
  }
  return { default: MockRedis };
});

const TEST_CONFIG = {
  id: 'test-id',
  name: 'test',
  driverType: 'redis' as const,
  host: 'localhost',
  port: 6379,
  username: '',
  password: 'secret',
  database: '0',
};

describe('RedisDriver', () => {
  let driver: RedisDriver;

  beforeEach(() => {
    driver = new RedisDriver();
    vi.clearAllMocks();
    mockClient.status = 'ready';
  });

  describe('connect', () => {
    it('应该调用 client.connect() + ping()', async () => {
      await driver.connect(TEST_CONFIG);

      expect(mockClient.connect).toHaveBeenCalled();
      expect(mockClient.ping).toHaveBeenCalled();
    });

    it('连接后 isConnected 应该返回 true', async () => {
      expect(driver.isConnected()).toBe(false);

      await driver.connect(TEST_CONFIG);

      expect(driver.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('应该 await disconnect (#5)', async () => {
      await driver.connect(TEST_CONFIG);

      await driver.disconnect();

      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(driver.isConnected()).toBe(false);
    });

    it('未连接时 disconnect 应该安全执行', async () => {
      await driver.disconnect();
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('未连接时返回 false', () => {
      expect(driver.isConnected()).toBe(false);
    });

    it('client status 不是 ready 时返回 false', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.status = 'connecting';
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('selectDatabase', () => {
    it('应该调用 client.select(db)', async () => {
      await driver.connect(TEST_CONFIG);

      await driver.selectDatabase(3);

      expect(mockClient.select).toHaveBeenCalledWith(3);
    });
  });

  describe('listDatabases', () => {
    it('应该解析 INFO keyspace 输出', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.info.mockResolvedValue(
        '# Keyspace\r\ndb0:keys=100,expires=5,avg_ttl=0\r\ndb3:keys=42,expires=0,avg_ttl=0\r\n'
      );

      const dbs = await driver.listDatabases();

      expect(dbs).toHaveLength(16);
      expect(dbs[0]).toEqual({ index: 0, keyCount: 100 });
      expect(dbs[3]).toEqual({ index: 3, keyCount: 42 });
      expect(dbs[1]).toEqual({ index: 1, keyCount: 0 });
    });
  });

  describe('scan', () => {
    it('正常路径: 返回 keys + types + ttls', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.scan.mockResolvedValue(['5', ['key1', 'key2']]);

      const mockPipeline = {
        type: vi.fn().mockReturnThis(),
        ttl: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [null, 'string'],
          [null, 300],
          [null, 'hash'],
          [null, -1],
        ]),
      };
      mockClient.pipeline.mockReturnValue(mockPipeline);

      const result = await driver.scan('*', '0', 100);

      expect(result.cursor).toBe('5');
      expect(result.keys).toEqual([
        { key: 'key1', type: 'string', ttl: 300 },
        { key: 'key2', type: 'hash', ttl: -1 },
      ]);
    });

    it('空结果: rawKeys.length === 0', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.scan.mockResolvedValue(['0', []]);

      const result = await driver.scan('*', '0', 100);

      expect(result.cursor).toBe('0');
      expect(result.keys).toEqual([]);
    });

    it('pipeline exec 返回 null 时应 fallback (#6)', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.scan.mockResolvedValue(['3', ['key1']]);

      const mockPipeline = {
        type: vi.fn().mockReturnThis(),
        ttl: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      };
      mockClient.pipeline.mockReturnValue(mockPipeline);

      const result = await driver.scan('*', '0', 100);

      expect(result.cursor).toBe('3');
      expect(result.keys).toEqual([
        { key: 'key1', type: 'unknown', ttl: -1 },
      ]);
    });
  });

  describe('getString', () => {
    it('应该返回字符串值', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.get.mockResolvedValue('hello');

      const val = await driver.getString('mykey');

      expect(val).toBe('hello');
      expect(mockClient.get).toHaveBeenCalledWith('mykey');
    });
  });

  describe('getHash', () => {
    it('应该返回 hash 对象', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.hgetall.mockResolvedValue({ field1: 'val1', field2: 'val2' });

      const val = await driver.getHash('myhash');

      expect(val).toEqual({ field1: 'val1', field2: 'val2' });
    });

    it('不存在的 key 返回空对象 (#9)', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.hgetall.mockResolvedValue({});

      const val = await driver.getHash('nonexistent');

      // ioredis hgetall 对不存在 key 返回 {}, 这是预期行为
      expect(val).toEqual({});
    });
  });

  describe('getList', () => {
    it('应该返回列表元素', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.lrange.mockResolvedValue(['a', 'b', 'c']);

      const val = await driver.getList('mylist', 0, 99);

      expect(val).toEqual(['a', 'b', 'c']);
      expect(mockClient.lrange).toHaveBeenCalledWith('mylist', 0, 99);
    });
  });

  describe('getSet', () => {
    it('应该返回 set members + cursor', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.sscan.mockResolvedValue(['5', ['m1', 'm2']]);

      const val = await driver.getSet('myset', '0', 100);

      expect(val).toEqual({ cursor: '5', members: ['m1', 'm2'] });
    });
  });

  describe('getZSet', () => {
    it('应该返回 member + score 对', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.zrange.mockResolvedValue(['alice', '10', 'bob', '20']);

      const val = await driver.getZSet('myzset', 0, 99);

      expect(val).toEqual([
        { member: 'alice', score: 10 },
        { member: 'bob', score: 20 },
      ]);
    });
  });

  describe('setString', () => {
    it('无 TTL 时只设值', async () => {
      await driver.connect(TEST_CONFIG);

      await driver.setString('k', 'v');

      expect(mockClient.set).toHaveBeenCalledWith('k', 'v');
    });

    it('有 TTL 时用 EX 参数', async () => {
      await driver.connect(TEST_CONFIG);

      await driver.setString('k', 'v', 60);

      expect(mockClient.set).toHaveBeenCalledWith('k', 'v', 'EX', 60);
    });
  });

  describe('写操作', () => {
    beforeEach(async () => {
      await driver.connect(TEST_CONFIG);
    });

    it('setHashField 应该调用 hset', async () => {
      await driver.setHashField('h', 'f', 'v');
      expect(mockClient.hset).toHaveBeenCalledWith('h', 'f', 'v');
    });

    it('deleteHashField 应该调用 hdel', async () => {
      await driver.deleteHashField('h', 'f');
      expect(mockClient.hdel).toHaveBeenCalledWith('h', 'f');
    });

    it('listPush head 调用 lpush', async () => {
      await driver.listPush('l', 'v', 'head');
      expect(mockClient.lpush).toHaveBeenCalledWith('l', 'v');
    });

    it('listPush tail 调用 rpush', async () => {
      await driver.listPush('l', 'v', 'tail');
      expect(mockClient.rpush).toHaveBeenCalledWith('l', 'v');
    });

    it('setAdd 调用 sadd', async () => {
      await driver.setAdd('s', 'm');
      expect(mockClient.sadd).toHaveBeenCalledWith('s', 'm');
    });

    it('setRemove 调用 srem', async () => {
      await driver.setRemove('s', 'm');
      expect(mockClient.srem).toHaveBeenCalledWith('s', 'm');
    });

    it('zsetAdd 调用 zadd', async () => {
      await driver.zsetAdd('z', 'm', 1.5);
      expect(mockClient.zadd).toHaveBeenCalledWith('z', 1.5, 'm');
    });

    it('zsetRemove 调用 zrem', async () => {
      await driver.zsetRemove('z', 'm');
      expect(mockClient.zrem).toHaveBeenCalledWith('z', 'm');
    });

    it('deleteKey 调用 del', async () => {
      await driver.deleteKey('k');
      expect(mockClient.del).toHaveBeenCalledWith('k');
    });

    it('setTTL 调用 expire', async () => {
      await driver.setTTL('k', 300);
      expect(mockClient.expire).toHaveBeenCalledWith('k', 300);
    });

    it('removeTTL 调用 persist', async () => {
      await driver.removeTTL('k');
      expect(mockClient.persist).toHaveBeenCalledWith('k');
    });
  });

  describe('listSet', () => {
    it('应该调用 lset', async () => {
      await driver.connect(TEST_CONFIG);
      await driver.listSet('mylist', 2, 'newval');
      expect(mockClient.lset).toHaveBeenCalledWith('mylist', 2, 'newval');
    });
  });

  describe('listRemove', () => {
    it('应该调用 lset + lrem (tombstone 模式)', async () => {
      await driver.connect(TEST_CONFIG);
      await driver.listRemove('mylist', 1);

      expect(mockClient.lset).toHaveBeenCalledWith('mylist', 1, expect.stringMatching(/^__DEL_.+__$/));
      expect(mockClient.lrem).toHaveBeenCalledWith('mylist', 1, expect.stringMatching(/^__DEL_.+__$/));
      // tombstone 值应该相同
      const tombstone = mockClient.lset.mock.calls[0][2];
      expect(mockClient.lrem).toHaveBeenCalledWith('mylist', 1, tombstone);
    });
  });

  describe('executeCommand', () => {
    it('空 args 应该抛错', async () => {
      await driver.connect(TEST_CONFIG);

      await expect(driver.executeCommand([])).rejects.toThrow('No command provided');
    });

    it('正常调用 client.call', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.call.mockResolvedValue('PONG');

      const result = await driver.executeCommand(['PING']);

      expect(result).toBe('PONG');
      expect(mockClient.call).toHaveBeenCalledWith('PING');
    });

    it('带参数的命令', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.call.mockResolvedValue('OK');

      const result = await driver.executeCommand(['SET', 'key', 'value']);

      expect(result).toBe('OK');
      expect(mockClient.call).toHaveBeenCalledWith('SET', 'key', 'value');
    });
  });

  describe('assertConnected', () => {
    it('未连接时所有操作抛错', async () => {
      await expect(driver.getString('k')).rejects.toThrow('Redis driver is not connected');
      await expect(driver.getHash('k')).rejects.toThrow('Redis driver is not connected');
      await expect(driver.scan('*', '0', 100)).rejects.toThrow('Redis driver is not connected');
      await expect(driver.selectDatabase(0)).rejects.toThrow('Redis driver is not connected');
      await expect(driver.listDatabases()).rejects.toThrow('Redis driver is not connected');
    });
  });

  describe('getKeyType / getTTL / getListLength / getZSetLength', () => {
    beforeEach(async () => {
      await driver.connect(TEST_CONFIG);
    });

    it('getKeyType 返回正确类型', async () => {
      mockClient.type.mockResolvedValue('hash');
      const t = await driver.getKeyType('k');
      expect(t).toBe('hash');
    });

    it('getTTL 返回秒数', async () => {
      mockClient.ttl.mockResolvedValue(120);
      const t = await driver.getTTL('k');
      expect(t).toBe(120);
    });

    it('getListLength 返回长度', async () => {
      mockClient.llen.mockResolvedValue(5);
      const l = await driver.getListLength('k');
      expect(l).toBe(5);
    });

    it('getZSetLength 返回长度', async () => {
      mockClient.zcard.mockResolvedValue(10);
      const l = await driver.getZSetLength('k');
      expect(l).toBe(10);
    });
  });
});
