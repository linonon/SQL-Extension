import type { ConnectionConfig } from './connection.js';
import type { RabbitMQQueueInfo, RabbitMQMessage } from './rabbitmq.js';

export interface IRabbitMQDriver {
  readonly driverType: 'rabbitmq';
  connect(config: ConnectionConfig & { readonly password: string }): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  listQueues(): Promise<readonly RabbitMQQueueInfo[]>;
  peekMessages(queue: string, count: number): Promise<readonly RabbitMQMessage[]>;
}
