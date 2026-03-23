import { MySQLDriver } from '../drivers/mysql-driver.js';
import { PgDriver } from '../drivers/pg-driver.js';
import { RedisDriver } from '../drivers/redis-driver.js';
import { MongoDriver } from '../drivers/mongo-driver.js';
import { KafkaDriver } from '../drivers/kafka-driver.js';
import { RabbitMQDriver } from '../drivers/rabbitmq-driver.js';
import { createTunnel, type TunnelHandle } from '../services/ssh-tunnel.js';
import type { ConnectionConfig, DriverType, SSHTunnelConfig } from '../types/connection.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { IRedisDriver } from '../types/redis-driver.js';
import type { IKafkaDriver } from '../types/kafka-driver.js';
import type { IRabbitMQDriver } from '../types/rabbitmq-driver.js';

const MAX_CONNECTIONS = 10;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // 60 秒

type AnyDriver = IDatabaseDriver | IRedisDriver | IKafkaDriver | IRabbitMQDriver;

export interface PoolEntry {
  readonly id: string;
  readonly driverType: DriverType;
  readonly database: string;
  readonly driver: AnyDriver;
  readonly tunnel: TunnelHandle | null;
  lastActivity: number;
}

export interface ConnectParams {
  readonly driverType: DriverType;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly database?: string;
  readonly authSource?: string;
  readonly ssh?: SSHTunnelConfig & { readonly password?: string };
}

export class ConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private counter = 0;

  constructor() {
    this.idleTimer = setInterval(() => this.evictIdle(), IDLE_CHECK_INTERVAL_MS);
  }

  get size(): number {
    return this.entries.size;
  }

  async connect(params: ConnectParams): Promise<string> {
    if (this.entries.size >= MAX_CONNECTIONS) {
      throw new Error(`Max connections (${MAX_CONNECTIONS}) reached. Disconnect unused connections first.`);
    }

    const id = `conn_${++this.counter}_${Date.now()}`;
    let connectHost = params.host;
    let connectPort = params.port;
    let tunnel: TunnelHandle | null = null;

    // SSH tunnel
    if (params.ssh?.enabled) {
      tunnel = await createTunnel(
        params.ssh,
        params.ssh.password ?? '',
        params.host,
        params.port
      );
      connectHost = '127.0.0.1';
      connectPort = tunnel.localPort;
    }

    const driver = createDriver(params.driverType);
    const config: ConnectionConfig & { readonly password: string } = {
      id,
      name: id,
      driverType: params.driverType,
      host: connectHost,
      port: connectPort,
      username: params.username ?? '',
      database: params.database ?? '',
      authSource: params.authSource,
      password: params.password ?? '',
    };

    try {
      await driver.connect(config);
    } catch (err) {
      tunnel?.close();
      throw err;
    }

    this.entries.set(id, {
      id,
      driverType: params.driverType,
      database: params.database ?? '',
      driver,
      tunnel,
      lastActivity: Date.now(),
    });

    return id;
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Connection not found: ${id}`);
    }
    try {
      await entry.driver.disconnect();
    } finally {
      entry.tunnel?.close();
      this.entries.delete(id);
    }
  }

  getEntry(id: string): PoolEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Connection not found: ${id}`);
    }
    entry.lastActivity = Date.now();
    return entry;
  }

  getDriver(id: string): IDatabaseDriver {
    const entry = this.getEntry(id);
    if (entry.driverType === 'redis' || entry.driverType === 'kafka' || entry.driverType === 'rabbitmq') {
      throw new Error(`Connection ${id} is ${entry.driverType}, not a SQL database`);
    }
    return entry.driver as IDatabaseDriver;
  }

  getMongoDriver(id: string): MongoDriver {
    const entry = this.getEntry(id);
    if (entry.driverType !== 'mongodb') {
      throw new Error(`Connection ${id} is not MongoDB`);
    }
    return entry.driver as MongoDriver;
  }

  getRedisDriver(id: string): IRedisDriver {
    const entry = this.getEntry(id);
    if (entry.driverType !== 'redis') {
      throw new Error(`Connection ${id} is not Redis`);
    }
    return entry.driver as IRedisDriver;
  }

  getKafkaDriver(id: string): IKafkaDriver {
    const entry = this.getEntry(id);
    if (entry.driverType !== 'kafka') {
      throw new Error(`Connection ${id} is not Kafka`);
    }
    return entry.driver as IKafkaDriver;
  }

  getRabbitMQDriver(id: string): IRabbitMQDriver {
    const entry = this.getEntry(id);
    if (entry.driverType !== 'rabbitmq') {
      throw new Error(`Connection ${id} is not RabbitMQ`);
    }
    return entry.driver as IRabbitMQDriver;
  }

  listConnections(): ReadonlyArray<{ id: string; driverType: DriverType; database: string }> {
    return [...this.entries.values()].map(e => ({
      id: e.id,
      driverType: e.driverType,
      database: e.database,
    }));
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastActivity > IDLE_TIMEOUT_MS) {
        entry.driver.disconnect().catch(() => {});
        entry.tunnel?.close();
        this.entries.delete(id);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.allSettled(ids.map(id => this.disconnect(id)));
  }

  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const entry of this.entries.values()) {
      entry.driver.disconnect().catch(() => {});
      entry.tunnel?.close();
    }
    this.entries.clear();
  }
}

function createDriver(driverType: DriverType): AnyDriver {
  switch (driverType) {
    case 'mysql':
      return new MySQLDriver();
    case 'postgresql':
      return new PgDriver();
    case 'redis':
      return new RedisDriver();
    case 'mongodb':
      return new MongoDriver();
    case 'kafka':
      return new KafkaDriver();
    case 'rabbitmq':
      return new RabbitMQDriver();
    default:
      throw new Error(`Unsupported driver type: ${driverType}`);
  }
}
