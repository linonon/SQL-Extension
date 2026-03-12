import { describe, it, expect } from 'vitest';
import { ConnectionTreeItem } from './tree-items';
import * as vscode from 'vscode';

describe('tree-items', () => {
  describe('ConnectionTreeItem', () => {
    it('disconnected 状态', () => {
      const item = new ConnectionTreeItem('conn1', 'MySQL Local', 'localhost', 3306, 'mysql', 'disconnected');

      expect(item.label).toBe('MySQL Local');
      expect(item.description).toBe('localhost:3306');
      expect(item.contextValue).toBe('connection-disconnected');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect(item.command?.command).toBe('sqlext.connect');
    });

    it('connected 状态', () => {
      const item = new ConnectionTreeItem('conn1', 'PG Local', '127.0.0.1', 5432, 'postgresql', 'connected');

      expect(item.contextValue).toBe('connection-connected-postgresql');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect(item.command?.command).toBe('sqlext.connect');
    });

    it('connecting 状态', () => {
      const item = new ConnectionTreeItem('conn1', 'MySQL', 'localhost', 3306, 'mysql', 'connecting');

      expect(item.contextValue).toBe('connection-connecting');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect(item.iconPath).toEqual(new vscode.ThemeIcon('loading~spin'));
      expect(item.command?.command).toBe('sqlext.cancelConnect');
    });

    it('should store connection metadata', () => {
      const item = new ConnectionTreeItem('conn-id-123', 'Test', '192.168.1.1', 9999, 'mysql', 'connected');

      expect(item.connectionId).toBe('conn-id-123');
      expect(item.connectionName).toBe('Test');
      expect(item.host).toBe('192.168.1.1');
      expect(item.port).toBe(9999);
      expect(item.driverType).toBe('mysql');
      expect(item.state).toBe('connected');
    });
  });
});
