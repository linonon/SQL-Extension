import { Kafka, type Admin, type Consumer, type SASLOptions } from 'kafkajs';
import type { ConnectionConfig } from '../types/connection.js';
import type { IKafkaDriver } from '../types/kafka-driver.js';
import type { KafkaTopicInfo, KafkaPartitionInfo, KafkaMessage, KafkaProduceResult } from '../types/kafka.js';

export class KafkaDriver implements IKafkaDriver {
  readonly driverType = 'kafka' as const;

  private kafka: Kafka | null = null;
  private admin: Admin | null = null;
  private connected = false;

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    const broker = `${config.host}:${config.port}`;

    const sasl: SASLOptions | undefined =
      config.username && config.password
        ? { mechanism: 'plain', username: config.username, password: config.password }
        : undefined;

    this.kafka = new Kafka({
      clientId: 'sqlext-browser',
      brokers: [broker],
      ssl: sasl ? true : undefined,
      sasl,
      connectionTimeout: 5000,
      requestTimeout: 10000,
    });

    this.admin = this.kafka.admin();
    await this.admin.connect();
    // 验证连通性
    await this.admin.listTopics();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.admin) {
      await this.admin.disconnect();
      this.admin = null;
    }
    this.kafka = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ping(): Promise<void> {
    if (!this.admin) { throw new Error('Kafka admin is not connected'); }
    await this.admin.listTopics();
  }

  async listTopics(): Promise<readonly KafkaTopicInfo[]> {
    if (!this.admin) { throw new Error('Not connected'); }

    const topicNames = await this.admin.listTopics();
    if (topicNames.length === 0) { return []; }

    const metadata = await this.admin.fetchTopicMetadata({ topics: topicNames });
    return metadata.topics.map((t) => ({
      name: t.name,
      partitionCount: t.partitions.length,
    }));
  }

  async getTopicPartitions(topic: string): Promise<readonly KafkaPartitionInfo[]> {
    if (!this.admin) { throw new Error('Not connected'); }

    const offsets = await this.admin.fetchTopicOffsets(topic);
    const metadata = await this.admin.fetchTopicMetadata({ topics: [topic] });
    const topicMeta = metadata.topics[0];

    return offsets.map((o) => {
      const partMeta = topicMeta?.partitions.find((p) => p.partitionId === o.partition);
      return {
        partitionId: o.partition,
        leader: partMeta?.leader ?? -1,
        offset: o.high,
      };
    });
  }

  async fetchMessages(
    topic: string,
    partition: number,
    offset: string,
    limit: number
  ): Promise<readonly KafkaMessage[]> {
    if (!this.kafka) { throw new Error('Not connected'); }

    // maxWaitTimeInMs: broker 端 long-poll 等待时间.
    // 默认 5000ms, 会导致空 fetch (seek 还没生效时) 卡 5 秒.
    // 设 200ms: 空 fetch 快速返回, 下一轮 fetch 就能用 seek offset.
    const consumer: Consumer = this.kafka.consumer({
      groupId: `sqlext-browse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      maxWaitTimeInMs: 200,
    });
    const messages: KafkaMessage[] = [];

    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });

      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 3000);

        consumer.run({
          eachBatchAutoResolve: true,
          eachBatch: async ({ batch }) => {
            if (batch.partition !== partition) { return; }

            for (const msg of batch.messages) {
              const headers: Record<string, string> = {};
              if (msg.headers) {
                for (const [k, v] of Object.entries(msg.headers)) {
                  headers[k] = v ? Buffer.from(v).toString('utf-8') : '';
                }
              }

              messages.push({
                partition: batch.partition,
                offset: msg.offset,
                key: msg.key ? msg.key.toString('utf-8') : null,
                value: msg.value ? msg.value.toString('utf-8') : null,
                timestamp: msg.timestamp,
                headers,
              });

              if (messages.length >= limit) {
                clearTimeout(timeout);
                resolve();
                return;
              }
            }
          },
        }).catch(reject);
      });

      consumer.seek({ topic, partition, offset });
      await done;
    } finally {
      await consumer.disconnect();
    }

    return messages;
  }

  async fetchOffsetByTimestamp(topic: string, partition: number, timestamp: number): Promise<string> {
    if (!this.admin) { throw new Error('Not connected'); }

    const offsets = await this.admin.fetchTopicOffsetsByTimestamp(topic, timestamp);
    const match = offsets.find((o) => o.partition === partition);
    if (!match) { throw new Error(`Partition ${partition} not found for topic ${topic}`); }
    return match.offset;
  }

  async produceMessage(
    topic: string,
    key: string | null,
    value: string,
    headers: Record<string, string>,
    partition?: number
  ): Promise<KafkaProduceResult> {
    if (!this.kafka) { throw new Error('Not connected'); }

    const producer = this.kafka.producer();
    try {
      await producer.connect();
      const result = await producer.send({
        topic,
        messages: [{
          key: key ?? undefined,
          value,
          headers,
          partition,
        }],
      });
      const record = result[0];
      return { partition: record.partition, offset: record.baseOffset };
    } finally {
      await producer.disconnect();
    }
  }
}
