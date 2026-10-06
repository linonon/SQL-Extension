import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ConnectionConfig } from '../types/connection';
import type { IDatabaseDriver } from '../types/driver';

// pendingConnects: 依次交给新建 driver 的 connect, 用来让某次连接挂起
const { mysqlInstances, pendingConnects, createTunnel } = vi.hoisted(() => ({
  mysqlInstances: [] as Array<{ connect: Mock; disconnect: Mock; ping: Mock }>,
  pendingConnects: [] as Array<Promise<void>>,
  createTunnel: vi.fn(),
}));
vi.mock('./ssh-tunnel', () => ({ createTunnel, KNOWN_HOSTS_PATH: '/tmp/known_hosts' }));

// Mock vscode manually
vi.mock('vscode', async () => {
  return {
    EventEmitter: class EventEmitter {
      private handlers: Function[] = [];
      event = (handler: Function) => {
        this.handlers.push(handler);
        return {
          dispose: () => {
            this.handlers = this.handlers.filter((h) => h !== handler);
          },
        };
      };
      fire(data?: unknown) {
        for (const h of this.handlers) {
          h(data);
        }
      }
      dispose() {
        this.handlers = [];
      }
    },
  };
});

// 在 mock 之后导入
import { ConnectionManager, openDriver, prependQueryHistory } from './connection-manager';
import { CredentialStore } from './credential-store';

// Mock drivers
vi.mock('../drivers/mysql-driver', () => ({
  MySQLDriver: class MockMySQLDriver {
    driverType = 'mysql';
    connect = vi.fn(() => pendingConnects.shift() ?? Promise.resolve());
    disconnect = vi.fn().mockResolvedValue(undefined);
    ping = vi.fn().mockResolvedValue(undefined);
    isConnected = vi.fn(() => true);
    listDatabases = vi.fn();
    listTables = vi.fn();
    listColumns = vi.fn();
    execute = vi.fn();
    constructor() { mysqlInstances.push(this); }
  },
}));

vi.mock('../drivers/pg-driver', () => ({
  PgDriver: class MockPgDriver {
    driverType = 'postgresql';
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    isConnected = vi.fn(() => true);
    listDatabases = vi.fn();
    listTables = vi.fn();
    listColumns = vi.fn();
    execute = vi.fn();
  },
}));

