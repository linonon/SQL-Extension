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
  pttl: vi.fn().mockResolvedValue(-1),
  expire: vi.fn().mockResolvedValue(1),
  persist: vi.fn().mockResolvedValue(1),
  llen: vi.fn().mockResolvedValue(0),
  zcard: vi.fn().mockResolvedValue(0),
  call: vi.fn().mockResolvedValue('OK'),
  lset: vi.fn().mockResolvedValue('OK'),
  lrem: vi.fn().mockResolvedValue(1),
  multi: vi.fn(),
  getBuffer: vi.fn().mockResolvedValue(null),
  hscanBuffer: vi.fn(),
  scanBuffer: vi.fn(),
};

// 每个 new Redis / duplicate 出来的实例, 按创建顺序
const instances: { options: Record<string, unknown> }[] = [];

vi.mock('ioredis', () => {
  // 用 class 模拟, 这样 new Redis() 能正常工作
  class MockRedis {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }
    duplicate(override: Record<string, unknown>) {
      return new MockRedis({ ...this.options, ...override });
    }
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
    pttl = mockClient.pttl;
    expire = mockClient.expire;
    persist = mockClient.persist;
    llen = mockClient.llen;
    zcard = mockClient.zcard;
    call = mockClient.call;
    lset = mockClient.lset;
    lrem = mockClient.lrem;
    multi = mockClient.multi;
    getBuffer = mockClient.getBuffer;
    hscanBuffer = mockClient.hscanBuffer;
    scanBuffer = mockClient.scanBuffer;
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
    instances.length = 0;
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

      const result = await driver.scan(0, '*', '0', 100);

      expect(result.cursor).toBe('5');
      expect(result.keys).toEqual([
        { key: 'key1', type: 'string', ttl: 300 },
        { key: 'key2', type: 'hash', ttl: -1 },
      ]);
    });

    it('空结果: rawKeys.length === 0', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.scan.mockResolvedValue(['0', []]);

      const result = await driver.scan(0, '*', '0', 100);

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

      const result = await driver.scan(0, '*', '0', 100);

      expect(result.cursor).toBe('3');
      expect(result.keys).toEqual([
        { key: 'key1', type: 'unknown', ttl: -1 },
      ]);
    });

    it('稀疏 pattern: 循环 SCAN COUNT 1000 直到凑够 count 或 cursor 回到 0, 重复 key 去重', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.scan.mockReset();
      mockClient.scan
        .mockResolvedValueOnce(['7', []])
        .mockResolvedValueOnce(['9', ['a']])
        .mockResolvedValueOnce(['0', ['a', 'b']]);
      mockClient.pipeline.mockReturnValue({
        type: vi.fn().mockReturnThis(),
        ttl: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 'string'], [null, -1], [null, 'hash'], [null, 5]]),
      });

      const result = await driver.scan(0, 'player:10086*', '0', 100);

      expect(mockClient.scan).toHaveBeenCalledTimes(3);
      expect(mockClient.scan).toHaveBeenNthCalledWith(2, '7', 'MATCH', 'player:10086*', 'COUNT', 1000);
      expect(result).toEqual({
        cursor: '0',
        scanned: 3000,
        keys: [{ key: 'a', type: 'string', ttl: -1 }, { key: 'b', type: 'hash', ttl: 5 }],
      });
    });

    it('一次请求最多扫约 2 万个 key, 没匹配也带 cursor 返回让用户接着扫', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.scan.mockReset();
      mockClient.scan.mockResolvedValue(['42', []]);

      const result = await driver.scan(0, 'nope:*', '0', 100);

      expect(mockClient.scan).toHaveBeenCalledTimes(20);
      expect(result).toEqual({ cursor: '42', keys: [], scanned: 20000 });
    });

    it('无 glob 元字符的精确 key 名直接查 TYPE + TTL, 不 SCAN; 不存在返回空', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.scan.mockReset();
      const pipeline = {
        type: vi.fn().mockReturnThis(),
        ttl: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 'zset'], [null, 60]]),
      };
      mockClient.pipeline.mockReturnValue(pipeline);

      const hit = await driver.scan(0, 'rank:1', '0', 100);
      expect(pipeline.type).toHaveBeenCalledWith('rank:1');
      expect(hit).toEqual({ cursor: '0', keys: [{ key: 'rank:1', type: 'zset', ttl: 60 }], scanned: 1 });

      pipeline.exec.mockResolvedValue([[null, 'none'], [null, -2]]);
      expect((await driver.scan(0, 'rank:2', '0', 100)).keys).toEqual([]);
      expect(mockClient.scan).not.toHaveBeenCalled();

      // 转义也算 pattern, 走 SCAN
      mockClient.scan.mockResolvedValue(['0', []]);
      await driver.scan(0, 'a\\*b', '0', 100);
      expect(mockClient.scan).toHaveBeenCalled();
    });
  });

  describe('getString', () => {
    it('应该返回字符串值', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.get.mockResolvedValue('hello');

      const val = await driver.getString(0, 'mykey');

      expect(val).toBe('hello');
      expect(mockClient.get).toHaveBeenCalledWith('mykey');
    });
  });

  describe('getList', () => {
    it('应该返回列表元素', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.lrange.mockResolvedValue(['a', 'b', 'c']);

      const val = await driver.getList(0, 'mylist', 0, 99);

      expect(val).toEqual(['a', 'b', 'c']);
      expect(mockClient.lrange).toHaveBeenCalledWith('mylist', 0, 99);
    });
  });

  describe('getSet', () => {
    it('应该返回 set members + cursor', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.sscan.mockResolvedValue(['5', ['m1', 'm2']]);

      const val = await driver.getSet(0, 'myset', '0', 100);

      expect(val).toEqual({ cursor: '5', members: ['m1', 'm2'] });
    });
  });

  describe('getZSet', () => {
    it('应该返回 member + score 对', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.zrange.mockResolvedValue(['alice', '10', 'bob', '20']);

      const val = await driver.getZSet(0, 'myzset', 0, 99);

      expect(val).toEqual([
        { member: 'alice', score: 10 },
        { member: 'bob', score: 20 },
      ]);
    });
  });

  describe('setString', () => {
    it('key 无 TTL 时只设值', async () => {
      await driver.connect(TEST_CONFIG);

      await driver.setString(0, 'k', 'v');

      expect(mockClient.set).toHaveBeenCalledWith('k', 'v');
    });

    it('不传 ttl 时保留 key 原有 TTL (PTTL + SET PX)', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.pttl.mockResolvedValueOnce(42000);

      await driver.setString(0, 'k', 'v');

      expect(mockClient.pttl).toHaveBeenCalledWith('k');
      expect(mockClient.set).toHaveBeenCalledWith('k', 'v', 'PX', 42000);
    });

    it('有 TTL 时用 EX 参数', async () => {
      await driver.connect(TEST_CONFIG);

      await driver.setString(0, 'k', 'v', 60);

      expect(mockClient.set).toHaveBeenCalledWith('k', 'v', 'EX', 60);
    });
  });

  describe('写操作', () => {
    beforeEach(async () => {
      await driver.connect(TEST_CONFIG);
    });

    it('setHashField 应该调用 hset', async () => {
      await driver.setHashField(0, 'h', 'f', 'v');
      expect(mockClient.hset).toHaveBeenCalledWith('h', 'f', 'v');
    });

    it('deleteHashField 应该调用 hdel', async () => {
      await driver.deleteHashField(0, 'h', 'f');
      expect(mockClient.hdel).toHaveBeenCalledWith('h', 'f');
    });

    it('listPush head 调用 lpush', async () => {
      await driver.listPush(0, 'l', 'v', 'head');
      expect(mockClient.lpush).toHaveBeenCalledWith('l', 'v');
    });

    it('listPush tail 调用 rpush', async () => {
      await driver.listPush(0, 'l', 'v', 'tail');
      expect(mockClient.rpush).toHaveBeenCalledWith('l', 'v');
    });

    it('setAdd 调用 sadd', async () => {
      await driver.setAdd(0, 's', 'm');
      expect(mockClient.sadd).toHaveBeenCalledWith('s', 'm');
    });

    it('setRemove 调用 srem', async () => {
      await driver.setRemove(0, 's', 'm');
      expect(mockClient.srem).toHaveBeenCalledWith('s', 'm');
    });

    it('zsetAdd 调用 zadd', async () => {
      await driver.zsetAdd(0, 'z', 'm', 1.5);
      expect(mockClient.zadd).toHaveBeenCalledWith('z', 1.5, 'm');
    });

    it('zsetRemove 调用 zrem', async () => {
      await driver.zsetRemove(0, 'z', 'm');
      expect(mockClient.zrem).toHaveBeenCalledWith('z', 'm');
    });

    it('deleteKey 调用 del', async () => {
      await driver.deleteKey(0, 'k');
      expect(mockClient.del).toHaveBeenCalledWith('k');
    });

    it('setTTL 调用 expire', async () => {
      await driver.setTTL(0, 'k', 300);
      expect(mockClient.expire).toHaveBeenCalledWith('k', 300);
    });

    it('removeTTL 调用 persist', async () => {
      await driver.removeTTL(0, 'k');
      expect(mockClient.persist).toHaveBeenCalledWith('k');
    });
  });

  describe('listSet', () => {
    it('应该调用 lset', async () => {
      await driver.connect(TEST_CONFIG);
      await driver.listSet(0, 'mylist', 2, 'newval');
      expect(mockClient.lset).toHaveBeenCalledWith('mylist', 2, 'newval');
    });
  });

  describe('listRemove', () => {
    it('应该调用 lset + lrem (tombstone 模式)', async () => {
      await driver.connect(TEST_CONFIG);
      await driver.listRemove(0, 'mylist', 1);

      expect(mockClient.lset).toHaveBeenCalledWith('mylist', 1, expect.stringMatching(/^__DEL_.+__$/));
      expect(mockClient.lrem).toHaveBeenCalledWith('mylist', 1, expect.stringMatching(/^__DEL_.+__$/));
      // tombstone 值应该相同
      const tombstone = mockClient.lset.mock.calls[0][2];
      expect(mockClient.lrem).toHaveBeenCalledWith('mylist', 1, tombstone);
    });
  });

  describe('assertConnected', () => {
    it('未连接时所有操作抛错', async () => {
      await expect(driver.getString(0, 'k')).rejects.toThrow('Redis driver is not connected');
      await expect(driver.scan(0, '*', '0', 100)).rejects.toThrow('Redis driver is not connected');
      await expect(driver.listDatabases()).rejects.toThrow('Redis driver is not connected');
    });
  });

  describe('getKeyType / getTTL / getListLength / getZSetLength', () => {
    beforeEach(async () => {
      await driver.connect(TEST_CONFIG);
    });

    it('getKeyType 返回正确类型', async () => {
      mockClient.type.mockResolvedValue('hash');
      const t = await driver.getKeyType(0, 'k');
      expect(t).toBe('hash');
    });

    it('getKeyType 原样返回模块类型名', async () => {
      mockClient.type.mockResolvedValue('ReJSON-RL');
      expect(await driver.getKeyType(0, 'k')).toBe('ReJSON-RL');
    });

    it('getTTL 返回秒数', async () => {
      mockClient.ttl.mockResolvedValue(120);
      const t = await driver.getTTL(0, 'k');
      expect(t).toBe(120);
    });

    it('getListLength 返回长度', async () => {
      mockClient.llen.mockResolvedValue(5);
      const l = await driver.getListLength(0, 'k');
      expect(l).toBe(5);
    });

    it('getZSetLength 返回长度', async () => {
      mockClient.zcard.mockResolvedValue(10);
      const l = await driver.getZSetLength(0, 'k');
      expect(l).toBe(10);
    });
  });

  describe('按库分 client', () => {
    // 每次调用落在哪个实例上, 用该实例连的库号表示
    const dbsOf = (fn: { mock: { contexts: unknown[] } }) =>
      fn.mock.contexts.map((c) => (c as { options: { db: number } }).options.db);

    it('两个库两条 client, 操作落在各自库的 client 上, disconnect 全部断开', async () => {
      await driver.connect(TEST_CONFIG);

      await driver.getString(0, 'a');
      await driver.getString(3, 'b');
      await driver.getString(3, 'c');

      // db0 是连接配置的库, 走主 client; db3 只 duplicate 一次并显式 SELECT 校验库号
      expect(instances.map((c) => c.options.db)).toEqual([0, 3]);
      expect(dbsOf(mockClient.select)).toEqual([3]);
      expect(dbsOf(mockClient.get)).toEqual([0, 3, 3]);

      await driver.disconnect();
      expect(dbsOf(mockClient.disconnect).sort()).toEqual([0, 3]);
      expect(driver.isConnected()).toBe(false);
    });

    it('库号越界: SELECT 失败的 client 断开且不缓存, 下次重建', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.select.mockRejectedValueOnce(new Error('ERR DB index is out of range'));

      await expect(driver.getString(99, 'k')).rejects.toThrow('out of range');
      expect(dbsOf(mockClient.disconnect)).toEqual([99]);

      await driver.getString(99, 'k');
      expect(instances.map((c) => c.options.db)).toEqual([0, 99, 99]);
    });

    it('connect 失败时断开 client, 不留后台重连的僵尸连接', async () => {
      mockClient.ping.mockRejectedValueOnce(new Error('NOAUTH'));

      await expect(driver.connect(TEST_CONFIG)).rejects.toThrow('NOAUTH');

      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('executeCommandInDb (CLI / MCP)', () => {
    it('每条命令在带超时的一次性连接上跑, 用完即断, 不进按库缓存', async () => {
      await driver.connect(TEST_CONFIG);
      mockClient.call.mockResolvedValue('v');

      expect(await driver.executeCommandInDb(3, ['GET', 'k'])).toBe('v');
      await driver.executeCommandInDb(undefined, ['PING']);

      expect(instances.slice(1).map((c) => [c.options.db, c.options.commandTimeout])).toEqual([[3, 30000], [0, 30000]]);
      expect(mockClient.call.mock.contexts).toEqual([instances[1], instances[2]]);
      expect(mockClient.disconnect.mock.contexts).toEqual([instances[1], instances[2]]);
      // 之后 db3 的浏览操作另建常驻 client, 不复用 CLI 那条
      await driver.getString(3, 'k');
      expect(instances).toHaveLength(4);
    });

    it('拒绝 SUBSCRIBE / PSUBSCRIBE / SSUBSCRIBE / MONITOR, 不建连接', async () => {
      await driver.connect(TEST_CONFIG);
      for (const cmd of ['subscribe', 'PSUBSCRIBE', 'SSUBSCRIBE', 'monitor']) {
        await expect(driver.executeCommandInDb(0, [cmd, 'ch'])).rejects.toThrow('streams replies');
      }
      expect(instances).toHaveLength(1);
    });

    it('空 args 抛错', async () => {
      await driver.connect(TEST_CONFIG);
      await expect(driver.executeCommandInDb(0, [])).rejects.toThrow('No command provided');
    });
  });

  describe('readKeyRaw / writeKeyRaw', () => {
    beforeEach(async () => {
      await driver.connect(TEST_CONFIG);
    });

    it('hash 按 Buffer 跑完整轮 HSCAN', async () => {
      mockClient.type.mockResolvedValueOnce('hash');
      mockClient.hscanBuffer
        .mockResolvedValueOnce([Buffer.from('7'), [Buffer.from('f1'), Buffer.from([0xff])]])
        .mockResolvedValueOnce([Buffer.from('0'), [Buffer.from('f2'), Buffer.from('v2')]]);
      mockClient.ttl.mockResolvedValueOnce(60);

      const raw = await driver.readKeyRaw(0, Buffer.from('h'));

      expect(mockClient.hscanBuffer).toHaveBeenNthCalledWith(2, Buffer.from('h'), '7', 'COUNT', 1000);
      expect(raw).toEqual({ type: 'hash', ttl: 60, items: [Buffer.from('f1'), Buffer.from([0xff]), Buffer.from('f2'), Buffer.from('v2')] });
    });

    it('scanAllKeys 跑完整轮 SCAN 并去掉重复返回的 key', async () => {
      mockClient.scanBuffer
        .mockResolvedValueOnce([Buffer.from('5'), [Buffer.from('a'), Buffer.from([0xff])]])
        .mockResolvedValueOnce([Buffer.from('0'), [Buffer.from('a'), Buffer.from('b')]]);

      const keys = await driver.scanAllKeys(0, 'p:*');

      expect(mockClient.scanBuffer).toHaveBeenNthCalledWith(2, '5', 'MATCH', 'p:*', 'COUNT', 1000);
      expect(keys).toEqual([Buffer.from('a'), Buffer.from([0xff]), Buffer.from('b')]);
    });

    it('TYPE 之后 key 消失时 type 为 none', async () => {
      mockClient.type.mockResolvedValueOnce('string');
      mockClient.getBuffer.mockResolvedValueOnce(null);

      expect((await driver.readKeyRaw(0, Buffer.from('gone'))).type).toBe('none');
    });

    it('zset: 一个 MULTI 里 DEL + ZADD (score 在前) + EXPIRE', async () => {
      const tx = {
        del: vi.fn().mockReturnThis(), call: vi.fn().mockReturnThis(), expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 1], [null, 2], [null, 1]]),
      };
      mockClient.multi.mockReturnValue(tx);
      const key = Buffer.from('z');

      await driver.writeKeyRaw(0, key, { type: 'zset', ttl: 60, items: ['m1', '1', 'm2', '2'].map((v) => Buffer.from(v)) });

      expect(tx.del).toHaveBeenCalledWith(key);
      expect(tx.call).toHaveBeenCalledWith('ZADD', key, ...['1', 'm1', '2', 'm2'].map((v) => Buffer.from(v)));
      expect(tx.expire).toHaveBeenCalledWith(key, 60);
    });

    it('MULTI 内某条命令出错时抛出; 不支持的类型不开 MULTI', async () => {
      const tx = {
        del: vi.fn().mockReturnThis(), call: vi.fn().mockReturnThis(), expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 0], [new Error('OOM'), null]]),
      };
      mockClient.multi.mockReturnValue(tx);

      await expect(driver.writeKeyRaw(0, Buffer.from('s'), { type: 'set', ttl: -1, items: [Buffer.from('a')] })).rejects.toThrow('OOM');
      expect(tx.expire).not.toHaveBeenCalled();

      mockClient.multi.mockClear();
      await expect(driver.writeKeyRaw(0, Buffer.from('x'), { type: 'stream', ttl: -1, items: [] })).rejects.toThrow('Unsupported type: stream');
      expect(mockClient.multi).not.toHaveBeenCalled();
    });
  });
});
