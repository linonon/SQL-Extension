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

export interface KafkaFetchResult {
  readonly messages: readonly KafkaMessage[];
  // 加入 group 后等满超时仍一条消息也没收到 (offset 之后暂无消息)
  readonly timedOut: boolean;
}

export interface KafkaProduceResult {
  readonly partition: number;
  readonly offset?: string;
}
