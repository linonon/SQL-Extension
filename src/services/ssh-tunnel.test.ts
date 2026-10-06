import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SSHTunnelConfig } from '../types/connection';

// --- mocks ---

const mockSshClient = {
  on: vi.fn(),
  connect: vi.fn(),
  forwardOut: vi.fn(),
  end: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('ssh2', () => ({
  Client: class MockClient {
    on = mockSshClient.on;
    connect = mockSshClient.connect;
    forwardOut = mockSshClient.forwardOut;
    end = mockSshClient.end;
    destroy = mockSshClient.destroy;
  },
}));

const mockServer = {
  listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
  on: vi.fn(),
  close: vi.fn((cb?: () => void) => cb?.()),
  address: vi.fn(() => ({ port: 12345 })),
};

vi.mock('net', () => ({
  createServer: vi.fn(() => mockServer),
}));

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: vi.fn(() => '/Users/testuser'),
}));

// 私钥读取走 mock; known_hosts 用真实 fs.promises 读写临时目录
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  statSync: vi.fn(() => ({ mode: 0o100600 })),
  readFileSync: vi.fn(() => Buffer.from('fake-private-key')),
}));

import * as nodeFs from 'fs';
import * as nodeOs from 'os';
import * as nodePath from 'path';
import { createHash } from 'crypto';
import { createTunnel, hostKeyFingerprint, verifyHostKey, type TunnelOptions } from './ssh-tunnel';

const OPTS: TunnelOptions = { confirmHostKey: async () => true };

// expandHome 不是 export 的, 通过 createTunnel 的 privateKeyPath 行为间接测试