describe('ConnectionManager', () => {
  let manager: ConnectionManager;
  let mockGlobalState: any;
  let mockCredentialStore: CredentialStore;
  let mockSecrets: any;

  beforeEach(() => {
    // Mock global state (Memento)
    mockGlobalState = {
      get: vi.fn(() => []),
      update: vi.fn(),
    };

    // Mock secrets storage
    mockSecrets = {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
    };

    mockCredentialStore = new CredentialStore(mockSecrets);

    manager = new ConnectionManager(mockGlobalState, mockCredentialStore);
  });

  describe('connect concurrency', () => {
    it('并发 connect 共用一次连接过程, 只建一个 driver, 后到者也拿得到 driver', async () => {
      mockGlobalState.get.mockReturnValue([{
        id: 'c1', name: 'x', driverType: 'mysql', host: 'h', port: 3306, username: 'u', database: '',
      }]);
      mockSecrets.get.mockImplementation(async () => { await new Promise(r => setTimeout(r, 10)); return 'pw'; });
      mysqlInstances.length = 0;
      await Promise.all([manager.connect('c1'), manager.connect('c1'), manager.connect('c1')]);
      expect(mysqlInstances).toHaveLength(1);
      expect(manager.getState('c1')).toBe('connected');
      expect(() => manager.getDriver('c1')).not.toThrow();
    });
  });

  describe('getConnections', () => {
    it('应该返回空数组 (初始状态)', () => {
      const connections = manager.getConnections();
      expect(connections).toEqual([]);
      expect(mockGlobalState.get).toHaveBeenCalledWith('sqlext.connections', []);
    });

    it('应该返回已保存的连接', () => {
      const savedConnections: ConnectionConfig[] = [
        {
          id: 'conn1',
          name: 'MySQL Local',
          driverType: 'mysql',
          host: 'localhost',
          port: 3306,
          username: 'root',
          database: 'testdb',
        },
      ];

      mockGlobalState.get.mockReturnValue(savedConnections);

      const connections = manager.getConnections();
      expect(connections).toEqual(savedConnections);
    });
  });

  describe('getConnectionInfo', () => {
    it('应该返回连接信息和状态', () => {
      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);

      const infos = manager.getConnectionInfo();

      expect(infos).toEqual([
        {
          config,
          state: 'disconnected',
        },
      ]);
    });
  });

  describe('addConnection', () => {
    it('应该添加新连接并保存密码', async () => {
      // 需要在添加订阅后再创建新 manager, 或者先订阅再调用方法
      const testManager = new ConnectionManager(mockGlobalState, mockCredentialStore);
      const onChangeHandler = vi.fn();
      testManager.onDidChange(onChangeHandler);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      await testManager.addConnection(config, 'secret123');

      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.connections', [
        config,
      ]);
      expect(mockSecrets.store).toHaveBeenCalledWith(
        'sqlext.password.conn1',
        'secret123'
      );
      expect(onChangeHandler).toHaveBeenCalled();
    });

    it('应该追加到现有连接列表', async () => {
      const existing: ConnectionConfig = {
        id: 'conn1',
        name: 'Existing',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'db1',
      };

      const newConn: ConnectionConfig = {
        id: 'conn2',
        name: 'New',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        database: 'db2',
      };

      mockGlobalState.get.mockReturnValue([existing]);

      await manager.addConnection(newConn, 'password');

      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.connections', [
        existing,
        newConn,
      ]);
    });
  });

  describe('duplicateConnection', () => {
    it('配置换新 id 和名字, DB / SSH 密码拷到新 id, 源连接不动', async () => {
      const source: ConnectionConfig = {
        id: 'src',
        name: 'Prod',
        driverType: 'mysql',
        host: 'db.internal',
        port: 3306,
        username: 'root',
        database: 'app',
        ssh: { enabled: true, host: 'jump', port: 22, username: 'ops', authType: 'password' },
        readOnly: true,
      };
      const snapshot = structuredClone(source);
      const secrets: Record<string, string> = {
        'sqlext.password.src': 'db-pw',
        'sqlext.sshPassword.src': 'ssh-pw',
      };
      mockGlobalState.get.mockReturnValue([source]);
      mockSecrets.get.mockImplementation(async (k: string) => secrets[k]);

      const newId = await manager.duplicateConnection('src');

      expect(newId).not.toBe('src');
      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.connections', [
        source,
        { ...snapshot, id: newId, name: 'Prod (copy)' },
      ]);
      expect(mockSecrets.store).toHaveBeenCalledWith(`sqlext.password.${newId}`, 'db-pw');
      expect(mockSecrets.store).toHaveBeenCalledWith(`sqlext.sshPassword.${newId}`, 'ssh-pw');
      expect(mockSecrets.store).toHaveBeenCalledTimes(2);
      expect(mockSecrets.delete).not.toHaveBeenCalled();
      expect(source).toEqual(snapshot);
    });
  });

  describe('updateConnection', () => {
    const base: ConnectionConfig = {
      id: 'c1', name: 'Release', driverType: 'mysql', host: 'db', port: 3306, username: 'root', database: 'app',
      ssh: { enabled: true, host: 'jump', port: 22, username: 'ops', authType: 'password' },
    };

    it('密码为 undefined 时保留已存的 DB / SSH 密码', async () => {
      mockGlobalState.get.mockReturnValue([base]);
      await manager.updateConnection('c1', { ...base, readOnly: true });
      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.connections', [{ ...base, readOnly: true }]);
      expect(mockSecrets.store).not.toHaveBeenCalled();
      expect(mockSecrets.delete).not.toHaveBeenCalled();
    });

    it('给了新值就替换', async () => {
      mockGlobalState.get.mockReturnValue([base]);
      await manager.updateConnection('c1', base, 'new-db', 'new-ssh');
      expect(mockSecrets.store).toHaveBeenCalledWith('sqlext.password.c1', 'new-db');
      expect(mockSecrets.store).toHaveBeenCalledWith('sqlext.sshPassword.c1', 'new-ssh');
    });

    it('关掉 SSH 时删除已存的 SSH 密码, DB 密码不动', async () => {
      mockGlobalState.get.mockReturnValue([base]);
      await manager.updateConnection('c1', { ...base, ssh: undefined }, undefined, 'ignored');
      expect(mockSecrets.delete).toHaveBeenCalledWith('sqlext.sshPassword.c1');
      expect(mockSecrets.store).not.toHaveBeenCalled();
    });
  });

  describe('query history', () => {
    const entry = (sql: string, ts: number) => ({ sql, database: 'db', ts, ok: true });

    it('新的在前, 连续相同 SQL 只留最新一条, 最多 200 条', () => {
      let list = prependQueryHistory([], entry('a', 1));
      list = prependQueryHistory(list, entry('b', 2));
      list = prependQueryHistory(list, entry('b', 3));
      list = prependQueryHistory(list, entry('a', 4));
      expect(list.map((e) => [e.sql, e.ts])).toEqual([['a', 4], ['b', 3], ['a', 1]]);
      for (let i = 0; i < 300; i++) { list = prependQueryHistory(list, entry(`q${i}`, i)); }
      expect(list).toHaveLength(200);
      expect(list[0].sql).toBe('q299');
    });

    it('按连接分 key 存, 删连接时一并删掉; 超长 SQL 不记', async () => {
      await manager.addQueryHistory('conn1', entry('x'.repeat(100_001), 0));
      expect(mockGlobalState.update).not.toHaveBeenCalled();
      await manager.addQueryHistory('conn1', entry('a', 1));
      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.queryHistory.conn1', [entry('a', 1)]);
      await manager.removeConnection('conn1');
      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.queryHistory.conn1', undefined);
    });
  });

  describe('removeConnection', () => {
    it('应该移除连接并删除密码', async () => {
      const testManager = new ConnectionManager(mockGlobalState, mockCredentialStore);
      const onChangeHandler = vi.fn();
      testManager.onDidChange(onChangeHandler);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);

      await testManager.removeConnection('conn1');

      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.connections', []);
      expect(mockSecrets.delete).toHaveBeenCalledWith('sqlext.password.conn1');
      expect(onChangeHandler).toHaveBeenCalled();
    });

    it('移除不存在的连接应该安全执行', async () => {
      mockGlobalState.get.mockReturnValue([]);

      await manager.removeConnection('nonexistent');

      expect(mockGlobalState.update).toHaveBeenCalledWith('sqlext.connections', []);
    });
  });

  describe('connect', () => {
    it('应该创建 MySQL driver 并连接', async () => {
      const testManager = new ConnectionManager(mockGlobalState, mockCredentialStore);
      const onChangeHandler = vi.fn();
      testManager.onDidChange(onChangeHandler);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'MySQL',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('password123');

      await testManager.connect('conn1');

      expect(mockSecrets.get).toHaveBeenCalledWith('sqlext.password.conn1');
      expect(testManager.getState('conn1')).toBe('connected');
      expect(onChangeHandler).toHaveBeenCalled();

      const driver = testManager.getDriver('conn1');
      expect(driver.driverType).toBe('mysql');
    });

    it('应该创建 PostgreSQL driver 并连接', async () => {
      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'PG',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pgpass');

      await manager.connect('conn1');

      const driver = manager.getDriver('conn1');
      expect(driver.driverType).toBe('postgresql');
    });

    it('连接过程中应该设置 connecting 状态', async () => {
      const testManager = new ConnectionManager(mockGlobalState, mockCredentialStore);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      const states: string[] = [];
      testManager.onDidChange(() => {
        states.push(testManager.getState('conn1'));
      });

      await testManager.connect('conn1');

      // 应该有 connecting -> connected 的状态变化
      expect(states).toContain('connecting');
      expect(states).toContain('connected');
    });

    it('连接失败时应该设置 disconnected 状态并抛出错误', async () => {
      // 这个测试比较特殊, 需要 mock 失败的连接
      // 由于 mock 是全局的, 这里用 vi.doMock 动态 mock
      vi.resetModules();

      // 临时 mock 一个会失败的 driver
      vi.doMock('../drivers/mysql-driver', () => ({
        MySQLDriver: class FailingMySQLDriver {
          driverType = 'mysql';
          connect = vi.fn().mockRejectedValue(new Error('Connection failed'));
          disconnect = vi.fn();
          isConnected = vi.fn(() => false);
          listDatabases = vi.fn();
          listTables = vi.fn();
          listColumns = vi.fn();
          execute = vi.fn();
        },
      }));

      // 重新导入以使用新 mock
      const { ConnectionManager: TestConnectionManager } = await import(
        './connection-manager.js'
      );
      const testManager = new TestConnectionManager(
        mockGlobalState,
        mockCredentialStore
      );

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      await expect(testManager.connect('conn1')).rejects.toThrow('Connection failed');
      expect(testManager.getState('conn1')).toBe('disconnected');

      // 清理
      vi.resetModules();
    });

    it('连接不存在时应该抛出错误', async () => {
      mockGlobalState.get.mockReturnValue([]);

      await expect(manager.connect('nonexistent')).rejects.toThrow(
        'Connection not found: nonexistent'
      );
    });

    it('密码不存在时应该抛出错误', async () => {
      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue(undefined);

      await expect(manager.connect('conn1')).rejects.toThrow(
        'Password not found for connection'
      );
    });

    it('不支持的 driver 类型应该抛出错误', async () => {
      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'unsupported' as any,
        host: 'localhost',
        port: 9999,
        username: 'user',
        database: 'db',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      await expect(manager.connect('conn1')).rejects.toThrow(
        'Unsupported driver type: unsupported'
      );
    });
  });

  describe('disconnect', () => {
    it('应该断开连接并更新状态', async () => {
      const testManager = new ConnectionManager(mockGlobalState, mockCredentialStore);
      const onChangeHandler = vi.fn();
      testManager.onDidChange(onChangeHandler);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      await testManager.connect('conn1');
      expect(testManager.getState('conn1')).toBe('connected');

      await testManager.disconnect('conn1');

      expect(testManager.getState('conn1')).toBe('disconnected');
      expect(onChangeHandler).toHaveBeenCalled();
    });

    it('断开未连接的连接应该安全执行', async () => {
      await manager.disconnect('nonexistent');
      expect(manager.getState('nonexistent')).toBe('disconnected');
    });
  });

  describe('getDriver', () => {
    it('应该返回已连接的 driver', async () => {
      const testManager = new ConnectionManager(mockGlobalState, mockCredentialStore);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      await testManager.connect('conn1');

      const driver = testManager.getDriver('conn1');
      expect(driver).toBeDefined();
      expect(driver.driverType).toBe('mysql');
    });

    it('未连接时应该抛出错误', () => {
      expect(() => manager.getDriver('nonexistent')).toThrow(
        'No active connection: nonexistent'
      );
    });
  });

  describe('getState', () => {
    it('未连接时应该返回 disconnected', () => {
      expect(manager.getState('any')).toBe('disconnected');
    });

    it('已连接时应该返回 connected', async () => {
      const testManager = new ConnectionManager(mockGlobalState, mockCredentialStore);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Test',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      await testManager.connect('conn1');
      expect(testManager.getState('conn1')).toBe('connected');
    });
  });

  describe('cancelConnect (竞态保护)', () => {
    it('connect 期间调 disconnect, connect 应 silent return, 状态保持 disconnected', async () => {
      vi.resetModules();

      let connectResolve: () => void;
      const connectPromise = new Promise<void>((resolve) => {
        connectResolve = resolve;
      });
      const mockDisconnectFn = vi.fn().mockResolvedValue(undefined);

      vi.doMock('../drivers/mysql-driver', () => ({
        MySQLDriver: class SlowMySQLDriver {
          driverType = 'mysql';
          connect = vi.fn(() => connectPromise);
          disconnect = mockDisconnectFn;
          isConnected = vi.fn(() => false);
          listDatabases = vi.fn();
          listTables = vi.fn();
          listColumns = vi.fn();
          execute = vi.fn();
        },
      }));

      const { ConnectionManager: TestCM } = await import('./connection-manager.js');
      const testManager = new TestCM(mockGlobalState, mockCredentialStore);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'Slow',
        driverType: 'mysql',
        host: 'unreachable',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      // 启动 connect (会阻塞在 driver.connect)
      const connectTask = testManager.connect('conn1');
      // flush microtasks: getPassword resolve -> states.set('connecting') -> await driver.connect 阻塞
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(testManager.getState('conn1')).toBe('connecting');

      // connect 进行中调 disconnect
      await testManager.disconnect('conn1');
      expect(testManager.getState('conn1')).toBe('disconnected');

      // 让 driver.connect 完成
      connectResolve!();
      await connectTask;

      // connect 完成后发现状态已变, 应 silent return, 新 driver 被 disconnect
      expect(testManager.getState('conn1')).toBe('disconnected');
      expect(mockDisconnectFn).toHaveBeenCalled();

      vi.resetModules();
    });

    it('connect 失败时若已被 disconnect, 不覆盖 disconnected 状态', async () => {
      vi.resetModules();

      let connectReject: (err: Error) => void;
      const connectPromise = new Promise<void>((_, reject) => {
        connectReject = reject;
      });

      vi.doMock('../drivers/mysql-driver', () => ({
        MySQLDriver: class FailSlowMySQLDriver {
          driverType = 'mysql';
          connect = vi.fn(() => connectPromise);
          disconnect = vi.fn().mockResolvedValue(undefined);
          isConnected = vi.fn(() => false);
          listDatabases = vi.fn();
          listTables = vi.fn();
          listColumns = vi.fn();
          execute = vi.fn();
        },
      }));

      const { ConnectionManager: TestCM } = await import('./connection-manager.js');
      const testManager = new TestCM(mockGlobalState, mockCredentialStore);

      const config: ConnectionConfig = {
        id: 'conn1',
        name: 'FailSlow',
        driverType: 'mysql',
        host: 'unreachable',
        port: 3306,
        username: 'root',
        database: 'testdb',
      };

      mockGlobalState.get.mockReturnValue([config]);
      mockSecrets.get.mockResolvedValue('pass');

      const connectTask = testManager.connect('conn1');
      // flush microtasks
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(testManager.getState('conn1')).toBe('connecting');

      // disconnect 先于 connect 失败
      await testManager.disconnect('conn1');
      expect(testManager.getState('conn1')).toBe('disconnected');

      // driver.connect 抛错
      connectReject!(new Error('Timeout'));
      await expect(connectTask).rejects.toThrow('Timeout');

      // 状态不应被 catch 中覆盖, 仍为 disconnected
      expect(testManager.getState('conn1')).toBe('disconnected');

      vi.resetModules();
    });
  });

  describe('dispose', () => {
    it('应该关闭所有连接', async () => {
      const config1: ConnectionConfig = {
        id: 'conn1',
        name: 'Test1',
        driverType: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        database: 'db1',
      };

      const config2: ConnectionConfig = {
        id: 'conn2',
        name: 'Test2',
        driverType: 'postgresql',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        database: 'db2',
      };

      mockGlobalState.get.mockReturnValue([config1, config2]);
      mockSecrets.get.mockResolvedValue('pass');

      await manager.connect('conn1');
      await manager.connect('conn2');

      // 获取 driver 引用, 以便验证 disconnect 被调用
      const driver1 = manager.getDriver('conn1');
      const driver2 = manager.getDriver('conn2');

      await manager.dispose();

      // 验证每个已连接 driver 的 disconnect 被调用
      expect(driver1.disconnect).toHaveBeenCalledOnce();
      expect(driver2.disconnect).toHaveBeenCalledOnce();

      // dispose 后所有连接状态应为 disconnected
      expect(manager.getState('conn1')).toBe('disconnected');
      expect(manager.getState('conn2')).toBe('disconnected');
    });
  });

  describe('连接生命周期 (openDriver / teardown)', () => {
    const sshConfig: ConnectionConfig = {
      id: 'c1', name: 'release', driverType: 'mysql', host: 'db.internal', port: 3306, username: 'root', database: 'app',
      ssh: { enabled: true, host: 'jump', port: 22, username: 'ops', authType: 'password' },
    };
    let tunnelClose: Mock;
    let onTunnelClose: (() => void) | undefined;

    beforeEach(() => {
      mysqlInstances.length = 0;
      tunnelClose = vi.fn();
      createTunnel.mockReset();
      createTunnel.mockImplementation(async (_ssh, _pw, _host, _port, opts: { onClose?: () => void }) => {
        onTunnelClose = opts.onClose;
        return { localPort: 4000, close: tunnelClose };
      });
    });

    it('openDriver: 经 tunnel 连 127.0.0.1:<本地端口>; DB 失败时关掉 tunnel, 错误点名是哪一跳', async () => {
      const handle = await openDriver(sshConfig, 'pw', 'ssh-pw');
      expect(createTunnel).toHaveBeenCalledWith(sshConfig.ssh, 'ssh-pw', 'db.internal', 3306, expect.anything());
      expect(mysqlInstances[0].connect).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 4000, password: 'pw' }));
      await handle.close();
      expect(mysqlInstances[0].disconnect).toHaveBeenCalled();
      expect(tunnelClose).toHaveBeenCalledTimes(1);

      tunnelClose.mockClear();
      const failing = openDriver(sshConfig, 'pw', 'ssh-pw');
      mysqlInstances[1].connect.mockRejectedValueOnce(new Error('Access denied for user root'));
      await expect(failing).rejects.toThrow('mysql db.internal:3306 (via SSH) failed: Access denied for user root');
      expect(tunnelClose).toHaveBeenCalledTimes(1);

      createTunnel.mockRejectedValueOnce(new Error('All configured authentication methods failed'));
      await expect(openDriver(sshConfig, 'pw', 'bad')).rejects.toThrow(
        'SSH tunnel ops@jump:22 failed: All configured authentication methods failed'
      );
    });

    it('取消后马上再连: 另起一次连接; 被取消的那次结束时关掉自己的连接, 不动新连接', async () => {
      mockGlobalState.get.mockReturnValue([{ ...sshConfig, ssh: undefined }]);
      mockSecrets.get.mockResolvedValue('pw');
      let release!: () => void;
      pendingConnects.push(new Promise<void>((r) => { release = r; }));
      const first = manager.connect('c1');
      await vi.waitFor(() => expect(manager.getState('c1')).toBe('connecting'));
      await manager.disconnect('c1');

      const second = manager.connect('c1');
      expect(second).not.toBe(first);
      await second;
      release();
      await first;

      expect(manager.getState('c1')).toBe('connected');
      expect(manager.getDriver('c1')).toBe(mysqlInstances[1]);
      expect(mysqlInstances[0].disconnect).toHaveBeenCalled();
      expect(mysqlInstances[1].disconnect).not.toHaveBeenCalled();
    });

    it('心跳失败只拆被 ping 的那个连接, 不拆其间重连上的新连接', async () => {
      mockGlobalState.get.mockReturnValue([{ ...sshConfig, ssh: undefined }]);
      mockSecrets.get.mockResolvedValue('pw');
      await manager.connect('c1');
      let failPing!: (err: Error) => void;
      mysqlInstances[0].ping.mockReturnValueOnce(new Promise((_, reject) => { failPing = reject; }));

      const heartbeat = (manager as unknown as { checkConnections(): Promise<void> }).checkConnections();
      await manager.disconnect('c1');
      await manager.connect('c1');
      failPing(new Error('ECONNRESET'));
      await heartbeat;

      expect(manager.getState('c1')).toBe('connected');
      expect(manager.getDriver('c1')).toBe(mysqlInstances[1]);

      mysqlInstances[1].ping.mockRejectedValueOnce(new Error('ECONNRESET'));
      await (manager as unknown as { checkConnections(): Promise<void> }).checkConnections();
      expect(manager.getState('c1')).toBe('disconnected');
      expect(mysqlInstances[1].disconnect).toHaveBeenCalled();
    });

    it('心跳 ping 卡住时 10s 超时拆掉, 卡住期间的下一轮心跳跳过', async () => {
      mockGlobalState.get.mockReturnValue([{ ...sshConfig, ssh: undefined }]);
      mockSecrets.get.mockResolvedValue('pw');
      await manager.connect('c1');
      vi.useFakeTimers();
      try {
        mysqlInstances[0].ping.mockReturnValue(new Promise(() => {}));
        const check = () => (manager as unknown as { checkConnections(): Promise<void> }).checkConnections();
        const first = check();
        await check();
        expect(mysqlInstances[0].ping).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(10_000);
        await first;
        expect(manager.getState('c1')).toBe('disconnected');
        expect(mysqlInstances[0].disconnect).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('SSH 连接断开即拆掉连接, 不等心跳', async () => {
      mockGlobalState.get.mockReturnValue([sshConfig]);
      mockSecrets.get.mockResolvedValue('pw');
      await manager.connect('c1');
      expect(manager.getState('c1')).toBe('connected');

      onTunnelClose!();
      expect(manager.getState('c1')).toBe('disconnected');
      await vi.waitFor(() => expect(tunnelClose).toHaveBeenCalled());
      expect(() => manager.getDriver('c1')).toThrow('No active connection');
    });
  });
});
