import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionTreeProvider } from './connection-tree-provider';
import { ConnectionTreeItem } from './tree-items';
import type { ConnectionManager } from '../services/connection-manager';

function createMockConnectionManager(): ConnectionManager {
  return {
    onDidChange: vi.fn().mockReturnValue({ dispose: () => {} }),
    getConnectionInfo: vi.fn().mockReturnValue([]),
  } as unknown as ConnectionManager;
}

describe('ConnectionTreeProvider', () => {
  let provider: ConnectionTreeProvider;
  let connMgr: ConnectionManager;

  beforeEach(() => {
    connMgr = createMockConnectionManager();
    provider = new ConnectionTreeProvider(connMgr);
  });

  it('root returns ConnectionTreeItems', async () => {
    (connMgr.getConnectionInfo as any).mockReturnValue([
      { config: { id: 'c1', name: 'MySQL', host: 'localhost', port: 3306, driverType: 'mysql' }, state: 'disconnected' },
      { config: { id: 'c2', name: 'PG', host: 'localhost', port: 5432, driverType: 'postgresql' }, state: 'connected' },
    ]);

    const children = await provider.getChildren();

    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(ConnectionTreeItem);
    expect((children[0] as ConnectionTreeItem).connectionName).toBe('MySQL');
    expect((children[1] as ConnectionTreeItem).connectionName).toBe('PG');
  });

  it('connection item returns empty children (flat list)', async () => {
    const connItem = new ConnectionTreeItem('c1', 'MySQL', 'localhost', 3306, 'mysql', 'connected');
    const children = await provider.getChildren(connItem);

    expect(children).toEqual([]);
  });
});
