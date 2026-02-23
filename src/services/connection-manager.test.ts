import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionConfig } from '../types/connection';
import type { IDatabaseDriver } from '../types/driver';

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
import { ConnectionManager } from './connection-manager';
import { CredentialStore } from './credential-store';

// Mock drivers
vi.mock('../drivers/mysql-driver', () => ({
  MySQLDriver: class MockMySQLDriver {
    driverType = 'mysql';
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    isConnected = vi.fn(() => true);
    listDatabases = vi.fn();
    listTables = vi.fn();
    listColumns = vi.fn();
    execute = vi.fn();
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
        './connection-manager'
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

      manager.dispose();

      // 验证每个已连接 driver 的 disconnect 被调用
      expect(driver1.disconnect).toHaveBeenCalledOnce();
      expect(driver2.disconnect).toHaveBeenCalledOnce();

      // dispose 后所有连接状态应为 disconnected
      expect(manager.getState('conn1')).toBe('disconnected');
      expect(manager.getState('conn2')).toBe('disconnected');
    });
  });
});
