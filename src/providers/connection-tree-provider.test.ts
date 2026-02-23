import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionTreeProvider } from './connection-tree-provider';
import { RedisDbTreeItem, RedisKeyTreeItem, MoreKeysTreeItem, ConnectionTreeItem } from './tree-items';
import type { ConnectionManager } from '../services/connection-manager';

function createMockConnectionManager(): ConnectionManager {
  return {
    onDidChange: vi.fn().mockReturnValue({ dispose: () => {} }),
    getConnections: vi.fn().mockReturnValue([]),
    getConnectionInfo: vi.fn().mockReturnValue([]),
    connect: vi.fn(),
    getDriver: vi.fn(),
    getRedisDriver: vi.fn(),
  } as unknown as ConnectionManager;
}

describe('ConnectionTreeProvider (Redis)', () => {
  let provider: ConnectionTreeProvider;
  let connMgr: ConnectionManager;

  beforeEach(() => {
    connMgr = createMockConnectionManager();
    provider = new ConnectionTreeProvider(connMgr);
  });

  describe('getRedisDbItems', () => {
    it('Redis connection 走 getRedisDbItems 分支', async () => {
      const mockDriver = {
        listDatabases: vi.fn().mockResolvedValue([
          { index: 0, keyCount: 100 },
          { index: 1, keyCount: 0 },
          { index: 3, keyCount: 42 },
        ]),
      };
      (connMgr.getRedisDriver as any).mockReturnValue(mockDriver);

      const connItem = new ConnectionTreeItem('conn1', 'Redis Local', 'localhost', 6379, 'redis', 'connected');
      const children = await provider.getChildren(connItem);

      // 只返回 keyCount > 0 的 db
      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(RedisDbTreeItem);
      expect((children[0] as RedisDbTreeItem).dbIndex).toBe(0);
      expect((children[1] as RedisDbTreeItem).dbIndex).toBe(3);
    });
  });

  describe('getRedisKeyItems (#7)', () => {
    it('cursor === "0" 时没有 MoreKeysTreeItem', async () => {
      const mockDriver = {
        selectDatabase: vi.fn(),
        scan: vi.fn().mockResolvedValue({
          cursor: '0',
          keys: [{ key: 'k1', type: 'string', ttl: -1 }],
        }),
      };
      (connMgr.getRedisDriver as any).mockReturnValue(mockDriver);

      const dbItem = new RedisDbTreeItem('conn1', 0, 100);
      const children = await provider.getChildren(dbItem);

      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(RedisKeyTreeItem);
    });

    it('cursor !== "0" 时末尾有 MoreKeysTreeItem', async () => {
      const mockDriver = {
        selectDatabase: vi.fn(),
        scan: vi.fn().mockResolvedValue({
          cursor: '42',
          keys: [
            { key: 'k1', type: 'string', ttl: -1 },
            { key: 'k2', type: 'hash', ttl: 300 },
          ],
        }),
      };
      (connMgr.getRedisDriver as any).mockReturnValue(mockDriver);

      const dbItem = new RedisDbTreeItem('conn1', 0, 100);
      const children = await provider.getChildren(dbItem);

      expect(children).toHaveLength(3);
      expect(children[0]).toBeInstanceOf(RedisKeyTreeItem);
      expect(children[1]).toBeInstanceOf(RedisKeyTreeItem);
      expect(children[2]).toBeInstanceOf(MoreKeysTreeItem);
    });

    it('driver 抛错返回空数组', async () => {
      (connMgr.getRedisDriver as any).mockReturnValue({
        selectDatabase: vi.fn().mockRejectedValue(new Error('fail')),
      });

      const dbItem = new RedisDbTreeItem('conn1', 0, 10);
      const children = await provider.getChildren(dbItem);

      expect(children).toEqual([]);
    });
  });
});
