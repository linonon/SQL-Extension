import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';

// 临时 HOME: 不碰真实 ~/.sql-extension 里 VS Code 窗口的 socket
vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlext-ipc-'));
});

import * as vscode from 'vscode';
import { IpcServer, SOCKET_PATH, SOCKET_DIR, confirmAgentRequest } from './ipc-server.js';

const result = {
  columns: [{ name: 'id', dataType: 'int' }],
  rows: [{ id: 1 }],
  affectedRows: 0,
  executionTime: 5,
};

function makeConnectionManager() {
  const config = {
    id: 'test-id',
    name: 'test-db',
    driverType: 'mysql',
    host: 'localhost',
    port: 3306,
    username: 'root',
    database: 'mydb',
  };
  return {
    getConnections: vi.fn().mockReturnValue([config]),
    getConnectionInfo: vi.fn().mockReturnValue([
      {
        config,
        state: 'disconnected',
      },
    ]),
    connect: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue('disconnected'),
    getDriver: vi.fn().mockReturnValue({
      execute: vi.fn(),
      executeReadOnly: vi.fn().mockResolvedValue(result),
      executeCancellable: vi.fn().mockReturnValue({ promise: Promise.resolve(result), cancel: () => {} }),
      executeBatch: vi.fn().mockReturnValue({ promise: Promise.resolve({ results: [{ ...result, sql: 'x' }] }), cancel: () => {} }),
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
    expect(resp.result[0]).not.toHaveProperty('readOnly');
  });

  it('should auto-connect and run read through the read-only path with default database', async () => {
    await new Promise(r => setTimeout(r, 100));
    const resp = await sendRequest(SOCKET_PATH, {
      id: '4',
      method: 'read',
      params: { connectionId: 'test-id', query: 'SELECT 1' },
    });
    expect(cm.connect).toHaveBeenCalledWith('test-id');
    expect(JSON.parse(resp.result.content[0].text).rows).toEqual([{ id: 1 }]);
    expect(cm.getDriver().executeReadOnly).toHaveBeenCalledWith('SELECT 1\nLIMIT 500', 'mydb');
  });

  it('should reject writes sent through read', async () => {
    await new Promise(r => setTimeout(r, 100));
    const resp = await sendRequest(SOCKET_PATH, {
      id: '6',
      method: 'read',
      params: { connectionId: 'test-id', query: 'DROP TABLE users' },
    });
    expect(resp.result.isError).toBe(true);
    expect(cm.getDriver().executeReadOnly).not.toHaveBeenCalled();
  });

  it('execute 的破坏性请求先弹 modal 点名连接 / 库 / 语句; 拒绝则不连接不执行, 放行才执行', async () => {
    await new Promise(r => setTimeout(r, 100));
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockClear().mockResolvedValue(undefined as never);
    const req = { id: '7', method: 'execute', params: { connectionId: 'test-id', query: 'DROP TABLE users' } };
    const denied = await sendRequest(SOCKET_PATH, req);
    expect(warn).toHaveBeenCalledWith('An agent wants to run a destructive request on test-db/mydb: DROP TABLE users', { modal: true }, 'Run');
    expect(JSON.parse(denied.result.content[0].text)).toEqual({ error: 'Denied by user', code: 'NOT_CONFIRMED' });
    expect(cm.connect).not.toHaveBeenCalled();
    expect(cm.getDriver().executeBatch).not.toHaveBeenCalled();

    warn.mockResolvedValue('Run' as never);
    const ran = await sendRequest(SOCKET_PATH, { ...req, id: '8' });
    expect(ran.result.isError).toBeUndefined();
    expect(cm.getDriver().executeBatch).toHaveBeenCalledWith(['DROP TABLE users'], 'mydb');
  });

  it('非破坏性 execute 不弹确认', async () => {
    await new Promise(r => setTimeout(r, 100));
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockClear();
    await sendRequest(SOCKET_PATH, { id: '9', method: 'execute', params: { connectionId: 'test-id', query: 'DELETE FROM users WHERE id = 1' } });
    expect(warn).not.toHaveBeenCalled();
    expect(cm.getDriver().executeBatch).toHaveBeenCalledTimes(1);
  });

  it('只读连接: listConnections 标出 readOnly; execute 不弹确认, 不连接, 回 READONLY_VIOLATION; read 照常', async () => {
    await new Promise(r => setTimeout(r, 100));
    const ro = { ...cm.getConnections()[0], readOnly: true };
    cm.getConnections.mockReturnValue([ro]);
    cm.getConnectionInfo.mockReturnValue([{ config: ro, state: 'disconnected' }]);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockClear();

    const list = await sendRequest(SOCKET_PATH, { id: '10', method: 'listConnections' });
    expect(list.result[0].readOnly).toBe(true);

    const exec = await sendRequest(SOCKET_PATH, { id: '11', method: 'execute', params: { connectionId: 'test-id', query: 'DROP TABLE users' } });
    expect(JSON.parse(exec.result.content[0].text)).toEqual({ error: 'Connection test-db is read-only', code: 'READONLY_VIOLATION' });
    expect(warn).not.toHaveBeenCalled();
    expect(cm.connect).not.toHaveBeenCalled();
    expect(cm.getDriver().executeBatch).not.toHaveBeenCalled();

    const read = await sendRequest(SOCKET_PATH, { id: '12', method: 'read', params: { connectionId: 'test-id', query: 'SELECT 1' } });
    expect(read.result.isError).toBeUndefined();
    expect(cm.getDriver().executeReadOnly).toHaveBeenCalled();
  });

  it('should keep socket dir private', () => {
    expect(fs.statSync(SOCKET_DIR).mode & 0o777).toBe(0o700);
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

describe('confirmAgentRequest', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('60s 无应答按拒绝处理, 长语句保留首尾', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockClear().mockReturnValue(new Promise(() => {}) as never);
    const answer = confirmAgentRequest('c/db', `UPDATE t SET doc = '${'x'.repeat(400)}' -- tail`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await answer).toBe('No answer within 60s, not executed');
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain(': UPDATE t SET doc');
    expect(msg).toContain(' ... ');
    expect(msg.endsWith("' -- tail")).toBe(true);
    expect(msg.length).toBeLessThan(400);
  });
});
