import * as http from 'http';
import * as https from 'https';
import type { ConnectionConfig } from '../types/connection.js';
import type { IRabbitMQDriver } from '../types/rabbitmq-driver.js';
import type { RabbitMQQueueInfo, RabbitMQMessage } from '../types/rabbitmq.js';

interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: string;
}

// Management API 返回的 queue 原始结构
interface RawQueue {
  readonly name: string;
  readonly messages: number;
  readonly consumers: number;
  readonly state: string;
  readonly durable: boolean;
  readonly auto_delete: boolean;
  readonly type: string;
}

// Management API 返回的 message 原始结构
interface RawMessage {
  readonly payload: string;
  readonly payload_encoding: string;
  readonly exchange: string;
  readonly routing_key: string;
  readonly redelivered: boolean;
  readonly properties: {
    readonly content_type: string | null;
    readonly content_encoding: string | null;
    readonly delivery_mode: number | null;
    readonly headers: Record<string, unknown> | null;
    readonly timestamp: number | null;
    readonly message_id: string | null;
    readonly app_id: string | null;
  };
}

export class RabbitMQDriver implements IRabbitMQDriver {
  readonly driverType = 'rabbitmq' as const;

  private host = '';
  private port = 15672;
  private authHeader = '';
  private vhost = '/';
  private useHttps = false;
  private connected = false;

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    this.host = config.host;
    this.port = config.port;
    this.authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
    this.vhost = config.database || '/';

    // 验证连通性
    await this.request({ method: 'GET', path: '/api/overview' });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.host = '';
    this.port = 15672;
    this.authHeader = '';
    this.vhost = '/';
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ping(): Promise<void> {
    if (!this.connected) { throw new Error('RabbitMQ is not connected'); }
    await this.request({ method: 'GET', path: '/api/overview' });
  }

  async listQueues(): Promise<readonly RabbitMQQueueInfo[]> {
    if (!this.connected) { throw new Error('Not connected'); }

    const encodedVhost = encodeURIComponent(this.vhost);
    const raw = await this.request({ method: 'GET', path: `/api/queues/${encodedVhost}` });
    const queues = JSON.parse(raw) as readonly RawQueue[];

    return queues.map((q) => ({
      name: q.name,
      messages: q.messages,
      consumers: q.consumers,
      state: q.state,
      durable: q.durable,
      autoDelete: q.auto_delete,
      type: q.type,
    }));
  }

  async peekMessages(queue: string, count: number): Promise<readonly RabbitMQMessage[]> {
    if (!this.connected) { throw new Error('Not connected'); }

    const encodedVhost = encodeURIComponent(this.vhost);
    const encodedQueue = encodeURIComponent(queue);
    const body = JSON.stringify({
      count: Math.min(count, 50),
      ackmode: 'ack_requeue_true',
      encoding: 'auto',
      truncate: 50000,
    });

    const raw = await this.request({
      method: 'POST',
      path: `/api/queues/${encodedVhost}/${encodedQueue}/get`,
      body,
    });
    const messages = JSON.parse(raw) as readonly RawMessage[];

    return messages.map((m) => ({
      payload: m.payload,
      payloadEncoding: m.payload_encoding,
      exchange: m.exchange,
      routingKey: m.routing_key,
      redelivered: m.redelivered,
      properties: {
        contentType: m.properties.content_type ?? null,
        contentEncoding: m.properties.content_encoding ?? null,
        deliveryMode: m.properties.delivery_mode ?? null,
        headers: m.properties.headers ?? {},
        timestamp: m.properties.timestamp ?? null,
        messageId: m.properties.message_id ?? null,
        appId: m.properties.app_id ?? null,
      },
    }));
  }

  private request(options: RequestOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const transport = this.useHttps ? https : http;
      const req = transport.request(
        {
          hostname: this.host,
          port: this.port,
          path: options.path,
          method: options.method,
          headers: {
            'Authorization': this.authHeader,
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(new Error(`RabbitMQ API error (${res.statusCode}): ${body}`));
            }
          });
        }
      );

      req.on('error', (err) => { reject(new Error(`RabbitMQ connection failed: ${err.message}`)); });
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('RabbitMQ API request timeout'));
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}
