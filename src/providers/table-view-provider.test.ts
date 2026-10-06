import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { TableViewProvider } from './table-view-provider';
import type { ConnectionManager } from '../services/connection-manager';
import type { CredentialStore } from '../services/credential-store';

describe('TableViewProvider panel 标题', () => {
  it('Query / DDL / Edit 标题带连接名, 不同环境的同名库能分开', async () => {
    const create = vi.spyOn(vscode.window, 'createWebviewPanel').mockClear();
    const cm = {
      getConnections: () => [{ id: 'c1', name: 'release' }],
      getDriver: () => ({ driverType: 'mysql', getTableDDL: async () => 'CREATE TABLE t (id int)' }),
    } as unknown as ConnectionManager;
    const provider = new TableViewProvider(vscode.Uri.file('/ext'), cm, {} as CredentialStore);

    provider.openQueryEditor('c1', 'game');
    provider.showTableDDL('c1', 'game', 'player');
    provider.openEditTable('c1', 'game', 'player');

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(create.mock.calls.map((c) => c[1]).sort()).toEqual([
      'DDL - release/game.player',
      'Edit - release/game.player',
      'Query - release/game',
    ]);
  });
});
