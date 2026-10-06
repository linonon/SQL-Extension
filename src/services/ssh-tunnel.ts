import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Client, type ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import type { SSHTunnelConfig } from '../types/connection.js';

// 每行 "host:port SHA256:<base64>", 与 IPC socket 同目录 (0700), 文件 0600
export const KNOWN_HOSTS_PATH = path.join(os.homedir(), '.sql-extension', 'known_hosts');

// 定期发 SSH keepalive: 睡眠 / 断网留下的半开连接按 keepaliveCountMax (默认 3) 次无应答判定断开, 触发 close
const KEEPALIVE_INTERVAL_MS = 15_000;

// 握手 (TCP connect 到认证完成) 超时. ssh2 自带的 readyTimeout 会把用户看 host key 信任弹框的时间也计进去,
// 所以关掉它 (readyTimeout: 0) 由 createTunnel 自己计时, 弹框期间暂停
const HANDSHAKE_TIMEOUT_MS = 20_000;

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return os.homedir() + p.slice(1);
  }
  return p;
}

// 与 ssh-keygen -lf 相同的写法: "SHA256:" + 去掉末尾 '=' 的 base64
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

// trust-on-first-use: known_hosts 里没有 hostPort 时经 confirm 问用户, 信任才记下;
// 已记下的指纹对不上就拒绝 (中间人, 或服务器换了 key: 后者由用户删掉文件里那一行). 放行时 resolve, 拒绝时 reject
export async function verifyHostKey(
  hostPort: string,
  fingerprint: string,
  confirm: (hostPort: string, fingerprint: string) => Promise<boolean>,
  file = KNOWN_HOSTS_PATH,
): Promise<void> {
  let content = '';
  try {
    content = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
  }
  const known = content.split('\n').map((line) => line.trim().split(/\s+/)).find(([host]) => host === hostPort)?.[1];
  if (known === fingerprint) { return; }
  if (known) {
    throw new Error(
      `host key of ${hostPort} has changed: expected ${known}, received ${fingerprint}. ` +
      `If the server key was replaced on purpose, delete the "${hostPort}" line in ${file}`
    );
  }
  if (!(await confirm(hostPort, fingerprint))) {
    throw new Error(`host key of ${hostPort} (${fingerprint}) was not trusted`);
  }
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700);
  await fs.promises.appendFile(file, `${hostPort} ${fingerprint}\n`, { mode: 0o600 });
  await fs.promises.chmod(file, 0o600);
}

export interface TunnelHandle {
  readonly localPort: number;
  close(): void;
}

export interface TunnelOptions {
  // 首次见到某个 SSH host 的 key 时问用户是否信任
  readonly confirmHostKey: (hostPort: string, fingerprint: string) => Promise<boolean>;
  // 交付 localPort 之后 SSH 连接断开 (对端关闭 / 网络错误 / keepalive 超时) 时调用一次; 调用方自己 close() 不触发
  readonly onClose?: () => void;
}

export function createTunnel(
  config: SSHTunnelConfig,
  sshPassword: string,
  targetHost: string,
  targetPort: number,
  options: TunnelOptions
): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    const sshClient = new Client();
    // hostVerifier 拒绝时 ssh2 只报 "Host denied", 用这里记下的原因 (指纹不符 / 用户不信任) 替换
    let hostKeyError: Error | undefined;
    let server: net.Server | undefined;
    // opened: localPort 已交给调用方; closed: 已关闭 (调用方 close() 或失败 / 断开已处理过)
    let opened = false;
    let closed = false;
    let handshakeTimer: NodeJS.Timeout | undefined;

    // 交付前的失败 reject; 交付后的断开关掉本地端口并通知调用方一次
    const onLost = (err?: Error) => {
      clearTimeout(handshakeTimer);
      if (closed) { return; }
      closed = true;
      server?.close();
      if (opened) {
        options.onClose?.();
      } else {
        reject(hostKeyError ?? err ?? new Error('SSH connection closed'));
      }
    };

    const startHandshakeTimer = () => {
      if (closed) { return; }
      handshakeTimer = setTimeout(() => {
        sshClient.destroy();
        onLost(new Error('Timed out while waiting for handshake'));
      }, HANDSHAKE_TIMEOUT_MS);
    };

    // 等用户回答信任弹框时暂停握手计时, 回答后重新计
    const confirmHostKey = async (hostPort: string, fingerprint: string): Promise<boolean> => {
      clearTimeout(handshakeTimer);
      try {
        return await options.confirmHostKey(hostPort, fingerprint);
      } finally {
        startHandshakeTimer();
      }
    };

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      readyTimeout: 0,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        verifyHostKey(`${config.host}:${config.port}`, hostKeyFingerprint(key), confirmHostKey).then(
          () => verify(true),
          (err: Error) => { hostKeyError = err; verify(false); }
        );
      },
    };

    if (config.authType === 'privateKey') {
      if (config.privateKeyPath) {
        const keyPath = expandHome(config.privateKeyPath);
        const stat = fs.statSync(keyPath);
        // eslint-disable-next-line no-bitwise
        if ((stat.mode & 0o077) !== 0) {
          throw new Error(
            `SSH private key file "${keyPath}" has insecure permissions ` +
            `(${(stat.mode & 0o777).toString(8)}). Run: chmod 600 "${keyPath}"`
          );
        }
        connectConfig.privateKey = fs.readFileSync(keyPath);
        // 私钥认证时 SSH 密码字段存的是加密私钥的 passphrase
        if (sshPassword) { connectConfig.passphrase = sshPassword; }
      } else if (process.env.SSH_AUTH_SOCK) {
        // 不填私钥路径即用 ssh-agent 里的 key
        connectConfig.agent = process.env.SSH_AUTH_SOCK;
      } else {
        throw new Error('no private key path given and no ssh-agent running (SSH_AUTH_SOCK is not set)');
      }
    } else {
      connectConfig.password = sshPassword;
    }

    sshClient.on('ready', () => {
      clearTimeout(handshakeTimer);
      // SSH 连接建立后, 才启动 TCP server
      server = net.createServer((sock) => {
        // 任一端出错都拆掉两端; 没有 'error' 监听的 socket 出错会成为未捕获异常
        sock.on('error', () => sock.destroy());
        sshClient.forwardOut(
          sock.remoteAddress ?? '127.0.0.1',
          sock.remotePort ?? 0,
          targetHost,
          targetPort,
          (err, stream) => {
            if (err) {
              sock.destroy();
              return;
            }
            sock.on('error', () => stream.destroy());
            stream.on('error', () => { stream.destroy(); sock.destroy(); });
            sock.pipe(stream).pipe(sock);
          }
        );
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as net.AddressInfo;
        opened = true;
        resolve({
          localPort: addr.port,
          close() {
            closed = true;
            server!.close();
            sshClient.end();
          },
        });
      });

      server.on('error', (err) => {
        sshClient.end();
        reject(err);
      });
    });

    sshClient.on('error', (err: Error) => onLost(err));
    sshClient.on('close', () => onLost());

    startHandshakeTimer();
    sshClient.connect(connectConfig);
  });
}
