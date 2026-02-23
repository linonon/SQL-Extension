export interface KafkaTopicInfo {
  readonly name: string;
  readonly partitionCount: number;
}

export interface KafkaPartitionInfo {
  readonly partitionId: number;
  readonly leader: number;
  readonly offset: string;
}

export interface KafkaMessage {
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly value: string | null;
  readonly timestamp: string;
  readonly headers: Record<string, string>;
}

export interface KafkaProduceResult {
  readonly partition: number;
  readonly offset: string;
}
