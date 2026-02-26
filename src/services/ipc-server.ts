import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ConnectionManager } from './connection-manager.js';

const SOCKET_DIR = path.join(os.homedir(), '.sql-extension');
const SOCKET_PATH = path.join(SOCKET_DIR, 'ipc.sock');

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
    // 清理旧 socket 文件
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    fs.mkdirSync(SOCKET_DIR, { recursive: true });

    this.server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
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
      this.send(socket, {
        id: req.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

      case 'connect': {
        const id = params.connectionId as string;
        await this.connectionManager.connect(id);
        return { success: true };
      }

      case 'disconnect': {
        const id = params.connectionId as string;
        await this.connectionManager.disconnect(id);
        return { success: true };
      }

      case 'query': {
        const id = params.connectionId as string;
        const sql = params.sql as string;
        const database = params.database as string | undefined;
        const driver = this.connectionManager.getDriver(id);
        if (database) {
          const { promise } = driver.executeCancellable(sql, undefined, database);
          return await promise;
        }
        return await driver.execute(sql);
      }

      default:
        throw new Error(`Unknown IPC method: ${method}`);
    }
  }

  private send(socket: net.Socket, response: IpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + '\n');
    } catch {}
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
  }
}
