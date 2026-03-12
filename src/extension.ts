import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionManager } from './services/connection-manager.js';
import { CredentialStore } from './services/credential-store.js';
import { ConnectionTreeProvider } from './providers/connection-tree-provider.js';
import { TableViewProvider } from './providers/table-view-provider.js';
import { ConnectionTreeItem, setResourcesPath } from './providers/tree-items.js';
import { DumpService } from './services/dump-service.js';
import { IpcServer } from './services/ipc-server.js';
import type { DriverType } from './types/connection.js';

function deployMcpServer(extensionPath: string): void {
  try {
    const src = path.join(extensionPath, 'dist', 'mcp-server.js');
    if (!fs.existsSync(src)) { return; }
    const dir = path.join(os.homedir(), '.sql-extension');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, 'mcp-server.js'));
  } catch {
    // 静默失败, 不影响扩展正常使用
  }
}

export function activate(context: vscode.ExtensionContext): void {
  deployMcpServer(context.extensionPath);
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

  function openBrowserForConnection(id: string, name: string, dt: DriverType): void {
    switch (dt) {
      case 'mysql':
      case 'postgresql':
        viewProvider.openDbBrowser(id, name, dt);
        break;
      case 'redis':
        viewProvider.openRedisBrowser(id, 0);
        break;
      case 'kafka':
        viewProvider.openKafkaBrowser(id);
        break;
      case 'rabbitmq':
        viewProvider.openRabbitMQBrowser(id);
        break;
      case 'mongodb':
        viewProvider.openMongoBrowser(id, name, dt);
        break;
    }
  }

  // 启动 IPC server, 让 MCP server 能通过 Unix socket 代理请求
  const ipcServer = new IpcServer(connectionManager);
  ipcServer.start();

  // 注册 TreeView
  const treeView = vscode.window.createTreeView('databaseConnections', {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
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
        // 已连接则直接打开 browser, 不重复连接
        const connInfo = connectionManager.getConnectionInfo().find(c => c.config.id === item.connectionId);
        if (connInfo?.state === 'connected') {
          openBrowserForConnection(item.connectionId, item.connectionName, item.driverType);
          return;
        }
        try {
          await connectionManager.connect(item.connectionId);
          vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
        openBrowserForConnection(item.connectionId, item.connectionName, item.driverType);
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
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (args.connectionId && args.database && args.table) {
        viewProvider.openTableView(args.connectionId, args.database, args.table);
      }
    }],

    ['sqlext.newQuery', (item: unknown) => {
      const args = item as { connectionId?: string; database?: string };
      if (args.connectionId && args.database) {
        const conn = connectionManager.getConnections().find((c) => c.id === args.connectionId);
        if (conn?.driverType === 'mongodb') {
          viewProvider.openMongoQueryEditor(args.connectionId, args.database, conn.name);
        } else {
          viewProvider.openQueryEditor(args.connectionId, args.database);
        }
      }
    }],

    ['sqlext.editConnection', (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        viewProvider.openConnectionForm(item.connectionId);
      }
    }],

    ['sqlext.editTable', (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (args.connectionId && args.database && args.table) {
        viewProvider.openEditTable(args.connectionId, args.database, args.table);
      }
    }],

    ['sqlext.showTableDDL', (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (args.connectionId && args.database && args.table) {
        viewProvider.showTableDDL(args.connectionId, args.database, args.table);
      }
    }],

    ['sqlext.dumpStruct', async (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (!args.connectionId || !args.database || !args.table) { return; }
      const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const uri = await vscode.window.showSaveDialog({
        filters: { 'SQL Files': ['sql'] },
        defaultUri: vscode.Uri.file(`${baseDir}/${args.table}_${ts}.sql`),
      });
      if (!uri) { return; }
      const driver = connectionManager.getDriver(args.connectionId);
      const content = await dumpService.dumpStruct(driver, args.database, args.table);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
      vscode.window.showInformationMessage(`Struct dumped to ${uri.fsPath}`);
    }],

    ['sqlext.dumpStructAndData', async (item: unknown) => {
      const args = item as { connectionId?: string; database?: string; table?: string };
      if (!args.connectionId || !args.database || !args.table) { return; }
      const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const uri = await vscode.window.showSaveDialog({
        filters: { 'SQL Files': ['sql'] },
        defaultUri: vscode.Uri.file(`${baseDir}/${args.table}_${ts}.sql`),
      });
      if (!uri) { return; }
      const driver = connectionManager.getDriver(args.connectionId);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Dumping ${args.table}...`, cancellable: true },
        async (progress, token) => {
          const content = await dumpService.dumpStructAndData(
            driver, args.database!, args.table!,
            (current, total) => { progress.report({ increment: 0, message: `${current}/${total} rows` }); },
            token
          );
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
          vscode.window.showInformationMessage(`Data dumped to ${uri.fsPath}`);
        }
      );
    }],

    ['sqlext.importSql', async (item: unknown) => {
      const args = item as { connectionId?: string; database?: string };
      if (!args.connectionId || !args.database) { return; }
      const uris = await vscode.window.showOpenDialog({
        filters: { 'SQL Files': ['sql'] },
        canSelectMany: false,
      });
      if (!uris || uris.length === 0) { return; }
      const fileContent = await vscode.workspace.fs.readFile(uris[0]);
      const sql = Buffer.from(fileContent).toString('utf-8');
      const driver = connectionManager.getDriver(args.connectionId);
      try {
        const { promise } = driver.executeCancellable(sql, undefined, args.database);
        const result = await promise;
        vscode.window.showInformationMessage(`SQL imported. Affected rows: ${result.affectedRows}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
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

  const previousStates = new Map<string, string>();
  connectionManager.onDidChange(() => {
    for (const info of connectionManager.getConnectionInfo()) {
      const prev = previousStates.get(info.config.id);
      if (prev !== 'connected' && info.state === 'connected') {
        openBrowserForConnection(info.config.id, info.config.name, info.config.driverType);
      }
      previousStates.set(info.config.id, info.state);
    }
  });

  context.subscriptions.push(treeView, connectionManager, viewProvider, { dispose: () => ipcServer.dispose() });
}

export function deactivate(): void {
  // ConnectionManager.dispose() + IpcServer.dispose() 通过 subscriptions 自动调用
}
