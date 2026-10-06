import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleKafkaMessage } from './kafka-message-handler';
import type { IKafkaDriver } from '../types/kafka-driver';

function createMockDriver(): IKafkaDriver {
  return {
    driverType: 'kafka',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ping: vi.fn().mockResolvedValue(undefined),
    listTopics: vi.fn().mockResolvedValue([
      { name: 'topic-a', partitionCount: 2 },
    ]),
    getTopicPartitions: vi.fn().mockResolvedValue([
      { partitionId: 0, leader: 1, offset: '100' },
    ]),
    fetchMessages: vi.fn().mockResolvedValue({
      messages: [{
        partition: 0,
        offset: '50',
        key: 'k1',
        value: '{"msg":"hello"}',
        timestamp: '1700000000000',
        headers: {},
      }],
      timedOut: false,
    }),
    fetchOffsetByTimestamp: vi.fn().mockResolvedValue('0'),
    produceMessage: vi.fn().mockResolvedValue({ partition: 0, offset: '0' }),
  };
}

describe('handleKafkaMessage', () => {
  let driver: IKafkaDriver;
  let post: Mock<(msg: unknown) => void>;

  beforeEach(() => {
    driver = createMockDriver();
    post = vi.fn();
  });

  it('kafkaListTopics: 调用 listTopics, post kafkaTopicList', async () => {
    const handled = await handleKafkaMessage(
      { type: 'kafkaListTopics' } as any,
      driver,
      post
    );

    expect(handled).toBe(true);
    expect(driver.listTopics).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({
      type: 'kafkaTopicList',
      topics: [{ name: 'topic-a', partitionCount: 2 }],
    });
  });

  it('kafkaGetPartitions: 调用 getTopicPartitions, post kafkaPartitionList', async () => {
    const handled = await handleKafkaMessage(
      { type: 'kafkaGetPartitions', topic: 'topic-a' } as any,
      driver,
      post
    );

    expect(handled).toBe(true);
    expect(driver.getTopicPartitions).toHaveBeenCalledWith('topic-a');
    expect(post).toHaveBeenCalledWith({
      type: 'kafkaPartitionList',
      topic: 'topic-a',
      partitions: [{ partitionId: 0, leader: 1, offset: '100' }],
    });
  });

  it('kafkaFetchMessages: 调用 fetchMessages, post kafkaMessageList', async () => {
    const handled = await handleKafkaMessage(
      { type: 'kafkaFetchMessages', topic: 'topic-a', partition: 0, offset: '50', limit: 10 } as any,
      driver,
      post
    );

    expect(handled).toBe(true);
    expect(driver.fetchMessages).toHaveBeenCalledWith('topic-a', 0, '50', 10);
    expect(post).toHaveBeenCalledWith({
      type: 'kafkaMessageList',
      topic: 'topic-a',
      partition: 0,
      messages: [{
        partition: 0,
        offset: '50',
        key: 'k1',
        value: '{"msg":"hello"}',
        timestamp: '1700000000000',
        headers: {},
      }],
      timedOut: false,
    });
  });

  it('kafkaFetchLatest: 现取 high watermark 再拉最后 limit 条, 并回刷新后的 partition 列表', async () => {
    (driver.getTopicPartitions as Mock).mockResolvedValue([
      { partitionId: 0, leader: 1, offset: '100' },
      { partitionId: 1, leader: 1, offset: '30' },
    ]);
    (driver.fetchMessages as Mock).mockResolvedValue({ messages: [], timedOut: true });

    await handleKafkaMessage({ type: 'kafkaFetchLatest', topic: 'topic-a', partition: 1, limit: 50 }, driver, post);

    expect(driver.getTopicPartitions).toHaveBeenCalledWith('topic-a');
    expect(driver.fetchMessages).toHaveBeenCalledWith('topic-a', 1, '0', 50);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'kafkaPartitionList', topic: 'topic-a' }));
    expect(post).toHaveBeenLastCalledWith({ type: 'kafkaMessageList', topic: 'topic-a', partition: 1, messages: [], timedOut: true });

    await handleKafkaMessage({ type: 'kafkaFetchLatest', topic: 'topic-a', partition: 0, limit: 50 }, driver, post);
    expect(driver.fetchMessages).toHaveBeenLastCalledWith('topic-a', 0, '50', 50);
  });

  it('出错时回该请求自己的回执并带 error, webview 据此结束 loading', async () => {
    (driver.listTopics as Mock).mockRejectedValueOnce(new Error('Connection timeout'));
    (driver.getTopicPartitions as Mock).mockRejectedValueOnce(new Error('UNKNOWN_TOPIC_OR_PARTITION'));
    (driver.fetchMessages as Mock).mockRejectedValueOnce(new Error('Broker not available'));

    expect(await handleKafkaMessage({ type: 'kafkaListTopics' }, driver, post)).toBe(true);
    await handleKafkaMessage({ type: 'kafkaGetPartitions', topic: 't' }, driver, post);
    await handleKafkaMessage({ type: 'kafkaFetchLatest', topic: 't', partition: 2, limit: 50 }, driver, post);

    expect(post.mock.calls.map(([m]) => m)).toEqual([
      { type: 'kafkaTopicList', topics: [], error: 'Connection timeout' },
      { type: 'kafkaPartitionList', topic: 't', partitions: [], error: 'UNKNOWN_TOPIC_OR_PARTITION' },
      expect.objectContaining({ type: 'kafkaPartitionList', topic: 't' }),
      { type: 'kafkaMessageList', topic: 't', partition: 2, messages: [], timedOut: false, error: 'Broker not available' },
    ]);
  });

  it('未知消息类型: 返回 false', async () => {
    const handled = await handleKafkaMessage(
      { type: 'unknownType' } as any,
      driver,
      post
    );

    expect(handled).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