describe('createTunnel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认: ssh client on('ready') 立即触发 callback
    mockSshClient.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'ready') {
        Promise.resolve().then(() => cb());
      }
      return mockSshClient;
    });
    // 重置 server mock 到默认行为
    mockServer.listen.mockImplementation((_port: number, _host: string, cb: () => void) => cb());
    mockServer.on.mockImplementation(() => mockServer);
  });

  describe('expandHome (间接测试)', () => {
    it('~/path 应展开为 /Users/testuser/path', async () => {
      const fs = await import('fs');
      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'privateKey',
        privateKeyPath: '~/keys/id_rsa',
      };

      await createTunnel(config, '', 'db.example.com', 3306, OPTS);

      expect(fs.statSync).toHaveBeenCalledWith('/Users/testuser/keys/id_rsa');
      expect(fs.readFileSync).toHaveBeenCalledWith('/Users/testuser/keys/id_rsa');
    });

    it('~ 单独应展开为 /Users/testuser', async () => {
      const fs = await import('fs');
      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'privateKey',
        privateKeyPath: '~',
      };

      await createTunnel(config, '', 'db.example.com', 3306, OPTS);

      expect(fs.statSync).toHaveBeenCalledWith('/Users/testuser');
    });

    it('无 ~ 前缀的路径不变', async () => {
      const fs = await import('fs');
      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'privateKey',
        privateKeyPath: '/absolute/path/id_rsa',
      };

      await createTunnel(config, '', 'db.example.com', 3306, OPTS);

      expect(fs.statSync).toHaveBeenCalledWith('/absolute/path/id_rsa');
    });
  });

  describe('密码认证', () => {
    it('authType 非 privateKey 时, connectConfig 含 password', async () => {
      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'password',
      };

      await createTunnel(config, 'my-ssh-pass', 'db.example.com', 3306, OPTS);

      expect(mockSshClient.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'ssh.example.com',
          port: 22,
          username: 'user',
          password: 'my-ssh-pass',
        })
      );
    });
  });

  describe('私钥认证', () => {
    it('authType privateKey 时, connectConfig 含 privateKey', async () => {
      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'privateKey',
        privateKeyPath: '/path/to/key',
      };

      await createTunnel(config, '', 'db.example.com', 3306, OPTS);

      expect(mockSshClient.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'ssh.example.com',
          port: 22,
          username: 'user',
          privateKey: Buffer.from('fake-private-key'),
        })
      );
      // 不应含 password
      const connectArg = mockSshClient.connect.mock.calls[0][0];
      expect(connectArg).not.toHaveProperty('password');
    });

    it('私钥权限不安全时 (mode & 0o077 !== 0) 抛错', async () => {
      const fs = await import('fs');
      (fs.statSync as any).mockReturnValueOnce({ mode: 0o100644 });

      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'privateKey',
        privateKeyPath: '/path/to/key',
      };

      await expect(createTunnel(config, '', 'db.example.com', 3306, OPTS))
        .rejects.toThrow('insecure permissions');
    });
  });

  describe('SSH 连接成功', () => {
    it('resolve TunnelHandle 含 localPort 和 close()', async () => {
      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'password',
      };

      const handle = await createTunnel(config, 'pass', 'db.example.com', 3306, OPTS);

      expect(handle.localPort).toBe(12345);
      expect(typeof handle.close).toBe('function');
    });
  });

  describe('SSH 连接失败 (error event)', () => {
    it('sshClient error 时 reject', async () => {
      mockSshClient.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'error') {
          Promise.resolve().then(() => cb(new Error('SSH auth failed')));
        }
        return mockSshClient;
      });

      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'password',
      };

      await expect(createTunnel(config, 'pass', 'db.example.com', 3306, OPTS))
        .rejects.toThrow('SSH auth failed');
    });
  });

  describe('TCP server error', () => {
    it('server error 时 reject 并 end sshClient', async () => {
      mockSshClient.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'ready') {
          Promise.resolve().then(() => cb());
        }
        return mockSshClient;
      });

      mockServer.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'error') {
          Promise.resolve().then(() => cb(new Error('EADDRINUSE')));
        }
        return mockServer;
      });

      // server.listen 不触发 callback, 让 error 先触发
      mockServer.listen.mockImplementation(() => {});

      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'password',
      };

      await expect(createTunnel(config, 'pass', 'db.example.com', 3306, OPTS))
        .rejects.toThrow('EADDRINUSE');

      expect(mockSshClient.end).toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('调用 server.close 和 sshClient.end', async () => {
      const config: SSHTunnelConfig = {
        enabled: true,
        host: 'ssh.example.com',
        port: 22,
        username: 'user',
        authType: 'password',
      };

      const handle = await createTunnel(config, 'pass', 'db.example.com', 3306, OPTS);
      handle.close();

      expect(mockServer.close).toHaveBeenCalled();
      expect(mockSshClient.end).toHaveBeenCalled();
    });
  });

  describe('私钥 passphrase 与 ssh-agent', () => {
    const keyConfig = (privateKeyPath: string): SSHTunnelConfig => ({
      enabled: true, host: 'ssh.example.com', port: 22, username: 'user', authType: 'privateKey', privateKeyPath,
    });

    it('私钥认证时 SSH 密码字段作为 passphrase', async () => {
      await createTunnel(keyConfig('/path/to/key'), 'key-pass', 'db', 3306, OPTS);
      expect(mockSshClient.connect.mock.calls[0][0]).toMatchObject({ passphrase: 'key-pass' });
      expect(mockSshClient.connect.mock.calls[0][0]).not.toHaveProperty('password');
    });

    it('私钥路径为空时用 SSH_AUTH_SOCK 的 agent; 也没有 agent 则报错', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
      await createTunnel(keyConfig(''), '', 'db', 3306, OPTS);
      expect(mockSshClient.connect.mock.calls[0][0]).toMatchObject({ agent: '/tmp/agent.sock' });

      vi.stubEnv('SSH_AUTH_SOCK', '');
      await expect(createTunnel(keyConfig(''), '', 'db', 3306, OPTS)).rejects.toThrow('SSH_AUTH_SOCK');
      vi.unstubAllEnvs();
    });
  });

  describe('ready 之后', () => {
    const config: SSHTunnelConfig = { enabled: true, host: 'ssh.example.com', port: 22, username: 'user', authType: 'password' };
    let handlers: Record<string, (...args: unknown[]) => void>;

    beforeEach(() => {
      handlers = {};
      mockSshClient.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        if (event === 'ready') { Promise.resolve().then(() => cb()); }
        return mockSshClient;
      });
    });

    it('SSH 连接断开时关本地端口并通知一次; 调用方自己 close 不通知', async () => {
      const onClose = vi.fn();
      await createTunnel(config, 'pass', 'db', 3306, { ...OPTS, onClose });
      handlers.error(new Error('Keepalive timeout'));
      handlers.close();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockServer.close).toHaveBeenCalled();

      const onClose2 = vi.fn();
      const handle = await createTunnel(config, 'pass', 'db', 3306, { ...OPTS, onClose: onClose2 });
      handle.close();
      handlers.close();
      expect(onClose2).not.toHaveBeenCalled();
    });

    it('转发流出错时拆掉本地 socket, 两端都有 error 监听', async () => {
      const net = await import('net');
      await createTunnel(config, 'pass', 'db', 3306, OPTS);
      const onConnection = vi.mocked(net.createServer).mock.calls[0][0] as unknown as (sock: unknown) => void;
      const sockOn: Record<string, (err?: Error) => void> = {};
      const streamOn: Record<string, (err?: Error) => void> = {};
      const sock = {
        on: vi.fn((e: string, cb: () => void) => { sockOn[e] = cb; }), destroy: vi.fn(), pipe: vi.fn(() => stream),
      };
      const stream = {
        on: vi.fn((e: string, cb: () => void) => { streamOn[e] = cb; }), destroy: vi.fn(), pipe: vi.fn(),
      };
      mockSshClient.forwardOut.mockImplementation((...args: unknown[]) => (args[4] as (e: null, s: unknown) => void)(null, stream));
      onConnection(sock);

      streamOn.error(new Error('channel reset'));
      expect(sock.destroy).toHaveBeenCalled();
      expect(stream.destroy).toHaveBeenCalled();
      expect(sockOn.error).toBeDefined();
    });

    it('host key 被拒时报出拒绝原因, 而不是 ssh2 的 "Host denied"', async () => {
      mockSshClient.connect.mockImplementationOnce((cfg: { hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => void }) => {
        cfg.hostVerifier(Buffer.from('server-key'), (ok) => {
          if (!ok) { handlers.error(new Error('Host denied (verification failed)')); }
        });
      });
      mockSshClient.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        return mockSshClient;
      });
      // 用户不信任: 不写 known_hosts, 只验证拒绝原因被透传
      const confirmHostKey = vi.fn(async () => false);
      await expect(createTunnel(config, 'pass', 'db', 3306, { confirmHostKey })).rejects.toThrow('was not trusted');
      expect(confirmHostKey).toHaveBeenCalledWith('ssh.example.com:22', hostKeyFingerprint(Buffer.from('server-key')));
    });
  });

  describe('握手超时', () => {
    const config: SSHTunnelConfig = { enabled: true, host: 'ssh.example.com', port: 22, username: 'user', authType: 'password' };
    let handlers: Record<string, (...args: unknown[]) => void>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      handlers = {};
      mockSshClient.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        return mockSshClient;
      });
    });

    afterEach(() => vi.useRealTimers());

    it('20s 内没 ready: 关掉 ssh2 自带计时, 自己断开并 reject', async () => {
      const p = createTunnel(config, 'pass', 'db', 3306, OPTS);
      expect(mockSshClient.connect.mock.calls[0][0]).toMatchObject({ readyTimeout: 0 });
      vi.advanceTimersByTime(20_000);
      await expect(p).rejects.toThrow('Timed out while waiting for handshake');
      expect(mockSshClient.destroy).toHaveBeenCalled();
    });

    it('等用户回答信任弹框的时间不计入握手超时', async () => {
      let answer!: (ok: boolean) => void;
      const confirmHostKey = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
      mockSshClient.connect.mockImplementationOnce((cfg: { hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => void }) => {
        cfg.hostVerifier(Buffer.from('server-key'), (ok) => {
          if (!ok) { handlers.error(new Error('Host denied (verification failed)')); }
        });
      });
      const p = createTunnel(config, 'pass', 'db', 3306, { confirmHostKey });
      const settled = vi.fn();
      p.then(settled, settled);
      // known_hosts 读文件是真实 I/O, 等它走到弹框
      while (confirmHostKey.mock.calls.length === 0) { await new Promise((r) => setImmediate(r)); }

      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(mockSshClient.destroy).not.toHaveBeenCalled();

      answer(false);
      await expect(p).rejects.toThrow('was not trusted');
    });
  });
});

