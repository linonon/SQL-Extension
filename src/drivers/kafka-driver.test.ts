import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KafkaDriver } from './kafka-driver';

// Mock kafkajs
const mockAdmin = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  listTopics: vi.fn().mockResolvedValue(['topic-a', 'topic-b']),
  fetchTopicMetadata: vi.fn().mockResolvedValue({
    topics: [
      { name: 'topic-a', partitions: [{ partitionId: 0 }, { partitionId: 1 }] },
      { name: 'topic-b', partitions: [{ partitionId: 0 }] },
    ],
  }),
  fetchTopicOffsets: vi.fn().mockResolvedValue([
    { partition: 0, high: '100', low: '0' },
    { partition: 1, high: '50', low: '0' },
  ]),
  deleteGroups: vi.fn().mockResolvedValue([]),
};

const mockConsumer = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
  seek: vi.fn(),
};

const consumerOptions: unknown[] = [];

vi.mock('kafkajs', () => {
  class MockKafka {
    admin() { return mockAdmin; }
    consumer(options: unknown) { consumerOptions.push(options); return mockConsumer; }
  }
  return { Kafka: MockKafka };
});

const TEST_CONFIG = {
  id: 'test-id',
  name: 'test-kafka',
  driverType: 'kafka' as const,
  host: 'localhost',
  port: 9092,
  username: '',
  password: '',
  database: '',
};

