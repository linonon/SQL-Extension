import * as net from 'net';
import * as path from 'path';
import * as os from 'os';

const SOCKET_PATH = path.join(os.homedir(), '.sql-extension', 'ipc.sock');
const REQUEST_TIMEOUT_MS = 30_000;

interface IpcResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private counter = 0;
  private readonly pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH);
      const onError = (err: Error) => {
        socket.removeListener('error', onError);
        reject(err);
      };
      socket.on('error', onError);
      socket.on('connect', () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        this.setupHandlers();
        resolve();
      });
    });
  }

  private setupHandlers(): void {
    if (!this.socket) { return; }
    this.socket.on('data', (data) => {
      this.buffer += data.toString();
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
    this.socket.on('close', () => {
      for (const [, p] of this.pending) {
        p.reject(new Error('IPC connection closed'));
      }
      this.pending.clear();
      this.socket = null;
    });
    this.socket.on('error', () => {
      this.socket?.destroy();
      this.socket = null;
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket) {
      throw new Error('VS Code extension is not running. Open VS Code with SQL Extension activated, or use full connection parameters (host, port, etc).');
    }
    const id = `req_${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket!.write(JSON.stringify({ id, method, params }) + '\n');
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
