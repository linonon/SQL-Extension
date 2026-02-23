import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SSHTunnelConfig } from '../types/connection';

// --- mocks ---

const mockSshClient = {
  on: vi.fn(),
  connect: vi.fn(),
  forwardOut: vi.fn(),
  end: vi.fn(),
};

vi.mock('ssh2', () => ({
  Client: class MockClient {
    on = mockSshClient.on;
    connect = mockSshClient.connect;
    forwardOut = mockSshClient.forwardOut;
    end = mockSshClient.end;
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

vi.mock('os', () => ({
  homedir: vi.fn(() => '/Users/testuser'),
}));

vi.mock('fs', () => ({
  statSync: vi.fn(() => ({ mode: 0o100600 })),
  readFileSync: vi.fn(() => Buffer.from('fake-private-key')),
}));

import { createTunnel } from './ssh-tunnel';

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

      await createTunnel(config, '', 'db.example.com', 3306);

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

      await createTunnel(config, '', 'db.example.com', 3306);

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

      await createTunnel(config, '', 'db.example.com', 3306);

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

      await createTunnel(config, 'my-ssh-pass', 'db.example.com', 3306);

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

      await createTunnel(config, '', 'db.example.com', 3306);

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

      await expect(createTunnel(config, '', 'db.example.com', 3306))
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

      const handle = await createTunnel(config, 'pass', 'db.example.com', 3306);

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

      await expect(createTunnel(config, 'pass', 'db.example.com', 3306))
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

      await expect(createTunnel(config, 'pass', 'db.example.com', 3306))
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

      const handle = await createTunnel(config, 'pass', 'db.example.com', 3306);
      handle.close();

      expect(mockServer.close).toHaveBeenCalled();
      expect(mockSshClient.end).toHaveBeenCalled();
    });
  });
});
