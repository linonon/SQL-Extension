import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionState, DriverType } from '../types/connection.js';

let resourcesPath = '';

export function setResourcesPath(extPath: string): void {
  resourcesPath = path.join(extPath, 'resources');
}

export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly connectionName: string,
    public readonly host: string,
    public readonly port: number,
    public readonly driverType: DriverType,
    public readonly state: ConnectionState
  ) {
    super(
      connectionName,
      state === 'connecting'
        ? vscode.TreeItemCollapsibleState.None
        : state === 'connected'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.id = state === 'connected' ? connectionId : `${connectionId}-${state}`;
    this.contextValue = state === 'connected'
      ? `connection-connected-${driverType}`
      : `connection-${state}`;

    if (state === 'connecting') {
      this.description = 'Connecting...';
      this.iconPath = new vscode.ThemeIcon('loading~spin');
      this.command = {
        command: 'sqlext.cancelConnect',
        title: 'Cancel Connection',
        arguments: [this],
      };
    } else {
      this.description = `${host}:${port}`;
      const iconState = state === 'connected' ? 'connected' : 'disconnected';
      this.iconPath = {
        light: path.join(resourcesPath, `${driverType}-${iconState}-light.svg`),
        dark: path.join(resourcesPath, `${driverType}-${iconState}-dark.svg`),
      };
    }
  }
}

export class DatabaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly databaseName: string
  ) {
    super(databaseName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'database';
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
  }
}

export class TableTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly databaseName: string,
    public readonly tableName: string,
    public readonly rowCount: number
  ) {
    super(tableName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `~${rowCount} rows`;
    this.contextValue = 'table';
    this.iconPath = new vscode.ThemeIcon('symbol-class');
    this.command = {
      command: 'sqlext.openTable',
      title: 'Open Table',
      arguments: [this],
    };
  }
}

export class ColumnTreeItem extends vscode.TreeItem {
  constructor(
    public readonly columnName: string,
    public readonly dataType: string,
    public readonly isPrimaryKey: boolean,
    public readonly nullable: boolean
  ) {
    super(columnName, vscode.TreeItemCollapsibleState.None);
    const tags: string[] = [dataType];
    if (isPrimaryKey) { tags.push('PK'); }
    if (!nullable) { tags.push('NOT NULL'); }
    this.description = tags.join(', ');
    this.contextValue = 'column';
    this.iconPath = new vscode.ThemeIcon(
      isPrimaryKey ? 'key' : 'symbol-field'
    );
  }
}

export class KafkaTopicTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly topicName: string,
    public readonly partitionCount: number
  ) {
    super(topicName, vscode.TreeItemCollapsibleState.None);
    this.description = `${partitionCount} partitions`;
    this.contextValue = 'kafka-topic';
    this.iconPath = new vscode.ThemeIcon('symbol-event');
    this.command = {
      command: 'sqlext.openKafkaTopic',
      title: 'Open Kafka Browser',
      arguments: [this],
    };
  }
}

export class RabbitMQQueueTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly queueName: string,
    public readonly messageCount: number,
    public readonly consumerCount: number
  ) {
    super(queueName, vscode.TreeItemCollapsibleState.None);
    this.description = `${messageCount} msgs, ${consumerCount} consumers`;
    this.contextValue = 'rmq-queue';
    this.iconPath = new vscode.ThemeIcon('symbol-event');
    this.command = {
      command: 'sqlext.openRabbitMQQueue',
      title: 'Open RabbitMQ Browser',
      arguments: [this],
    };
  }
}


export class MongoDatabaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly databaseName: string
  ) {
    super(databaseName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'mongo-database';
    this.iconPath = new vscode.ThemeIcon('database');
  }
}

export class MongoCollectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly databaseName: string,
    public readonly collectionName: string
  ) {
    super(collectionName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'mongo-collection';
    this.iconPath = new vscode.ThemeIcon('list-unordered');
  }
}

export class RedisDbTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly dbIndex: number,
    public readonly keyCount: number
  ) {
    super(`db${dbIndex}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${keyCount} keys`;
    this.contextValue = 'redis-db';
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.command = {
      command: 'sqlext.openRedisDb',
      title: 'Open Redis Browser',
      arguments: [this],
    };
  }
}

export class RedisKeyGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly dbIndex: number,
    public readonly prefix: string,
    public readonly groupName: string,
    public readonly keyCount: number,
    public readonly keys: readonly { readonly key: string; readonly type: string; readonly ttl: number }[]
  ) {
    super(groupName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${keyCount} keys`;
    this.contextValue = 'redis-key-group';
    this.iconPath = new vscode.ThemeIcon('symbol-folder');
  }
}

export class MoreKeysTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly dbIndex: number
  ) {
    super('... more keys (open Redis Browser)', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'redis-more-keys';
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.command = { command: 'sqlext.openRedisKey', title: 'Open', arguments: [connectionId, dbIndex] };
  }
}

export class RedisKeyTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly dbIndex: number,
    public readonly keyName: string,
    public readonly keyType: string,
    public readonly ttl: number
  ) {
    super(keyName, vscode.TreeItemCollapsibleState.None);
    const tags: string[] = [keyType];
    if (ttl >= 0) { tags.push(`TTL:${ttl}s`); }
    this.description = tags.join(', ');
    this.contextValue = 'redis-key';
    this.iconPath = new vscode.ThemeIcon('symbol-key');
    this.command = {
      command: 'sqlext.openRedisKey',
      title: 'Open Redis Key',
      arguments: [this],
    };
  }
}
