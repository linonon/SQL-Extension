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
import { createTunnel, KNOWN_HOSTS_PATH, type TunnelHandle } from './ssh-tunnel.js';
import { sanitizeErrorMessage } from '../utils/sanitize-error.js';

type AnyDriver = IDatabaseDriver | MongoDriver | IRedisDriver | IKafkaDriver | IRabbitMQDriver;

const CONNECTIONS_KEY = 'sqlext.connections';

const HEARTBEAT_INTERVAL_MS = 60_000;
// 半开连接上 ping 可能永不返回, 超时按失败处理
const PING_TIMEOUT_MS = 10_000;

export function newConnectionId(config: Pick<ConnectionConfig, 'driverType' | 'host' | 'port'>): string {
  return `${config.driverType}-${config.host}-${config.port}-${Date.now()}`;
}

// 只读连接拒绝写入的原因, 可写时为 undefined. UI 的写消息, 编辑器执行与 agent 的 execute 都由它判定
export function writeBlockedReason(config: Pick<ConnectionConfig, 'name' | 'readOnly'> | undefined): string | undefined {
  return config?.readOnly ? `Connection ${config.name} is read-only` : undefined;
}

// 一次打开的连接: driver 与它的 SSH tunnel 同生共死
export interface DriverHandle {
  readonly driver: AnyDriver;
  // 先关 driver 再关 tunnel; 关闭时的错误忽略 (被拆的连接多半已经断了)
  close(): Promise<void>;
}

function createDriver(driverType: string): AnyDriver {
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

// 首次连某个 SSH host 时让用户核对 key 指纹
async function confirmHostKey(hostPort: string, fingerprint: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `Trust this host key? First connection to SSH server ${hostPort}.`,
    {
      modal: true,
      detail: `Fingerprint: ${fingerprint}\n\nThe key is saved to ${KNOWN_HOSTS_PATH}; later connections are refused if it changes.`,
    },
    'Trust'
  );
  return answer === 'Trust';
}

// 连接的唯一入口 (ConnectionManager 与表单的 Test Connection 共用): 配了 SSH 先建 tunnel, driver 改连 127.0.0.1:<本地端口>;
// 任一步失败都关掉已打开的部分, 错误点名失败的那一跳. onTunnelClose: tunnel 交付后 SSH 连接断开时调用
export async function openDriver(
  config: ConnectionConfig,
  password: string,
  sshPassword: string,
  onTunnelClose?: () => void
): Promise<DriverHandle> {
  const driver = createDriver(config.driverType);
  const ssh = config.ssh?.enabled ? config.ssh : undefined;
  let tunnel: TunnelHandle | undefined;
  if (ssh) {
    try {
      tunnel = await createTunnel(ssh, sshPassword, config.host, config.port, { confirmHostKey, onClose: onTunnelClose });
    } catch (err) {
      throw new Error(`SSH tunnel ${ssh.username}@${ssh.host}:${ssh.port} failed: ${sanitizeErrorMessage(err)}`);
    }
  }
  try {
    await driver.connect({ ...config, host: tunnel ? '127.0.0.1' : config.host, port: tunnel?.localPort ?? config.port, password });
  } catch (err) {
    try { await driver.disconnect(); } catch { /* 连接失败时已打开的部分尽量关掉 */ }
    tunnel?.close();
    throw new Error(`${config.driverType} ${config.host}:${config.port}${ssh ? ' (via SSH)' : ''} failed: ${sanitizeErrorMessage(err)}`);
  }
  return {
    driver,
    async close() {
      try { await driver.disconnect(); } catch { /* 被拆的连接多半已断, 关闭出错不影响拆除 */ }
      tunnel?.close();
    },
  };
}

