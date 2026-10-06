import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SOCKET_DIR = path.join(os.homedir(), '.sql-extension');
const SOCKET_RE = /^ipc-\d+\.sock$/;
// read/execute 不设超时: 语句在 VS Code 里照常跑完并提交, 客户端先报失败会诱发 agent 重试写两遍.
// 窗口死掉时 socket close 会 reject 全部 pending.
const REQUEST_TIMEOUT_MS = 30_000;
const UNTIMED_METHODS = new Set(['read', 'execute']);

interface IpcResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

// SQLEXT_IPC_SOCK 指定窗口 (Copilot 由所在窗口注入); 否则按 mtime 降序, 最近启动的窗口优先
function socketCandidates(): string[] {
  const pinned = process.env.SQLEXT_IPC_SOCK;
  if (pinned) { return [pinned]; }
  let names: string[];
  try {
    names = fs.readdirSync(SOCKET_DIR).filter(n => SOCKET_RE.test(n));
  } catch {
    return [];
  }
  const withTime = names.flatMap((n) => {
    const p = path.join(SOCKET_DIR, n);
    try { return [{ p, t: fs.statSync(p).mtimeMs }]; } catch { return []; }
  });
  return withTime.sort((a, b) => b.t - a.t).map(x => x.p);
}

function isPidAlive(socketPath: string): boolean {
  const pid = Number(/ipc-(\d+)\.sock$/.exec(socketPath)?.[1]);
  if (!pid) { return true; }  // 非 ipc-<pid> 命名 (SQLEXT_IPC_SOCK 指定的), 不动
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function dial(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private buffer = '';
  private counter = 0;
  private readonly pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();

  async connect(): Promise<void> {
    for (const p of socketCandidates()) {
      try {
        this.socket = await dial(p);
        this.setupHandlers(this.socket);
        return;
      } catch (err) {
        // ECONNREFUSED 也可能是 accept 队列满 (宿主卡住), 只有属主 pid 已不存在才算残留并清掉
        if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' && !isPidAlive(p)) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
    }
    throw new Error('no live VS Code window');
  }

  private setupHandlers(socket: net.Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      this.buffer += data;
      if (!data.includes('\n')) { return; }
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) { continue; }
        try {
          const resp: IpcResponse = JSON.parse(line);
          const p = this.pending.get(resp.id);
          if (p) {
            this.pending.delete(resp.id);
            if (resp.error) {
              p.reject(new Error(resp.error));
            } else {
              p.resolve(resp.result);
            }
          }
        } catch {}
      }
    });
    socket.on('close', () => {
      for (const [, p] of this.pending) {
        p.reject(new Error('IPC connection closed (VS Code window closed or reloaded); the statement may or may not have completed'));
      }
      this.pending.clear();
      this.buffer = '';
      if (this.socket === socket) { this.socket = null; }
    });
    socket.on('error', () => {
      socket.destroy();
    });
  }

  // 并发请求共用同一次连接尝试, 避免各开一条 socket 共用 buffer
  private async ensureConnected(): Promise<void> {
    if (this.connected) { return; }
    this.connecting ??= this.connect().catch(() => {}).finally(() => { this.connecting = null; });
    await this.connecting;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    // 懒连接: 每次请求前尝试重连
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket) {
      throw new Error('VS Code is not reachable: open VS Code with Database Explorer activated (reload windows after upgrading).');
    }
    const id = `req_${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = UNTIMED_METHODS.has(method)
        ? undefined
        : setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`IPC request timeout: ${method}`));
        }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
