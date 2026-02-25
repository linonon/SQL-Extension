import * as vscode from 'vscode';
import type { ConnectionManager } from '../services/connection-manager.js';
import { SchemaService } from '../services/schema-service.js';
import {
  ColumnTreeItem,
  ConnectionTreeItem,
  DatabaseTreeItem,
  KafkaTopicTreeItem,
  MongoDatabaseTreeItem,
  MongoCollectionTreeItem,
  MoreKeysTreeItem,
  RabbitMQQueueTreeItem,
  RedisDbTreeItem,
  RedisKeyGroupTreeItem,
  RedisKeyTreeItem,
  TableTreeItem,
} from './tree-items.js';

type TreeItem = ConnectionTreeItem | DatabaseTreeItem | TableTreeItem | ColumnTreeItem | RedisDbTreeItem | RedisKeyGroupTreeItem | RedisKeyTreeItem | MoreKeysTreeItem | KafkaTopicTreeItem | RabbitMQQueueTreeItem | MongoDatabaseTreeItem | MongoCollectionTreeItem;

const DRAG_MIME = 'application/vnd.code.tree.databaseConnections';

export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeItem>, vscode.TreeDragAndDropController<TreeItem> {
  readonly dropMimeTypes = [DRAG_MIME];
  readonly dragMimeTypes = [DRAG_MIME];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly schemaService = new SchemaService();

  constructor(private readonly connectionManager: ConnectionManager) {
    connectionManager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  handleDrag(source: readonly TreeItem[], dataTransfer: vscode.DataTransfer): void {
    const connections = source.filter((s) => s instanceof ConnectionTreeItem);
    if (connections.length === 0) { return; }
    dataTransfer.set(
      DRAG_MIME,
      new vscode.DataTransferItem(connections.map((c) => c.connectionId))
    );
  }

  async handleDrop(target: TreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DRAG_MIME);
    if (!item) { return; }
    const ids = item.value as string[];
    if (!ids || ids.length === 0) { return; }

    const beforeId = target instanceof ConnectionTreeItem ? target.connectionId : null;
    for (const id of ids) {
      await this.connectionManager.reorderConnection(id, beforeId);
    }
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element instanceof ConnectionTreeItem) {
      if (element.driverType === 'redis') {
        return this.getRedisDbItems(element);
      }
      if (element.driverType === 'kafka') {
        return this.getKafkaTopicItems(element);
      }
      if (element.driverType === 'rabbitmq') {
        return this.getRabbitMQQueueItems(element);
      }
      if (element.driverType === 'mongodb') {
        return this.getMongoDatabaseItems(element);
      }
      return this.getDatabaseItems(element);
    }
    if (element instanceof MongoDatabaseTreeItem) {
      return this.getMongoCollectionItems(element);
    }
    if (element instanceof RedisKeyGroupTreeItem) {
      return this.subdivideRedisKeys(element.connectionId, element.dbIndex, element.prefix, element.keys);
    }
    if (element instanceof RedisDbTreeItem) {
      return this.getRedisKeyItems(element);
    }
    if (element instanceof DatabaseTreeItem) {
      return this.getTableItems(element);
    }
    if (element instanceof TableTreeItem) {
      return this.getColumnItems(element);
    }
    return [];
  }

  private getRootItems(): TreeItem[] {
    return this.connectionManager.getConnectionInfo().map(
      (info) =>
        new ConnectionTreeItem(
          info.config.id,
          info.config.name,
          info.config.host,
          info.config.port,
          info.config.driverType,
          info.state
        )
    );
  }

  private async getDatabaseItems(item: ConnectionTreeItem): Promise<TreeItem[]> {
    if (item.state === 'connecting') {
      return [];
    }
    if (item.state !== 'connected') {
      this.connectionManager.connect(item.connectionId).then(() => {
        vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
      }).catch((err) => {
        vscode.window.showErrorMessage(
          `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return [];
    }
    try {
      const driver = this.connectionManager.getDriver(item.connectionId);
      const databases = await this.schemaService.listDatabases(driver);
      return databases.map((db) => new DatabaseTreeItem(item.connectionId, db));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list databases: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  private async getTableItems(item: DatabaseTreeItem): Promise<TreeItem[]> {
    try {
      const driver = this.connectionManager.getDriver(item.connectionId);
      const tables = await this.schemaService.listTables(driver, item.databaseName);
      return tables.map(
        (t) => new TableTreeItem(item.connectionId, item.databaseName, t.name, t.rowCount)
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to list tables: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async getColumnItems(item: TableTreeItem): Promise<TreeItem[]> {
    try {
      const driver = this.connectionManager.getDriver(item.connectionId);
      const columns = await this.schemaService.listColumns(
        driver,
        item.databaseName,
        item.tableName
      );
      return columns.map(
        (c) => new ColumnTreeItem(c.name, c.dataType, c.isPrimaryKey, c.nullable)
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to list columns: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async getKafkaTopicItems(item: ConnectionTreeItem): Promise<TreeItem[]> {
    if (item.state === 'connecting') {
      return [];
    }
    if (item.state !== 'connected') {
      this.connectionManager.connect(item.connectionId).then(() => {
        vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
      }).catch((err) => {
        vscode.window.showErrorMessage(
          `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return [];
    }
    try {
      const driver = this.connectionManager.getKafkaDriver(item.connectionId);
      const topics = await driver.listTopics();
      return topics
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => new KafkaTopicTreeItem(item.connectionId, t.name, t.partitionCount));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list Kafka topics: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  private async getRabbitMQQueueItems(item: ConnectionTreeItem): Promise<TreeItem[]> {
    if (item.state === 'connecting') {
      return [];
    }
    if (item.state !== 'connected') {
      this.connectionManager.connect(item.connectionId).then(() => {
        vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
      }).catch((err) => {
        vscode.window.showErrorMessage(
          `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return [];
    }
    try {
      const driver = this.connectionManager.getRabbitMQDriver(item.connectionId);
      const queues = await driver.listQueues();
      return queues
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((q) => new RabbitMQQueueTreeItem(item.connectionId, q.name, q.messages, q.consumers));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list RabbitMQ queues: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  private async getRedisDbItems(item: ConnectionTreeItem): Promise<TreeItem[]> {
    if (item.state === 'connecting') {
      return [];
    }
    if (item.state !== 'connected') {
      this.connectionManager.connect(item.connectionId).then(() => {
        vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
      }).catch((err) => {
        vscode.window.showErrorMessage(
          `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return [];
    }
    try {
      const driver = this.connectionManager.getRedisDriver(item.connectionId);
      const databases = await driver.listDatabases();
      return databases
        .filter((db) => db.keyCount > 0)
        .map((db) => new RedisDbTreeItem(item.connectionId, db.index, db.keyCount));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list Redis databases: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  private async getRedisKeyItems(item: RedisDbTreeItem): Promise<TreeItem[]> {
    try {
      const driver = this.connectionManager.getRedisDriver(item.connectionId);
      await driver.selectDatabase(item.dbIndex);
      const result = await driver.scan('*', '0', 200);

      const items = this.subdivideRedisKeys(item.connectionId, item.dbIndex, '', result.keys);

      if (result.cursor !== '0') {
        items.push(new MoreKeysTreeItem(item.connectionId, item.dbIndex));
      }
      return items;
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list Redis keys: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  /**
   * 按 prefix 之后的下一个 `:` 段做分组.
   * >= 2 个同段的 key 归为子组 (RedisKeyGroupTreeItem), 否则直接 leaf.
   * 递归展开时 TreeView 会再次调用 getChildren -> subdivideRedisKeys.
   */
  private subdivideRedisKeys(
    connectionId: string,
    dbIndex: number,
    parentPrefix: string,
    keys: readonly { readonly key: string; readonly type: string; readonly ttl: number }[]
  ): TreeItem[] {
    const buckets = new Map<string, { key: string; type: string; ttl: number }[]>();
    for (const k of keys) {
      const rest = k.key.slice(parentPrefix.length);
      const nextColon = rest.indexOf(':');
      const segment = nextColon === -1 ? '' : rest.slice(0, nextColon + 1);
      const bucket = buckets.get(segment);
      if (bucket) { bucket.push(k); } else { buckets.set(segment, [k]); }
    }

    const items: TreeItem[] = [];
    for (const [segment, bucket] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (segment === '' || bucket.length < 2) {
        for (const k of bucket) {
          items.push(new RedisKeyTreeItem(connectionId, dbIndex, k.key, k.type, k.ttl));
        }
      } else {
        const newPrefix = parentPrefix + segment;
        items.push(new RedisKeyGroupTreeItem(
          connectionId, dbIndex, newPrefix, segment, bucket.length, bucket
        ));
      }
    }
    return items;
  }


  private async getMongoDatabaseItems(item: ConnectionTreeItem): Promise<TreeItem[]> {
    if (item.state === 'connecting') {
      return [];
    }
    if (item.state !== 'connected') {
      this.connectionManager.connect(item.connectionId).then(() => {
        vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
      }).catch((err) => {
        vscode.window.showErrorMessage(
          `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return [];
    }
    try {
      const driver = this.connectionManager.getDriver(item.connectionId) as import('../drivers/mongo-driver.js').MongoDriver;
      const databases = await driver.listDatabases();
      return databases.map((name) => new MongoDatabaseTreeItem(item.connectionId, name));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list MongoDB databases: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  private async getMongoCollectionItems(item: MongoDatabaseTreeItem): Promise<TreeItem[]> {
    try {
      const driver = this.connectionManager.getDriver(item.connectionId) as import('../drivers/mongo-driver.js').MongoDriver;
      const tables = await driver.listTables(item.databaseName);
      return tables.map((t) => new MongoCollectionTreeItem(item.connectionId, item.databaseName, t.name));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list collections: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }
}