describe('KafkaDriver', () => {
  let driver: KafkaDriver;

  beforeEach(() => {
    driver = new KafkaDriver();
    vi.clearAllMocks();
  });

  describe('connect', () => {
    it('应该调用 admin.connect() + listTopics() 验证连通性', async () => {
      await driver.connect(TEST_CONFIG);

      expect(mockAdmin.connect).toHaveBeenCalled();
      expect(mockAdmin.listTopics).toHaveBeenCalled();
      expect(driver.isConnected()).toBe(true);
    });

    it('有 SASL 凭证时应该正常连接', async () => {
      await driver.connect({
        ...TEST_CONFIG,
        username: 'admin',
        password: 'secret',
      });

      expect(mockAdmin.connect).toHaveBeenCalled();
      expect(driver.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('应该调用 admin.disconnect()', async () => {
      await driver.connect(TEST_CONFIG);
      await driver.disconnect();

      expect(mockAdmin.disconnect).toHaveBeenCalled();
      expect(driver.isConnected()).toBe(false);
    });

    it('未连接时 disconnect 安全执行', async () => {
      await driver.disconnect();
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('未连接时返回 false', () => {
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('listTopics', () => {
    it('返回 topic 列表 + partition count', async () => {
      await driver.connect(TEST_CONFIG);

      const topics = await driver.listTopics();

      expect(topics).toEqual([
        { name: 'topic-a', partitionCount: 2 },
        { name: 'topic-b', partitionCount: 1 },
      ]);
    });

    it('空 topic 列表', async () => {
      await driver.connect(TEST_CONFIG);
      mockAdmin.listTopics.mockResolvedValueOnce([]);

      const topics = await driver.listTopics();

      expect(topics).toEqual([]);
    });

    it('未连接时抛错', async () => {
      await expect(driver.listTopics()).rejects.toThrow('Not connected');
    });
  });

  describe('getTopicPartitions', () => {
    it('返回 partition offset 信息', async () => {
      await driver.connect(TEST_CONFIG);
      mockAdmin.fetchTopicMetadata.mockResolvedValueOnce({
        topics: [{ name: 'topic-a', partitions: [
          { partitionId: 0, leader: 1 },
          { partitionId: 1, leader: 2 },
        ] }],
      });

      const partitions = await driver.getTopicPartitions('topic-a');

      expect(partitions).toEqual([
        { partitionId: 0, leader: 1, offset: '100' },
        { partitionId: 1, leader: 2, offset: '50' },
      ]);
    });

    it('未连接时抛错', async () => {
      await expect(driver.getTopicPartitions('t')).rejects.toThrow('Not connected');
    });
  });

  describe('fetchMessages', () => {
    it('未连接时抛错', async () => {
      await expect(driver.fetchMessages('t', 0, '0', 10)).rejects.toThrow('Not connected');
    });

    it('应该创建 consumer, subscribe, seek, 然后 disconnect', async () => {
      await driver.connect(TEST_CONFIG);

      // 模拟 run 回调: 立即触发 eachBatch (limit=1, 收到 1 条后 resolve)
      mockConsumer.run.mockImplementation(async ({ eachBatch }: { eachBatch: Function }) => {
        await eachBatch({
          batch: {
            partition: 0,
            messages: [
              {
                offset: '10',
                key: Buffer.from('key1'),
                value: Buffer.from('value1'),
                timestamp: '1700000000000',
                headers: { 'x-id': Buffer.from('abc') },
              },
            ],
          },
        });
      });

      const { messages, timedOut } = await driver.fetchMessages('topic-a', 0, '10', 1);

      expect(mockConsumer.connect).toHaveBeenCalled();
      expect(mockConsumer.subscribe).toHaveBeenCalledWith({ topic: 'topic-a', fromBeginning: true });
      expect(mockConsumer.seek).toHaveBeenCalledWith({ topic: 'topic-a', partition: 0, offset: '10' });
      expect(mockConsumer.disconnect).toHaveBeenCalled();
      expect(messages).toEqual([{
        partition: 0,
        offset: '10',
        key: 'key1',
        value: 'value1',
        timestamp: '1700000000000',
        headers: { 'x-id': 'abc' },
      }]);
      expect(timedOut).toBe(false);
    });

    it('重复 header key (kafkajs 解码为数组) 逐个解码后拼接', async () => {
      await driver.connect(TEST_CONFIG);
      mockConsumer.run.mockImplementation(async ({ eachBatch }: { eachBatch: Function }) => {
        await eachBatch({
          batch: {
            partition: 0,
            messages: [{
              offset: '1',
              key: null,
              value: Buffer.from('v'),
              timestamp: '0',
              headers: { trace: [Buffer.from('a'), 'b'], empty: undefined },
            }],
          },
        });
      });

      const { messages: [msg] } = await driver.fetchMessages('topic-a', 0, '1', 1);

      expect(msg.headers).toEqual({ trace: 'a, b', empty: '' });
    });

    it('不提交 offset, 断开后删掉这次的一次性 group', async () => {
      await driver.connect(TEST_CONFIG);
      consumerOptions.length = 0;
      mockConsumer.run.mockImplementation(async ({ eachBatch }: { eachBatch: Function }) => {
        await eachBatch({ batch: { partition: 0, messages: [{ offset: '1', key: null, value: null, timestamp: '0' }] } });
      });

      await driver.fetchMessages('topic-a', 0, '1', 1);

      expect(mockConsumer.run).toHaveBeenCalledWith(expect.objectContaining({ autoCommit: false }));
      const { groupId } = consumerOptions[0] as { groupId: string };
      expect(mockAdmin.deleteGroups).toHaveBeenCalledWith([groupId]);
      expect(mockConsumer.disconnect.mock.invocationCallOrder[0])
        .toBeLessThan(mockAdmin.deleteGroups.mock.invocationCallOrder[0]);
    });

    it('等消息的 3 秒从加入 group 之后才计时; 到点一条没收到回 timedOut, 删 group 失败不影响结果', async () => {
      vi.useFakeTimers();
      try {
        await driver.connect(TEST_CONFIG);
        mockAdmin.deleteGroups.mockRejectedValueOnce(new Error('GROUP_ID_NOT_FOUND'));
        let joined!: () => void;
        mockConsumer.run.mockImplementation(() => new Promise<void>((resolve) => { joined = resolve; }));
        let settled = false;
        const pending = driver.fetchMessages('topic-a', 0, '0', 10).finally(() => { settled = true; });

        // join 耗时 (如 broker 的 initial rebalance delay) 不占等消息的时间
        await vi.advanceTimersByTimeAsync(5000);
        expect(settled).toBe(false);
        joined();
        await vi.advanceTimersByTimeAsync(2999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        await expect(pending).resolves.toEqual({ messages: [], timedOut: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