function pingWithTimeout(driver: { ping(): Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ping timed out after ${PING_TIMEOUT_MS / 1000}s`)), PING_TIMEOUT_MS);
  });
  return Promise.race([driver.ping(), timeout]).finally(() => clearTimeout(timer));
}

export class ConnectionManager implements vscode.Disposable {
  // 只放连接成功的 handle; 进行中的尝试持有自己的 handle, 被作废时自己关掉
  private readonly handles = new Map<string, DriverHandle>();
  private readonly states = new Map<string, ConnectionState>();
  // 进行中的连接尝试; teardown 删掉它即作废这次尝试, 之后的 connect 另起一次
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

  // ping 失败或超时即拆掉 (driver 的 client 不能对已断的 tunnel 无限重连); ping 期间可能已重连, 只拆被 ping 的那个 handle.
  // 上一轮还没结束时跳过, 不叠加
  private checking = false;
  private async checkConnections(): Promise<void> {
    if (this.checking) { return; }
    this.checking = true;
    try {
      const entries = [...this.handles.entries()];
      const results = await Promise.allSettled(entries.map(([, handle]) => pingWithTimeout(handle.driver)));
      await Promise.all(entries.map(([id, handle], i) =>
        results[i].status === 'rejected' ? this.teardown(id, handle) : undefined
      ));
    } finally {
      this.checking = false;
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
  // 被 teardown 作废的尝试不共用: 取消后马上再连会另起一次
  connect(id: string): Promise<void> {
    if (this.states.get(id) === 'connected') {
      return Promise.resolve();
    }
    const running = this.inflight.get(id);
    if (running) {
      return running;
    }
    const attempt: Promise<void> = this.doConnect(id, () => this.inflight.get(id) === attempt)
      .finally(() => { if (this.inflight.get(id) === attempt) { this.inflight.delete(id); } });
    this.inflight.set(id, attempt);
    return attempt;
  }

  // isCurrent() 为 false 表示这次尝试已被 teardown 作废 (取消 / 断开 / 删除): 不改状态, 已打开的连接自己关掉
  private async doConnect(id: string, isCurrent: () => boolean): Promise<void> {
    const config = this.getConnections().find((c) => c.id === id);
    if (!config) {
      throw new Error(`Connection not found: ${id}`);
    }

    const password = await this.credentialStore.getPassword(id);
    if (password === undefined) {
      throw new Error('Password not found for connection');
    }
    const sshPassword = config.ssh?.enabled ? ((await this.credentialStore.getSSHPassword(id)) ?? '') : '';
    if (!isCurrent()) { return; }

    this.states.set(id, 'connecting');
    this._onDidChange.fire();

    let handle: DriverHandle | undefined;
    try {
      // SSH 连接断开时立即拆掉, 界面马上显示 disconnected, 不等心跳
      handle = await openDriver(config, password, sshPassword, () => { if (handle) { void this.teardown(id, handle); } });
    } catch (err) {
      if (isCurrent()) {
        this.states.set(id, 'disconnected');
        this._onDidChange.fire();
      }
      throw err;
    }
    if (!isCurrent()) {
      await handle.close();
      return;
    }
    this.handles.set(id, handle);
    this.states.set(id, 'connected');
    this._onDidChange.fire();
  }

  // 拆掉 id 的连接: 作废进行中的尝试, 状态置 disconnected, 再关 driver 与 tunnel.
  // 先改状态后关闭: 关闭期间到来的 connect 直接另起新连接, 不会被旧状态短路.
  // 给了 expected 时只拆仍是它的那个连接 (心跳 / tunnel 断开回调不能拆掉其间重连上的新连接)
  private async teardown(id: string, expected?: DriverHandle): Promise<void> {
    const handle = this.handles.get(id);
    if (expected && handle !== expected) { return; }
    this.inflight.delete(id);
    this.handles.delete(id);
    this.states.set(id, 'disconnected');
    this._onDidChange.fire();
    await handle?.close();
  }

  disconnect(id: string): Promise<void> {
    return this.teardown(id);
  }

  private activeDriver(id: string): AnyDriver {
    const driver = this.handles.get(id)?.driver;
    if (!driver) {
      throw new Error(`No active connection: ${id}`);
    }
    return driver;
  }

  // SQL (MySQL / PostgreSQL) driver; 其他类型各走自己的 getter
  getDriver(id: string): IDatabaseDriver {
    const driver = this.activeDriver(id);
    if (driver.driverType !== 'mysql' && driver.driverType !== 'postgresql') {
      throw new Error(`Connection ${id} is a ${driver.driverType} connection, not SQL`);
    }
    return driver as IDatabaseDriver;
  }

  getMongoDriver(id: string): MongoDriver {
    const driver = this.activeDriver(id);
    if (driver.driverType !== 'mongodb') {
      throw new Error(`Connection ${id} is not a MongoDB connection`);
    }
    return driver as MongoDriver;
  }

  getRedisDriver(id: string): IRedisDriver {
    const driver = this.activeDriver(id);
    if (driver.driverType !== 'redis') {
      throw new Error(`Connection ${id} is not a Redis connection`);
    }
    return driver as IRedisDriver;
  }

  getKafkaDriver(id: string): IKafkaDriver {
    const driver = this.activeDriver(id);
    if (driver.driverType !== 'kafka') {
      throw new Error(`Connection ${id} is not a Kafka connection`);
    }
    return driver as IKafkaDriver;
  }

  getRabbitMQDriver(id: string): IRabbitMQDriver {
    const driver = this.activeDriver(id);
    if (driver.driverType !== 'rabbitmq') {
      throw new Error(`Connection ${id} is not a RabbitMQ connection`);
    }
    return driver as IRabbitMQDriver;
  }

  getState(id: string): ConnectionState {
    return this.states.get(id) ?? 'disconnected';
  }

  // 等所有连接关完: deactivate 返回它, VS Code 退出前等 driver 与 tunnel 关掉
  async dispose(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const ids = new Set([...this.handles.keys(), ...this.inflight.keys()]);
    await Promise.all([...ids].map((id) => this.teardown(id)));
    this._onDidChange.dispose();
  }
}
