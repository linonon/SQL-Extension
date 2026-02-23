import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleKafkaMessage } from './kafka-message-handler';
import type { IKafkaDriver } from '../types/kafka-driver';

function createMockDriver(): IKafkaDriver {
  return {
    driverType: 'kafka',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    listTopics: vi.fn().mockResolvedValue([
      { name: 'topic-a', partitionCount: 2 },
    ]),
    getTopicPartitions: vi.fn().mockResolvedValue([
      { partitionId: 0, leader: 1, offset: '100' },
    ]),
    fetchMessages: vi.fn().mockResolvedValue([
      {
        partition: 0,
        offset: '50',
        key: 'k1',
        value: '{"msg":"hello"}',
        timestamp: '1700000000000',
        headers: {},
      },
    ]),
  };
}

describe('handleKafkaMessage', () => {
  let driver: IKafkaDriver;
  let post: ReturnType<typeof vi.fn>;

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
    });
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