describe('verifyHostKey (trust-on-first-use)', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sqlext-kh-'));
    file = nodePath.join(tmp, 'sub', 'known_hosts');
  });

  afterEach(() => nodeFs.rmSync(tmp, { recursive: true, force: true }));

  it('指纹格式同 ssh-keygen: SHA256: + 无 padding 的 base64', () => {
    const key = Buffer.from('k');
    expect(hostKeyFingerprint(key)).toBe(`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`);
    expect(hostKeyFingerprint(key)).not.toMatch(/=$/);
  });

  it('首次见到: 问用户, 信任后记下 (目录 0700, 文件 0600), 之后同指纹直接放行', async () => {
    const confirm = vi.fn(async () => true);
    await verifyHostKey('jump:22', 'SHA256:aaa', confirm, file);
    expect(confirm).toHaveBeenCalledWith('jump:22', 'SHA256:aaa');
    expect(await nodeFs.promises.readFile(file, 'utf8')).toBe('jump:22 SHA256:aaa\n');
    expect((await nodeFs.promises.stat(file)).mode & 0o777).toBe(0o600);
    expect((await nodeFs.promises.stat(nodePath.dirname(file))).mode & 0o777).toBe(0o700);

    confirm.mockClear();
    await verifyHostKey('jump:22', 'SHA256:aaa', confirm, file);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('不信任则拒绝且不记录', async () => {
    await expect(verifyHostKey('jump:22', 'SHA256:aaa', async () => false, file)).rejects.toThrow('not trusted');
    expect(nodeFs.existsSync(file)).toBe(false);
  });

  it('指纹变了: 拒绝, 报出期望与收到的指纹和要改的文件, 不问用户', async () => {
    await verifyHostKey('jump:22', 'SHA256:old', async () => true, file);
    await verifyHostKey('other:22', 'SHA256:x', async () => true, file);
    const confirm = vi.fn(async () => true);
    const err = await verifyHostKey('jump:22', 'SHA256:new', confirm, file).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('expected SHA256:old, received SHA256:new');
    expect((err as Error).message).toContain(file);
    expect(confirm).not.toHaveBeenCalled();
  });
});
