import { describe, it, expect, vi, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const HOME = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlext-ipcc-'));
  process.env.HOME = home;
  return home;
});

import { IpcClient } from './ipc-client.js';
import { PROTOCOL_MISMATCH_ERROR, PROTOCOL_VERSION } from './ipc-protocol.js';

const DIR = path.join(HOME, '.sql-extension');
const sock = (pid: string) => path.join(DIR, `ipc-${pid}.sock`);

// 模拟一个窗口: 对任何请求回 { result: pid }; protocolVersion 缺省为当前版本, null 表示不带 (升级前的旧窗口)
function fakeWindow(pid: string, protocolVersion: number | null = PROTOCOL_VERSION): Promise<net.Server> {
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      for (const line of d.split('\n').filter(Boolean)) {
        const version = protocolVersion === null ? {} : { protocolVersion };
        s.write(JSON.stringify({ id: JSON.parse(line).id, result: pid, ...version }) + '\n');
      }
    });
  });
  return new Promise(r => server.listen(sock(pid), () => r(server)));
}

// 崩溃窗口的残留: 子进程 listen 后被 SIGKILL, 文件留下但无人监听
async function staleSocket(pid: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock(pid))})`]);
  while (!fs.existsSync(sock(pid))) { await new Promise(r => setTimeout(r, 10)); }
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
}

function touch(p: string, offsetMs: number): void {
  const t = new Date(Date.now() + offsetMs);
  fs.utimesSync(p, t, t);
}

describe('IpcClient window discovery', () => {
  const servers: net.Server[] = [];
  afterEach(() => { servers.splice(0).forEach(s => s.close()); });

  it('connects to the newest live window, skipping and removing stale sockets', async () => {
    fs.mkdirSync(DIR, { recursive: true });
    servers.push(await fakeWindow('111'), await fakeWindow('222'));
    await staleSocket('333');
    touch(sock('222'), 1_000);
    touch(sock('111'), 5_000);
    touch(sock('333'), 10_000);

    const client = new IpcClient();
    expect(await client.request('listConnections')).toBe('111');
    expect(fs.existsSync(sock('333'))).toBe(false);
    client.disconnect();
  });

  it('serves concurrent first requests over a single connection', async () => {
    fs.mkdirSync(DIR, { recursive: true });
    let accepted = 0;
    const server = await fakeWindow('444');
    server.on('connection', () => { accepted++; });
    servers.push(server);
    touch(sock('444'), 60_000);

    const client = new IpcClient();
    const results = await Promise.all([1, 2, 3].map(() => client.request('listConnections')));
    expect(results).toEqual(['444', '444', '444']);
    expect(accepted).toBe(1);
    client.disconnect();
  });

  it('窗口回包的协议版本不符 (升级后没重载的旧窗口) 时报错, 不当作结果', async () => {
    fs.mkdirSync(DIR, { recursive: true });
    servers.push(await fakeWindow('555', null));
    touch(sock('555'), 120_000);

    const client = new IpcClient();
    await expect(client.request('listConnections')).rejects.toThrow(PROTOCOL_MISMATCH_ERROR);
    client.disconnect();
  });
});
