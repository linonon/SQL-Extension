import * as net from 'net';
import * as os from 'os';
import { Client } from 'ssh2';
import * as fs from 'fs';
import type { SSHTunnelConfig } from '../types/connection.js';

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return os.homedir() + p.slice(1);
  }
  return p;
}

export interface TunnelHandle {
  readonly localPort: number;
  close(): void;
}

export function createTunnel(
  config: SSHTunnelConfig,
  sshPassword: string,
  targetHost: string,
  targetPort: number
): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    const sshClient = new Client();

    const connectConfig: Record<string, unknown> = {
      host: config.host,
      port: config.port,
      username: config.username,
    };

    if (config.authType === 'privateKey' && config.privateKeyPath) {
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
    } else {
      connectConfig.password = sshPassword;
    }

    sshClient.on('ready', () => {
      // SSH 连接建立后, 才启动 TCP server
      const server = net.createServer((sock) => {
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
            sock.pipe(stream).pipe(sock);
          }
        );
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve({
          localPort: addr.port,
          close() {
            server.close();
            sshClient.end();
          },
        });
      });

      server.on('error', (err) => {
        sshClient.end();
        reject(err);
      });
    });

    sshClient.on('error', (err: Error) => {
      reject(err);
    });

    // TODO [P1-4]: Implement "Trust on First Use" (TOFU) host key verification.
    // Currently accepts any host key, which is vulnerable to MITM attacks.
    // Planned: store fingerprint on first connect, verify on subsequent connects.
    sshClient.connect(connectConfig);
  });
}
