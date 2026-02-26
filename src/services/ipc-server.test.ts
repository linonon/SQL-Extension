import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IpcServer } from './ipc-server.js';

const SOCKET_PATH = path.join(os.homedir(), '.sql-extension', 'ipc.sock');

function makeConnectionManager() {
  return {
    getConnectionInfo: vi.fn().mockReturnValue([
      {
        config: {
          id: 'test-id',
          name: 'test-db',
          driverType: 'mysql',
          host: 'localhost',
          port: 3306,
          username: 'root',
          database: 'mydb',
        },
        state: 'disconnected',
      },
    ]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getDriver: vi.fn().mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        columns: [{ name: 'id', dataType: 'int' }],
        rows: [{ id: 1 }],
        affectedRows: 0,
        executionTime: 5,
      }),
      executeCancellable: vi.fn(),
    }),
  } as any;
}

function sendRequest(socketPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = '';
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n');
    });
    client.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) { continue; }
        try {
          const resp = JSON.parse(line);
          client.destroy();
          resolve(resp);
          return;
        } catch {}
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
  });
}

describe('IpcServer', () => {
  let server: IpcServer;
  let cm: ReturnType<typeof makeConnectionManager>;

  beforeEach(() => {
    cm = makeConnectionManager();
    server = new IpcServer(cm);
    server.start();
  });

  afterEach(() => {
    server.dispose();
  });

  it('should create socket file', async () => {
    // 等 server listen 完成
    await new Promise(r => setTimeout(r, 100));
    expect(fs.existsSync(SOCKET_PATH)).toBe(true);
  });

  it('should handle listConnections', async () => {
    await new Promise(r => setTimeout(r, 100));
    const resp = await sendRequest(SOCKET_PATH, { id: '1', method: 'listConnections' });
    expect(resp.id).toBe('1');
    expect(resp.result).toHaveLength(1);
    expect(resp.result[0].name).toBe('test-db');
    expect(resp.result[0].driverType).toBe('mysql');
    expect(resp.result[0]).not.toHaveProperty('password');
  });

  it('should handle connect', async () => {
    await new Promise(r => setTimeout(r, 100));
    const resp = await sendRequest(SOCKET_PATH, {
      id: '2',
      method: 'connect',
      params: { connectionId: 'test-id' },
    });
    expect(resp.id).toBe('2');
    expect(resp.result.success).toBe(true);
    expect(cm.connect).toHaveBeenCalledWith('test-id');
  });

  it('should handle disconnect', async () => {
    await new Promise(r => setTimeout(r, 100));
    const resp = await sendRequest(SOCKET_PATH, {
      id: '3',
      method: 'disconnect',
      params: { connectionId: 'test-id' },
    });
    expect(resp.result.success).toBe(true);
    expect(cm.disconnect).toHaveBeenCalledWith('test-id');
  });

  it('should handle query', async () => {
    await new Promise(r => setTimeout(r, 100));
    const resp = await sendRequest(SOCKET_PATH, {
      id: '4',
      method: 'query',
      params: { connectionId: 'test-id', sql: 'SELECT 1' },
    });
    expect(resp.result.rows).toEqual([{ id: 1 }]);
  });

  it('should return error for unknown method', async () => {
    await new Promise(r => setTimeout(r, 100));
    const resp = await sendRequest(SOCKET_PATH, { id: '5', method: 'unknown' });
    expect(resp.error).toContain('Unknown IPC method');
  });

  it('should clean up socket on dispose', () => {
    server.dispose();
    // socket 文件应被删除
    expect(fs.existsSync(SOCKET_PATH)).toBe(false);
  });
});
