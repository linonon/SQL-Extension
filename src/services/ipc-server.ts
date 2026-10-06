import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ConnectionManager } from './connection-manager.js';
import type { MongoDriver } from '../drivers/mongo-driver.js';
import { routeByDriver, type DriverSource, type RouteMode } from './query-router.js';
import { sanitizeErrorMessage } from '../utils/sanitize-error.js';

export const SOCKET_DIR = path.join(os.homedir(), '.sql-extension');
// 每个窗口 (extension host) 一个 socket: 共用固定路径时, 后启动的窗口抢走路径,
// 任一窗口关闭 (libuv close 按名字 unlink) 又把别人的路径删掉. MCP 端按 mtime 挑最新的连.
export const SOCKET_PATH = path.join(SOCKET_DIR, `ipc-${process.pid}.sock`);

interface IpcRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface IpcResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

export class IpcServer {
  private server: net.Server | null = null;

  constructor(private readonly connectionManager: ConnectionManager) {}

  start(): void {
    // 目录收紧到 0700 (mode 对已存在目录无效, 故再 chmod); 锁不住就不开 IPC, 不拖垮扩展
    try {
      fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
      fs.chmodSync(SOCKET_DIR, 0o700);
    } catch (err) {
      process.stderr.write(`IPC disabled: cannot secure ${SOCKET_DIR}: ${(err as Error).message}\n`);
      return;
    }
    // 只清本 pid 的残留 (崩溃的同 pid 旧进程)
    try { fs.unlinkSync(SOCKET_PATH); } catch {}

    this.server = net.createServer((socket) => {
      let buffer = '';
      // StringDecoder 跨 chunk 保留半个多字节字符, 中文不会被拆成 U+FFFD
      socket.setEncoding('utf8');
      socket.on('data', (data: string) => {
        buffer += data;
        if (!data.includes('\n')) { return; }
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) { continue; }
          void this.handleMessage(line, socket);
        }
      });
      socket.on('error', () => {});
    });

    this.server.listen(SOCKET_PATH, () => {
      // 仅 owner 可读写
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    });

    this.server.on('error', (err) => {
      process.stderr.write(`IPC server error: ${err.message}\n`);
    });
  }

  private async handleMessage(raw: string, socket: net.Socket): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      this.send(socket, { id: req.id, result });
    } catch (err) {
      this.send(socket, { id: req.id, error: sanitizeErrorMessage(err) });
    }
  }

  // 未连接则按需连接: 连接状态按窗口保存, agent 不感知也不管理连接
  private async ensureConnected(id: string): Promise<void> {
    if (this.connectionManager.getState(id) === 'connected') { return; }
    await this.connectionManager.connect(id);
  }

  private findConfig(id: string) {
    const config = this.connectionManager.getConnections().find(c => c.id === id);
    if (!config) { throw new Error(`Connection not found: ${id}`); }
    return config;
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'listConnections':
        return this.connectionManager.getConnectionInfo().map(info => ({
          id: info.config.id,
          name: info.config.name,
          driverType: info.config.driverType,
          host: info.config.host,
          port: info.config.port,
          database: info.config.database,
          state: info.state,
        }));

      case 'read':
      case 'execute': {
        const id = params.connectionId as string;
        const config = this.findConfig(id);
        await this.ensureConnected(id);
        const cm = this.connectionManager;
        const drivers: DriverSource = {
          getDriver: (i) => cm.getDriver(i),
          getRedisDriver: (i) => cm.getRedisDriver(i),
          getMongoDriver: (i) => cm.getDriver(i) as unknown as MongoDriver,
          getKafkaDriver: (i) => cm.getKafkaDriver(i),
          getRabbitMQDriver: (i) => cm.getRabbitMQDriver(i),
        };
        const database = (params.database as string | undefined) || config.database || undefined;
        return routeByDriver(method as RouteMode, config.driverType, id, params.query as string, database, drivers);
      }

      case 'listDatabases': {
        const id = params.connectionId as string;
        const config = this.findConfig(id);
        if (config.driverType === 'redis') {
          return Array.from({ length: 16 }, (_, i) => ({ name: String(i) }));
        }
        if (config.driverType === 'kafka' || config.driverType === 'rabbitmq') {
          return { error: 'N/A for this database type' };
        }
        await this.ensureConnected(id);
        const driver = this.connectionManager.getDriver(id);
        return await driver.listDatabases();
      }

      case 'listTables': {
        const id = params.connectionId as string;
        const database = params.database as string;
        const config = this.findConfig(id);
        await this.ensureConnected(id);
        if (config.driverType === 'kafka') {
          return await this.connectionManager.getKafkaDriver(id).listTopics();
        }
        if (config.driverType === 'rabbitmq') {
          return await this.connectionManager.getRabbitMQDriver(id).listQueues();
        }
        if (config.driverType === 'redis') {
          return { error: 'N/A for Redis' };
        }
        const driver = this.connectionManager.getDriver(id);
        return await driver.listTables(database);
      }

      case 'listColumns': {
        const id = params.connectionId as string;
        const database = params.database as string;
        const table = params.table as string;
        this.findConfig(id);
        await this.ensureConnected(id);
        const driver = this.connectionManager.getDriver(id);
        return await driver.listColumns(database, table);
      }

      case 'getTableDDL': {
        const id = params.connectionId as string;
        const database = params.database as string;
        const table = params.table as string;
        this.findConfig(id);
        await this.ensureConnected(id);
        const driver = this.connectionManager.getDriver(id);
        return await driver.getTableDDL(database, table);
      }

      default:
        throw new Error(`Unknown IPC method: ${method}`);
    }
  }

  private send(socket: net.Socket, response: IpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      // 序列化失败 (结果过大) 也要回同 id 的错误, 否则 read/execute 无超时会永远挂住
      try {
        socket.write(JSON.stringify({ id: response.id, error: `Result too large to return: ${(err as Error).message}` }) + '\n');
      } catch {}
    }
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
    try { fs.unlinkSync(SOCKET_PATH); } catch {}  // 路径带本 pid, 只会删自己的
  }
}
