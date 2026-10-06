import type { WebviewMessage } from '../types/messages.js';
import type { IKafkaDriver } from '../types/kafka-driver.js';
import { sanitizeErrorMessage } from '../utils/sanitize-error.js';

// 出错时回该请求自己的回执类型并带 error: KafkaBrowser 据此结束 loading 并显示错误
export async function handleKafkaMessage(
  message: WebviewMessage,
  driver: IKafkaDriver,
  post: (msg: unknown) => void
): Promise<boolean> {
  try {
    return await routeKafkaMessage(message, driver, post);
  } catch (err) {
    const error = sanitizeErrorMessage(err);
    switch (message.type) {
      case 'kafkaListTopics':
        post({ type: 'kafkaTopicList', topics: [], error });
        break;
      case 'kafkaGetPartitions':
        post({ type: 'kafkaPartitionList', topic: message.topic, partitions: [], error });
        break;
      case 'kafkaFetchMessages':
      case 'kafkaFetchLatest':
      case 'kafkaFetchByTimestamp':
        post({ type: 'kafkaMessageList', topic: message.topic, partition: message.partition, messages: [], timedOut: false, error });
        break;
      default:
        throw err;
    }
    return true;
  }
}

async function routeKafkaMessage(
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
      await fetchAndPost(driver, post, message.topic, message.partition, message.offset, message.limit);
      return true;
    }

    case 'kafkaFetchLatest': {
      // 现取 high watermark: 打开 topic 时拿到的旧值看不到之后写入的消息; 顺带刷新 partition 下拉里的 offset
      const partitions = await driver.getTopicPartitions(message.topic);
      post({ type: 'kafkaPartitionList', topic: message.topic, partitions });
      const high = Number(partitions.find((p) => p.partitionId === message.partition)?.offset ?? 0);
      await fetchAndPost(driver, post, message.topic, message.partition, String(Math.max(0, high - message.limit)), message.limit);
      return true;
    }

    case 'kafkaFetchByTimestamp': {
      const offset = await driver.fetchOffsetByTimestamp(
        message.topic,
        message.partition,
        message.timestamp
      );
      await fetchAndPost(driver, post, message.topic, message.partition, offset, message.limit);
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

async function fetchAndPost(
  driver: IKafkaDriver,
  post: (msg: unknown) => void,
  topic: string,
  partition: number,
  offset: string,
  limit: number
): Promise<void> {
  const { messages, timedOut } = await driver.fetchMessages(topic, partition, offset, limit);
  post({ type: 'kafkaMessageList', topic, partition, messages, timedOut });
}
