import type { WebviewMessage } from '../types/messages.js';
import type { IKafkaDriver } from '../types/kafka-driver.js';

export async function handleKafkaMessage(
  message: WebviewMessage,
  driver: IKafkaDriver,
  post: (msg: unknown) => void
): Promise<boolean> {
  switch (message.type) {
    case 'kafkaListTopics': {
      const topics = await driver.listTopics();
      post({ type: 'kafkaTopicList', topics });
      return true;
    }

    case 'kafkaGetPartitions': {
      const partitions = await driver.getTopicPartitions(message.topic);
      post({ type: 'kafkaPartitionList', topic: message.topic, partitions });
      return true;
    }

    case 'kafkaFetchMessages': {
      const messages = await driver.fetchMessages(
        message.topic,
        message.partition,
        message.offset,
        message.limit
      );
      post({
        type: 'kafkaMessageList',
        topic: message.topic,
        partition: message.partition,
        messages,
      });
      return true;
    }

    case 'kafkaFetchByTimestamp': {
      const offset = await driver.fetchOffsetByTimestamp(
        message.topic,
        message.partition,
        message.timestamp
      );
      const messages = await driver.fetchMessages(
        message.topic,
        message.partition,
        offset,
        message.limit
      );
      post({
        type: 'kafkaMessageList',
        topic: message.topic,
        partition: message.partition,
        messages,
      });
      return true;
    }

    case 'kafkaProduceMessage': {
      try {
        const result = await driver.produceMessage(
          message.topic,
          message.key,
          message.value,
          message.headers,
          message.partition
        );
        post({
          type: 'kafkaProduceResult',
          success: true,
          partition: result.partition,
          offset: result.offset,
        });
      } catch (err) {
        post({
          type: 'kafkaProduceResult',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    default:
      return false;
  }
}
