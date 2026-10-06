import type { ConnectionConfig } from './connection.js';
import type { KafkaTopicInfo, KafkaPartitionInfo, KafkaFetchResult, KafkaProduceResult } from './kafka.js';

export interface IKafkaDriver {
  readonly driverType: 'kafka';

  connect(config: ConnectionConfig & { readonly password: string }): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<void>;

  listTopics(): Promise<readonly KafkaTopicInfo[]>;
  getTopicPartitions(topic: string): Promise<readonly KafkaPartitionInfo[]>;
  // 一次性 consumer 读完即断, 不提交 offset, 用完删掉它的 group
  fetchMessages(topic: string, partition: number, offset: string, limit: number): Promise<KafkaFetchResult>;
  fetchOffsetByTimestamp(topic: string, partition: number, timestamp: number): Promise<string>;
  produceMessage(topic: string, key: string | null, value: string, headers: Record<string, string>, partition?: number): Promise<KafkaProduceResult>;
}
