import type { WebviewMessage } from '../types/messages.js';
import type { IRabbitMQDriver } from '../types/rabbitmq-driver.js';

export async function handleRabbitMQMessage(
  message: WebviewMessage,
  driver: IRabbitMQDriver,
  post: (msg: unknown) => void
): Promise<boolean> {
  switch (message.type) {
    case 'rmqListQueues': {
      const queues = await driver.listQueues();
      post({ type: 'rmqQueueList', queues });
      return true;
    }

    case 'rmqPeekMessages': {
      const messages = await driver.peekMessages(message.queue, message.count);
      post({ type: 'rmqMessageList', queue: message.queue, messages });
      return true;
    }

    default:
      return false;
  }
}
