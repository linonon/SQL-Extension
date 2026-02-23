export interface RmqQueueInfo {
  readonly name: string;
  readonly messages: number;
  readonly consumers: number;
  readonly state: string;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly type: string;
}

export interface RmqMessage {
  readonly payload: string;
  readonly payloadEncoding: string;
  readonly exchange: string;
  readonly routingKey: string;
  readonly redelivered: boolean;
  readonly properties: RmqMessageProperties;
}

export interface RmqMessageProperties {
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly deliveryMode: number | null;
  readonly headers: Record<string, unknown>;
  readonly timestamp: number | null;
  readonly messageId: string | null;
  readonly appId: string | null;
}
