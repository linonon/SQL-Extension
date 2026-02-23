import * as vscode from 'vscode';
import { ConnectionManager } from './services/connection-manager.js';
import { CredentialStore } from './services/credential-store.js';
import { ConnectionTreeProvider } from './providers/connection-tree-provider.js';
import { TableViewProvider } from './providers/table-view-provider.js';
import { ConnectionTreeItem, DatabaseTreeItem, KafkaTopicTreeItem, MongoDatabaseTreeItem, MongoCollectionTreeItem, RabbitMQQueueTreeItem, RedisDbTreeItem, RedisKeyTreeItem, TableTreeItem, setResourcesPath } from './providers/tree-items.js';
import type { MongoDriver } from './drivers/mongo-driver.js';
import { DumpService } from './services/dump-service.js';
import { exportRedisKeys, importRedisKeys } from './providers/redis-message-handler.js';

export function activate(context: vscode.ExtensionContext): void {
  setResourcesPath(context.extensionPath);
  const credentialStore = new CredentialStore(context.secrets);
  const connectionManager = new ConnectionManager(context.globalState, credentialStore);
  const treeProvider = new ConnectionTreeProvider(connectionManager);
  const viewProvider = new TableViewProvider(
    context.extensionUri,
    connectionManager,
    credentialStore
  );

  const dumpService = new DumpService();

  // 注册 TreeView
  const treeView = vscode.window.createTreeView('databaseConnections', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // 注册命令
  const commands: Array<[string, (...args: unknown[]) => void | Promise<void>]> = [
    ['sqlext.addConnection', () => {
      viewProvider.openConnectionForm();
    }],

    ['sqlext.removeConnection', async (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        const confirm = await vscode.window.showWarningMessage(
          `Remove connection "${item.connectionName}"?`,
          { modal: true },
          'Remove'
        );
        if (confirm === 'Remove') {
          await connectionManager.removeConnection(item.connectionId);
        }
      }
    }],

    ['sqlext.connect', async (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        try {
          await connectionManager.connect(item.connectionId);
          vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        const info = connectionManager.getConnectionInfo().find(i => i.config.id === item.connectionId);
        if (info?.config.driverType === 'mongodb' && info.state === 'connected') {
          viewProvider.openMongoBrowser(item.connectionId, item.connectionName, info.config.driverType);
        }
      }
    }],

    ['sqlext.cancelConnect', async (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        await connectionManager.disconnect(item.connectionId);
      }
    }],

    ['sqlext.disconnect', async (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        await connectionManager.disconnect(item.connectionId);
        vscode.window.showInformationMessage(`Disconnected from ${item.connectionName}`);
      }
    }],

    ['sqlext.openTable', (item: unknown) => {
      if (item instanceof TableTreeItem) {
        const config = connectionManager.getConnections().find((c) => c.id === item.connectionId);
        if (config?.driverType === 'mongodb') {
          viewProvider.openMongoBrowser(item.connectionId, config.name, config.driverType);
          return;
        }
        viewProvider.openTableView(
          item.connectionId,
          item.databaseName,
          item.tableName
        );
      }
    }],

    ['sqlext.newQuery', (item: unknown) => {
      if (item instanceof MongoDatabaseTreeItem) {
        const conn = connectionManager.getConnections().find((c) => c.id === item.connectionId);
        viewProvider.openMongoQueryEditor(item.connectionId, item.databaseName, conn?.name ?? item.connectionId);
        return;
      }
      if (item instanceof DatabaseTreeItem) {
        const conn = connectionManager.getConnections().find((c) => c.id === item.connectionId);
        if (conn?.driverType === 'mongodb') {
          viewProvider.openMongoQueryEditor(item.connectionId, item.databaseName, conn.name);
          return;
        }
        viewProvider.openQueryEditor(item.connectionId, item.databaseName);
      }
    }],

    ['sqlext.editConnection', (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        viewProvider.openConnectionForm(item.connectionId);
      }
    }],

    ['sqlext.editTable', (item: unknown) => {
      if (item instanceof TableTreeItem) {
        viewProvider.openEditTable(item.connectionId, item.databaseName, item.tableName);
      }
    }],

    ['sqlext.showTableDDL', (item: unknown) => {
      if (item instanceof TableTreeItem) {
        viewProvider.showTableDDL(item.connectionId, item.databaseName, item.tableName);
      }
    }],

    ['sqlext.dumpStruct', async (item: unknown) => {
      if (item instanceof TableTreeItem) {
        const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const uri = await vscode.window.showSaveDialog({
          filters: { 'SQL Files': ['sql'] },
          defaultUri: vscode.Uri.file(`${baseDir}/${item.tableName}_${ts}.sql`),
        });
        if (!uri) { return; }
        const driver = connectionManager.getDriver(item.connectionId);
        const content = await dumpService.dumpStruct(driver, item.databaseName, item.tableName);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        vscode.window.showInformationMessage(`Struct dumped to ${uri.fsPath}`);
      }
    }],

    ['sqlext.dumpStructAndData', async (item: unknown) => {
      if (item instanceof TableTreeItem) {
        const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const uri = await vscode.window.showSaveDialog({
          filters: { 'SQL Files': ['sql'] },
          defaultUri: vscode.Uri.file(`${baseDir}/${item.tableName}_${ts}.sql`),
        });
        if (!uri) { return; }
        const driver = connectionManager.getDriver(item.connectionId);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Dumping ${item.tableName}...`, cancellable: true },
          async (progress, token) => {
            const content = await dumpService.dumpStructAndData(
              driver,
              item.databaseName,
              item.tableName,
              (current, total) => {
                progress.report({ increment: 0, message: `${current}/${total} rows` });
              },
              token
            );
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
            vscode.window.showInformationMessage(`Data dumped to ${uri.fsPath}`);
          }
        );
      }
    }],

    ['sqlext.importSql', async (item: unknown) => {
      let connId: string | undefined;
      let dbName: string | undefined;
      if (item instanceof TableTreeItem) {
        connId = item.connectionId;
        dbName = item.databaseName;
      } else if (item instanceof DatabaseTreeItem) {
        connId = item.connectionId;
        dbName = item.databaseName;
      }
      if (!connId || !dbName) { return; }

      const uris = await vscode.window.showOpenDialog({
        filters: { 'SQL Files': ['sql'] },
        canSelectMany: false,
      });
      if (!uris || uris.length === 0) { return; }

      const fileContent = await vscode.workspace.fs.readFile(uris[0]);
      const sql = Buffer.from(fileContent).toString('utf-8');
      const driver = connectionManager.getDriver(connId);

      try {
        const { promise } = driver.executeCancellable(sql, undefined, dbName);
        const result = await promise;
        vscode.window.showInformationMessage(
          `SQL imported successfully. Affected rows: ${result.affectedRows}`
        );
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Import failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }],

    ['sqlext.openRedisKey', (item: unknown) => {
      if (item instanceof RedisKeyTreeItem) {
        viewProvider.openRedisBrowser(item.connectionId, item.dbIndex);
      }
    }],

    ['sqlext.deleteRedisKey', async (item: unknown) => {
      if (item instanceof RedisKeyTreeItem) {
        const confirm = await vscode.window.showWarningMessage(
          `Delete Redis key "${item.keyName}"?`,
          { modal: true },
          'Delete'
        );
        if (confirm === 'Delete') {
          const driver = connectionManager.getRedisDriver(item.connectionId);
          await driver.selectDatabase(item.dbIndex);
          await driver.deleteKey(item.keyName);
          treeProvider.refresh();
        }
      }
    }],

    ['sqlext.openRedisDb', (item: unknown) => {
      if (item instanceof RedisDbTreeItem) {
        viewProvider.openRedisBrowser(item.connectionId, item.dbIndex);
      }
    }],

    ['sqlext.refreshRedisDb', (item: unknown) => {
      if (item instanceof RedisDbTreeItem) {
        treeProvider.refresh();
      }
    }],

    ['sqlext.exportRedisDb', async (item: unknown) => {
      if (!(item instanceof RedisDbTreeItem)) { return; }
      try {
        const driver = connectionManager.getRedisDriver(item.connectionId);
        await driver.selectDatabase(item.dbIndex);
        const allKeys: string[] = [];
        let cursor = '0';
        do {
          const result = await driver.scan('*', cursor, 1000);
          allKeys.push(...result.keys.map((k) => k.key));
          cursor = result.cursor;
        } while (cursor !== '0');

        if (allKeys.length === 0) {
          vscode.window.showInformationMessage('No keys to export');
          return;
        }

        const result = await exportRedisKeys(driver, item.dbIndex, allKeys);
        if (result.errors.length > 0) {
          vscode.window.showWarningMessage(`Export completed with errors: ${result.errors.join('; ')}`);
        }
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file(`redis-export-db${item.dbIndex}.json`),
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(result.json, 'utf-8'));
          vscode.window.showInformationMessage(`Exported ${result.keyCount} key(s) to ${uri.fsPath}`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }],

    ['sqlext.importRedisDb', async (item: unknown) => {
      if (!(item instanceof RedisDbTreeItem)) { return; }
      try {
        const fileUris = await vscode.window.showOpenDialog({
          filters: { 'JSON Files': ['json'] },
          canSelectMany: false,
        });
        if (!fileUris || fileUris.length === 0) { return; }
        const content = Buffer.from(await vscode.workspace.fs.readFile(fileUris[0])).toString('utf-8');
        const parsed = JSON.parse(content) as { keys?: unknown[] };
        const keyCount = Array.isArray(parsed.keys) ? parsed.keys.length : 0;
        const confirm = await vscode.window.showWarningMessage(
          `Import ${keyCount} key(s) into db${item.dbIndex}? Existing keys will be overwritten.`,
          { modal: true },
          'Import'
        );
        if (confirm !== 'Import') { return; }
        const driver = connectionManager.getRedisDriver(item.connectionId);
        const result = await importRedisKeys(driver, item.dbIndex, content);
        if (result.errors.length > 0) {
          vscode.window.showWarningMessage(`Import completed with errors: ${result.errors.join('; ')}`);
        }
        vscode.window.showInformationMessage(`Imported ${result.importedCount} key(s)`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }],

    ['sqlext.openKafkaTopic', (item: unknown) => {
      if (item instanceof KafkaTopicTreeItem) {
        viewProvider.openKafkaBrowser(item.connectionId, item.topicName);
      }
    }],

    ['sqlext.openRabbitMQQueue', (item: unknown) => {
      if (item instanceof RabbitMQQueueTreeItem) {
        viewProvider.openRabbitMQBrowser(item.connectionId, item.queueName);
      }
    }],

    ['sqlext.openMongoBrowser', (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        viewProvider.openMongoBrowser(item.connectionId, item.connectionName, item.driverType);
      } else if (item instanceof DatabaseTreeItem) {
        const config = connectionManager.getConnections().find(c => c.id === item.connectionId);
        if (config) {
          viewProvider.openMongoBrowser(item.connectionId, config.name, config.driverType);
        }
      }
    }],

    ['sqlext.mongoCreateCollection', async (item: unknown) => {
      if (!(item instanceof MongoDatabaseTreeItem)) { return; }
      const input = await vscode.window.showInputBox({
        prompt: `New collection in "${item.databaseName}"`,
        placeHolder: 'collection_name',
        validateInput: (v) => {
          const t = v.trim();
          if (!t) { return 'Required'; }
          if (/[.$\0]/.test(t)) { return 'Cannot contain . $ or null'; }
          if (t.startsWith('system.')) { return 'Cannot start with system.'; }
          return undefined;
        },
      });
      if (!input) { return; }
      try {
        const driver = connectionManager.getDriver(item.connectionId) as MongoDriver;
        await driver.createCollection(item.databaseName, input.trim());
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to create collection: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }],

    ['sqlext.mongoDropCollection', async (item: unknown) => {
      if (!(item instanceof MongoCollectionTreeItem)) { return; }
      if (item.collectionName.startsWith('system.')) {
        vscode.window.showErrorMessage('Cannot drop system collections');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Drop collection "${item.collectionName}"? This cannot be undone.`,
        { modal: true },
        'Drop'
      );
      if (confirm !== 'Drop') { return; }
      try {
        const driver = connectionManager.getDriver(item.connectionId) as MongoDriver;
        await driver.dropCollection(item.databaseName, item.collectionName);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to drop collection: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }],

    ['sqlext.refreshConnections', () => {
      treeProvider.refresh();
    }],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler)
    );
  }

  // MongoDB 连接成功时自动打开 browser (覆盖 tree 展开触发的连接)
  const previousStates = new Map<string, string>();
  connectionManager.onDidChange(() => {
    for (const info of connectionManager.getConnectionInfo()) {
      const prev = previousStates.get(info.config.id);
      if (prev !== 'connected' && info.state === 'connected' && info.config.driverType === 'mongodb') {
        viewProvider.openMongoBrowser(info.config.id, info.config.name, info.config.driverType);
      }
      previousStates.set(info.config.id, info.state);
    }
  });

  context.subscriptions.push(treeView, connectionManager, viewProvider);
}

export function deactivate(): void {
  // ConnectionManager.dispose() 已通过 subscriptions 自动调用
}
