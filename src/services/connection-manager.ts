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

type AnyDriver = IDatabaseDriver | MongoDriver | IRedisDriver | IKafkaDriver | IRabbitMQDriver;

const CONNECTIONS_KEY = 'sqlext.connections';

const HEARTBEAT_INTERVAL_MS = 60_000;

export function newConnectionId(config: Pick<ConnectionConfig, 'driverType' | 'host' | 'port'>): string {
  return `${config.driverType}-${config.host}-${config.port}-${Date.now()}`;
}

// 只读连接拒绝写入的原因, 可写时为 undefined. UI 的写消息, 编辑器执行与 agent 的 execute 都由它判定
export function writeBlockedReason(config: Pick<ConnectionConfig, 'name' | 'readOnly'> | undefined): string | undefined {
  return config?.readOnly ? `Connection ${config.name} is read-only` : undefined;
}

export class ConnectionManager implements vscode.Disposable {
  private readonly drivers = new Map<string, AnyDriver>();
  private readonly tunnels = new Map<string, TunnelHandle>();
  private readonly states = new Map<string, ConnectionState>();
  private readonly inflight = new Map<string, Promise<void>>();
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
    const entries = [...this.drivers.entries()];
    if (entries.length === 0) { return; }
    const results = await Promise.allSettled(
      entries.map(([, driver]) => driver.ping())
    );
    let changed = false;
    for (let i = 0; i < entries.length; i++) {
      if (results[i].status === 'rejected') {
        const [id, driver] = entries[i];
        // ping 失败也要关掉 driver, 否则它的 client 会对已关闭的 tunnel 无限重连
        void driver.disconnect().catch(() => undefined);
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

  // password / sshPassword 为 undefined 表示保留已存的值; 配置里关掉了 SSH 则删除已存的 SSH 密码
  async updateConnection(id: string, config: ConnectionConfig, password?: string, sshPassword?: string): Promise<void> {
    await this.disconnect(id);
    const connections = this.getConnections().map((c) => (c.id === id ? config : c));
    await this.globalState.update(CONNECTIONS_KEY, connections);
    if (password !== undefined) {
      await this.credentialStore.setPassword(id, password);
    }
    if (!config.ssh?.enabled) {
      await this.credentialStore.deleteSSHPassword(id);
    } else if (sshPassword !== undefined) {
      await this.credentialStore.setSSHPassword(id, sshPassword);
    }
    this._onDidChange.fire();
  }

  // 复制配置和已存凭据 (DB / SSH 密码) 到新 id, 凭据只在 extension host 内流转; 返回新 id
  async duplicateConnection(id: string): Promise<string> {
    const source = this.getConnections().find((c) => c.id === id);
    if (!source) {
      throw new Error(`Connection not found: ${id}`);
    }
    const copy: ConnectionConfig = { ...source, id: newConnectionId(source), name: `${source.name} (copy)` };
    const password = (await this.credentialStore.getPassword(id)) ?? '';
    const sshPassword = await this.credentialStore.getSSHPassword(id);
    await this.addConnection(copy, password, sshPassword);
    return copy.id;
  }

  async reorderConnection(id: string, beforeId: string | null): Promise<void> {
    const connections = this.getConnections();
    const idx = connections.findIndex((c) => c.id === id);
    if (idx === -1) { return; }

    const moved = connections[idx];
    const rest = [...connections.slice(0, idx), ...connections.slice(idx + 1)];

    if (beforeId === null) {
      rest.push(moved);
    } else {
      const targetIdx = rest.findIndex((c) => c.id === beforeId);
      if (targetIdx === -1) { return; }
      rest.splice(targetIdx, 0, moved);
    }

    await this.globalState.update(CONNECTIONS_KEY, rest);
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

  // 同一 id 并发 connect 共用一次连接过程 (UI 点击与 agent 请求可能同时到达),
  // 否则会各建一个 driver / SSH tunnel, 后到者还会在 'connecting' 时提前返回拿不到 driver.
  connect(id: string): Promise<void> {
    if (this.states.get(id) === 'connected') {
      return Promise.resolve();
    }
    let p = this.inflight.get(id);
    if (!p) {
      p = this.doConnect(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  private async doConnect(id: string): Promise<void> {
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

  // SQL (MySQL / PostgreSQL) driver; 其他类型各走自己的 getter
  getDriver(id: string): IDatabaseDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(`No active connection: ${id}`);
    }
    if (driver.driverType !== 'mysql' && driver.driverType !== 'postgresql') {
      throw new Error(`Connection ${id} is a ${driver.driverType} connection, not SQL`);
    }
    return driver as IDatabaseDriver;
  }

  getMongoDriver(id: string): MongoDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(`No active connection: ${id}`);
    }
    if (driver.driverType !== 'mongodb') {
      throw new Error(`Connection ${id} is not a MongoDB connection`);
    }
    return driver as MongoDriver;
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

  private createDriver(driverType: string): AnyDriver {
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
