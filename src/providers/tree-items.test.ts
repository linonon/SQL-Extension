import { describe, it, expect } from 'vitest';
import {
  ConnectionTreeItem,
  DatabaseTreeItem,
  TableTreeItem,
  ColumnTreeItem,
  MoreKeysTreeItem,
  RedisDbTreeItem,
  RedisKeyTreeItem,
  RedisKeyGroupTreeItem,
} from './tree-items';
import * as vscode from 'vscode';

describe('tree-items', () => {
  describe('ConnectionTreeItem', () => {
    it('disconnected 状态应该显示正确的属性', () => {
      const item = new ConnectionTreeItem(
        'conn1',
        'MySQL Local',
        'localhost',
        3306,
        'mysql',
        'disconnected'
      );

      expect(item.label).toBe('MySQL Local');
      expect(item.description).toBe('localhost:3306');
      expect(item.contextValue).toBe('connection-disconnected');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect(item.iconPath).toEqual({
        light: 'mysql-disconnected-light.svg',
        dark: 'mysql-disconnected-dark.svg',
      });
    });

    it('connected 状态应该可折叠', () => {
      const item = new ConnectionTreeItem(
        'conn1',
        'PG Local',
        '127.0.0.1',
        5432,
        'postgresql',
        'connected'
      );

      expect(item.contextValue).toBe('connection-connected');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
      expect(item.iconPath).toEqual({
        light: 'postgresql-connected-light.svg',
        dark: 'postgresql-connected-dark.svg',
      });
    });

    it('connecting 状态应该可折叠', () => {
      const item = new ConnectionTreeItem(
        'conn1',
        'MySQL',
        'localhost',
        3306,
        'mysql',
        'connecting'
      );

      expect(item.contextValue).toBe('connection-connecting');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      // connecting 状态使用 ThemeIcon loading~spin 动画图标
      expect(item.iconPath).toEqual(new vscode.ThemeIcon('loading~spin'));
    });

    it('应该保存连接元数据', () => {
      const item = new ConnectionTreeItem(
        'conn-id-123',
        'Test Connection',
        '192.168.1.1',
        9999,
        'mysql',
        'connected'
      );

      expect(item.connectionId).toBe('conn-id-123');
      expect(item.connectionName).toBe('Test Connection');
      expect(item.host).toBe('192.168.1.1');
      expect(item.port).toBe(9999);
      expect(item.driverType).toBe('mysql');
      expect(item.state).toBe('connected');
    });
  });

  describe('DatabaseTreeItem', () => {
    it('应该创建可折叠的数据库节点', () => {
      const item = new DatabaseTreeItem('conn1', 'testdb');

      expect(item.label).toBe('testdb');
      expect(item.contextValue).toBe('database');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('symbol-namespace');
    });

    it('应该保存数据库元数据', () => {
      const item = new DatabaseTreeItem('conn-123', 'my_database');

      expect(item.connectionId).toBe('conn-123');
      expect(item.databaseName).toBe('my_database');
    });
  });

  describe('TableTreeItem', () => {
    it('应该创建可折叠的表节点', () => {
      const item = new TableTreeItem('conn1', 'testdb', 'users', 100);

      expect(item.label).toBe('users');
      expect(item.description).toBe('~100 rows');
      expect(item.contextValue).toBe('table');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('symbol-class');
    });

    it('应该包含打开表的命令', () => {
      const item = new TableTreeItem('conn1', 'testdb', 'orders', 500);

      expect(item.command).toBeDefined();
      expect(item.command!.command).toBe('sqlext.openTable');
      expect(item.command!.title).toBe('Open Table');
      expect(item.command!.arguments).toEqual([item]);
    });

    it('应该正确显示大量行数', () => {
      const item = new TableTreeItem('conn1', 'db', 'big_table', 1234567);

      expect(item.description).toBe('~1234567 rows');
    });

    it('应该正确显示零行', () => {
      const item = new TableTreeItem('conn1', 'db', 'empty_table', 0);

      expect(item.description).toBe('~0 rows');
    });

    it('应该保存表元数据', () => {
      const item = new TableTreeItem('conn-id', 'mydb', 'mytable', 42);

      expect(item.connectionId).toBe('conn-id');
      expect(item.databaseName).toBe('mydb');
      expect(item.tableName).toBe('mytable');
      expect(item.rowCount).toBe(42);
    });
  });

  describe('ColumnTreeItem', () => {
    it('主键列应该显示正确的属性', () => {
      const item = new ColumnTreeItem('id', 'int', true, false);

      expect(item.label).toBe('id');
      expect(item.description).toBe('int, PK, NOT NULL');
      expect(item.contextValue).toBe('column');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('key');
    });

    it('普通可空列应该显示正确的属性', () => {
      const item = new ColumnTreeItem('name', 'varchar', false, true);

      expect(item.description).toBe('varchar');
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('symbol-field');
    });

    it('普通非空列应该显示 NOT NULL', () => {
      const item = new ColumnTreeItem('email', 'varchar', false, false);

      expect(item.description).toBe('varchar, NOT NULL');
    });

    it('主键可空列应该同时显示 PK', () => {
      const item = new ColumnTreeItem('uuid', 'uuid', true, true);

      expect(item.description).toBe('uuid, PK');
    });

    it('应该保存列元数据', () => {
      const item = new ColumnTreeItem('created_at', 'timestamp', false, true);

      expect(item.columnName).toBe('created_at');
      expect(item.dataType).toBe('timestamp');
      expect(item.isPrimaryKey).toBe(false);
      expect(item.nullable).toBe(true);
    });

    it('应该处理长数据类型名称', () => {
      const item = new ColumnTreeItem(
        'data',
        'character varying(255)',
        false,
        true
      );

      expect(item.description).toBe('character varying(255)');
    });

    it('应该处理特殊字符的列名', () => {
      const item = new ColumnTreeItem('user_id', 'bigint', true, false);

      expect(item.label).toBe('user_id');
      expect(item.description).toBe('bigint, PK, NOT NULL');
    });
  });

  describe('RedisDbTreeItem', () => {
    it('keyCount > 0 时 collapsibleState 为 None (点击打开 webview)', () => {
      const item = new RedisDbTreeItem('conn1', 0, 100);

      expect(item.label).toBe('db0');
      expect(item.description).toBe('100 keys');
      expect(item.contextValue).toBe('redis-db');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('symbol-namespace');
    });

    it('keyCount === 0 时不可折叠', () => {
      const item = new RedisDbTreeItem('conn1', 3, 0);

      expect(item.label).toBe('db3');
      expect(item.description).toBe('0 keys');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });

    it('应该保存元数据', () => {
      const item = new RedisDbTreeItem('conn-id', 5, 42);

      expect(item.connectionId).toBe('conn-id');
      expect(item.dbIndex).toBe(5);
      expect(item.keyCount).toBe(42);
    });
  });

  describe('RedisKeyTreeItem', () => {
    it('应该显示正确的属性', () => {
      const item = new RedisKeyTreeItem('conn1', 0, 'user:1', 'hash', -1);

      expect(item.label).toBe('user:1');
      expect(item.description).toBe('hash');
      expect(item.contextValue).toBe('redis-key');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('symbol-key');
    });

    it('有 TTL 时应该显示', () => {
      const item = new RedisKeyTreeItem('conn1', 0, 'session:abc', 'string', 300);

      expect(item.description).toBe('string, TTL:300s');
    });

    it('TTL === -1 时不显示 TTL', () => {
      const item = new RedisKeyTreeItem('conn1', 0, 'k', 'string', -1);

      expect(item.description).toBe('string');
    });

    it('应该包含打开 key 的命令', () => {
      const item = new RedisKeyTreeItem('conn1', 0, 'k', 'string', -1);

      expect(item.command).toBeDefined();
      expect(item.command!.command).toBe('sqlext.openRedisKey');
    });

    it('应该保存元数据', () => {
      const item = new RedisKeyTreeItem('conn-id', 2, 'mykey', 'list', 60);

      expect(item.connectionId).toBe('conn-id');
      expect(item.dbIndex).toBe(2);
      expect(item.keyName).toBe('mykey');
      expect(item.keyType).toBe('list');
      expect(item.ttl).toBe(60);
    });
  });

  describe('MoreKeysTreeItem', () => {
    it('应该显示提示文本', () => {
      const item = new MoreKeysTreeItem('conn1', 2);

      expect(item.label).toBe('... more keys (open Redis Browser)');
      expect(item.contextValue).toBe('redis-more-keys');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('ellipsis');
    });

    it('应该包含打开 Redis Browser 的命令', () => {
      const item = new MoreKeysTreeItem('conn1', 3);

      expect(item.command).toBeDefined();
      expect(item.command!.command).toBe('sqlext.openRedisKey');
      expect(item.command!.arguments).toEqual(['conn1', 3]);
    });
  });

  describe('RedisKeyGroupTreeItem', () => {
    it('应该显示正确属性', () => {
      const keys = [
        { key: 'user:1', type: 'string', ttl: -1 },
        { key: 'user:2', type: 'hash', ttl: 300 },
      ];
      const item = new RedisKeyGroupTreeItem('conn1', 0, 'user:', 'user:', 2, keys);

      expect(item.label).toBe('user:');
      expect(item.description).toBe('2 keys');
      expect(item.contextValue).toBe('redis-key-group');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('symbol-folder');
    });

    it('应该保存 keys 数据', () => {
      const keys = [
        { key: 'cache:a', type: 'string', ttl: 60 },
        { key: 'cache:b', type: 'string', ttl: -1 },
        { key: 'cache:c', type: 'list', ttl: -1 },
      ];
      const item = new RedisKeyGroupTreeItem('conn-id', 2, 'cache:', 'cache:', 3, keys);

      expect(item.connectionId).toBe('conn-id');
      expect(item.dbIndex).toBe(2);
      expect(item.prefix).toBe('cache:');
      expect(item.keyCount).toBe(3);
      expect(item.keys).toEqual(keys);
    });
  });

  describe('边界条件', () => {
    it('ConnectionTreeItem 应该处理空字符串名称', () => {
      const item = new ConnectionTreeItem('', '', '', 0, 'mysql', 'disconnected');

      expect(item.label).toBe('');
      expect(item.description).toBe(':0');
    });

    it('TableTreeItem 应该处理负数行数 (理论上不应该发生)', () => {
      const item = new TableTreeItem('conn', 'db', 'table', -1);

      expect(item.description).toBe('~-1 rows');
    });

    it('ColumnTreeItem 应该处理空数据类型', () => {
      const item = new ColumnTreeItem('col', '', false, true);

      expect(item.description).toBe('');
    });
  });
});
