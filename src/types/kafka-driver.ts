import type { ConnectionConfig } from './connection.js';
import type { KafkaTopicInfo, KafkaPartitionInfo, KafkaMessage, KafkaProduceResult } from './kafka.js';

export interface IKafkaDriver {
  readonly driverType: 'kafka';

  connect(config: ConnectionConfig & { readonly password: string }): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<void>;

  listTopics(): Promise<readonly KafkaTopicInfo[]>;
  getTopicPartitions(topic: string): Promise<readonly KafkaPartitionInfo[]>;
  fetchMessages(topic: string, partition: number, offset: string, limit: number): Promise<readonly KafkaMessage[]>;
  fetchOffsetByTimestamp(topic: string, partition: number, timestamp: number): Promise<string>;
  produceMessage(topic: string, key: string | null, value: string, headers: Record<string, string>, partition?: number): Promise<KafkaProduceResult>;
}
