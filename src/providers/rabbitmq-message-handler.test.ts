import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRabbitMQMessage } from './rabbitmq-message-handler';
import type { IRabbitMQDriver } from '../types/rabbitmq-driver';
import type { WebviewMessage } from '../types/messages';

function createMockDriver(): IRabbitMQDriver {
  return {
    driverType: 'rabbitmq',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    listQueues: vi.fn().mockResolvedValue([]),
    peekMessages: vi.fn().mockResolvedValue([]),
  };
}

describe('handleRabbitMQMessage', () => {
  let driver: IRabbitMQDriver;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    driver = createMockDriver();
    postMessage = vi.fn();
  });

  it('非 RabbitMQ 消息返回 false', async () => {
    const msg = { type: 'executeQuery', database: 'test', sql: 'SELECT 1' } as WebviewMessage;
    const handled = await handleRabbitMQMessage(msg, driver, postMessage);
    expect(handled).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  describe('rmqListQueues', () => {
    it('调用 driver.listQueues, 返回 rmqQueueList', async () => {
      const queues = [{ name: 'q1', messages: 5, consumers: 2 }];
      (driver.listQueues as any).mockResolvedValue(queues);

      const msg = { type: 'rmqListQueues' } as WebviewMessage;
      const handled = await handleRabbitMQMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.listQueues).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'rmqQueueList',
        queues,
      });
    });

    it('driver 抛错时 promise reject', async () => {
      (driver.listQueues as any).mockRejectedValue(new Error('Connection lost'));

      const msg = { type: 'rmqListQueues' } as WebviewMessage;
      await expect(handleRabbitMQMessage(msg, driver, postMessage)).rejects.toThrow('Connection lost');
    });
  });

  describe('rmqPeekMessages', () => {
    it('调用 driver.peekMessages, 返回 rmqMessageList', async () => {
      const messages = [
        { content: 'hello', properties: {}, fields: {} },
        { content: 'world', properties: {}, fields: {} },
      ];
      (driver.peekMessages as any).mockResolvedValue(messages);

      const msg = { type: 'rmqPeekMessages', queue: 'my-queue', count: 10 } as WebviewMessage;
      const handled = await handleRabbitMQMessage(msg, driver, postMessage);

      expect(handled).toBe(true);
      expect(driver.peekMessages).toHaveBeenCalledWith('my-queue', 10);
      expect(postMessage).toHaveBeenCalledWith({
        type: 'rmqMessageList',
        queue: 'my-queue',
        messages,
      });
    });

    it('driver 抛错时 promise reject', async () => {
      (driver.peekMessages as any).mockRejectedValue(new Error('Queue not found'));

      const msg = { type: 'rmqPeekMessages', queue: 'bad-queue', count: 5 } as WebviewMessage;
      await expect(handleRabbitMQMessage(msg, driver, postMessage)).rejects.toThrow('Queue not found');
    });
  });
});
