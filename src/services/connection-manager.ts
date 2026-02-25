import * as vscode from 'vscode';
import type { ConnectionConfig, ConnectionInfo, ConnectionState } from '../types/connection.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { IRedisDriver } from '../types/redis-driver.js';
import type { IKafkaDriver } from '../types/kafka-driver.js';
import type { IRabbitMQDriver } from '../types/rabbitmq-driver.js';
import { MySQLDriver } from '../drivers/mysql-driver.js';
import { PgDriver } from '../drivers/pg-driver.js';
import { RedisDriver } from '../drivers/redis-driver.js';
import { MongoDriver } from '../drivers/mongo-driver.js';
import { KafkaDriver } from '../drivers/kafka-driver.js';
import { RabbitMQDriver } from '../drivers/rabbitmq-driver.js';
import { CredentialStore } from './credential-store.js';
import { createTunnel, type TunnelHandle } from './ssh-tunnel.js';

const CONNECTIONS_KEY = 'sqlext.connections';

const HEARTBEAT_INTERVAL_MS = 60_000;

export class ConnectionManager implements vscode.Disposable {
  private readonly drivers = new Map<string, IDatabaseDriver | IRedisDriver | IKafkaDriver | IRabbitMQDriver>();
  private readonly tunnels = new Map<string, TunnelHandle>();
  private readonly states = new Map<string, ConnectionState>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly credentialStore: CredentialStore
  ) {
    this.heartbeatTimer = setInterval(() => { void this.checkConnections(); }, HEARTBEAT_INTERVAL_MS);
  }

  private async checkConnections(): Promise<void> {
    let changed = false;
    for (const [id, driver] of this.drivers.entries()) {
      try {
        await driver.ping();
      } catch {
        // ping 失败说明连接已断开, 清理状态
        this.drivers.delete(id);
        this.closeTunnel(id);
        this.states.set(id, 'disconnected');
        changed = true;
      }
    }
    if (changed) {
      this._onDidChange.fire();
    }
  }

  getConnections(): ConnectionConfig[] {
    return this.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  getConnectionInfo(): ConnectionInfo[] {
    return this.getConnections().map((config) => ({
      config,
      state: this.states.get(config.id) ?? 'disconnected',
    }));
  }

  async addConnection(config: ConnectionConfig, password: string, sshPassword?: string): Promise<void> {
    const connections = [...this.getConnections(), config];
    await this.globalState.update(CONNECTIONS_KEY, connections);
    await this.credentialStore.setPassword(config.id, password);
    if (sshPassword !== undefined) {
      await this.credentialStore.setSSHPassword(config.id, sshPassword);
    }
    this._onDidChange.fire();
  }

  async updateConnection(id: string, config: ConnectionConfig, password: string, sshPassword?: string): Promise<void> {
    await this.disconnect(id);
    const connections = this.getConnections().map((c) => (c.id === id ? config : c));
    await this.globalState.update(CONNECTIONS_KEY, connections);
    await this.credentialStore.setPassword(id, password);
    if (sshPassword !== undefined) {
      await this.credentialStore.setSSHPassword(id, sshPassword);
    }
    this._onDidChange.fire();
  }

  async removeConnection(id: string): Promise<void> {
    await this.disconnect(id);
    const connections = this.getConnections().filter((c) => c.id !== id);
    await this.globalState.update(CONNECTIONS_KEY, connections);
    await this.credentialStore.deletePassword(id);
    await this.credentialStore.deleteSSHPassword(id);
    this._onDidChange.fire();
  }

  async connect(id: string): Promise<void> {
    const currentState = this.states.get(id);
    if (currentState === 'connecting' || currentState === 'connected') {
      return;
    }
    const config = this.getConnections().find((c) => c.id === id);
    if (!config) {
      throw new Error(`Connection not found: ${id}`);
    }

    const password = await this.credentialStore.getPassword(id);
    if (password === undefined) {
      throw new Error('Password not found for connection');
    }

    this.states.set(id, 'connecting');
    this._onDidChange.fire();

    try {
      let connectHost = config.host;
      let connectPort = config.port;

      // SSH tunnel
      if (config.ssh?.enabled) {
        const sshPassword = (await this.credentialStore.getSSHPassword(id)) ?? '';
        const tunnel = await createTunnel(config.ssh, sshPassword, config.host, config.port);
        this.tunnels.set(id, tunnel);
        connectHost = '127.0.0.1';
        connectPort = tunnel.localPort;
      }

      const driver = this.createDriver(config.driverType);
      await driver.connect({ ...config, host: connectHost, port: connectPort, password });

      // 竞态保护: connecting 期间可能被 disconnect() 取消
      if (this.states.get(id) !== 'connecting') {
        await driver.disconnect();
        return;
      }

      this.drivers.set(id, driver);
      this.states.set(id, 'connected');
    } catch (err) {
      this.closeTunnel(id);
      if (this.states.get(id) === 'connecting') {
        this.states.set(id, 'disconnected');
      }
      throw err;
    } finally {
      this._onDidChange.fire();
    }
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.drivers.get(id);
    if (driver) {
      await driver.disconnect();
      this.drivers.delete(id);
    }
    this.closeTunnel(id);
    this.states.set(id, 'disconnected');
    this._onDidChange.fire();
  }

  getDriver(id: string): IDatabaseDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(`No active connection: ${id}`);
    }
    if (driver.driverType === 'redis') {
      throw new Error(`Connection ${id} is a Redis connection, use getRedisDriver() instead`);
    }
    if (driver.driverType === 'kafka') {
      throw new Error(`Connection ${id} is a Kafka connection, use getKafkaDriver() instead`);
    }
    if (driver.driverType === 'rabbitmq') {
      throw new Error(`Connection ${id} is a RabbitMQ connection, use getRabbitMQDriver() instead`);
    }
    return driver as IDatabaseDriver;
  }

  isRedisConnection(id: string): boolean {
    const config = this.getConnections().find((c) => c.id === id);
    return config?.driverType === 'redis';
  }

  getRedisDriver(id: string): IRedisDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(`No active connection: ${id}`);
    }
    if (driver.driverType !== 'redis') {
      throw new Error(`Connection ${id} is not a Redis connection`);
    }
    return driver as IRedisDriver;
  }

  isKafkaConnection(id: string): boolean {
    const config = this.getConnections().find((c) => c.id === id);
    return config?.driverType === 'kafka';
  }

  getKafkaDriver(id: string): IKafkaDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(`No active connection: ${id}`);
    }
    if (driver.driverType !== 'kafka') {
      throw new Error(`Connection ${id} is not a Kafka connection`);
    }
    return driver as IKafkaDriver;
  }

  isRabbitMQConnection(id: string): boolean {
    const config = this.getConnections().find((c) => c.id === id);
    return config?.driverType === 'rabbitmq';
  }

  getRabbitMQDriver(id: string): IRabbitMQDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(`No active connection: ${id}`);
    }
    if (driver.driverType !== 'rabbitmq') {
      throw new Error(`Connection ${id} is not a RabbitMQ connection`);
    }
    return driver as IRabbitMQDriver;
  }

  getState(id: string): ConnectionState {
    return this.states.get(id) ?? 'disconnected';
  }

  private closeTunnel(id: string): void {
    const tunnel = this.tunnels.get(id);
    if (tunnel) {
      tunnel.close();
      this.tunnels.delete(id);
    }
  }

  private createDriver(driverType: string): IDatabaseDriver | IRedisDriver | IKafkaDriver | IRabbitMQDriver {
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

  dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [id, driver] of this.drivers.entries()) {
      try {
        driver.disconnect();
      } catch {
        // 静默处理关闭时的错误
      }
      this.drivers.delete(id);
      this.states.delete(id);
      this.closeTunnel(id);
    }
    for (const tunnel of this.tunnels.values()) {
      tunnel.close();
    }
    this.tunnels.clear();
    this._onDidChange.dispose();
  }
}
