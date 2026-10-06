import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionManager } from './services/connection-manager.js';
import { CredentialStore } from './services/credential-store.js';
import { ConnectionTreeProvider } from './providers/connection-tree-provider.js';
import { TableViewProvider } from './providers/table-view-provider.js';
import { ConnectionTreeItem, setResourcesPath } from './providers/tree-items.js';
import { IpcServer, SOCKET_PATH } from './services/ipc-server.js';
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

  function openBrowserForConnection(id: string, name: string, dt: DriverType): void {
    switch (dt) {
      case 'mysql':
      case 'postgresql':
        viewProvider.openDbBrowser(id, name, dt);
        break;
      case 'redis':
        viewProvider.openRedisBrowser(id);
        break;
      case 'kafka':
        viewProvider.openKafkaBrowser(id);
        break;
      case 'rabbitmq':
        // 直接打开官方 management UI; URL 取 driver 实际连的地址 (走 SSH 时为本地隧道端口, 仅连接期间有效)
        void vscode.env.openExternal(vscode.Uri.parse(connectionManager.getRabbitMQDriver(id).managementUrl()));
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
          // connecting 期间被 Cancel 时 connect 静默返回, 不提示也不打开 browser
          if (connectionManager.getState(item.connectionId) !== 'connected') {
            return;
          }
          vscode.window.showInformationMessage(`Connected to ${item.connectionName}`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
        // browser 只由 UI 点击打开, agent 经 IPC 的按需连接不弹
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

    ['sqlext.editConnection', (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        viewProvider.openConnectionForm(item.connectionId);
      }
    }],

    ['sqlext.duplicateConnection', async (item: unknown) => {
      if (item instanceof ConnectionTreeItem) {
        const newId = await connectionManager.duplicateConnection(item.connectionId);
        viewProvider.openConnectionForm(newId);
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

  // 向 Copilot Chat / Agent 注册 MCP server, 用户无需手写 mcp.json; 钉到本窗口的 socket
  const mcpServerPath = path.join(context.extensionPath, 'dist', 'mcp-server.js');
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('sqlext.mcp', {
    provideMcpServerDefinitions: () => [
      new vscode.McpStdioServerDefinition('Database Explorer', process.execPath, [mcpServerPath], { SQLEXT_IPC_SOCK: SOCKET_PATH }, context.extension.packageJSON.version),
    ],
  }));

  context.subscriptions.push(treeView, connectionManager, viewProvider, { dispose: () => ipcServer.dispose() });
}

export function deactivate(): void {
  // ConnectionManager.dispose() + IpcServer.dispose() 通过 subscriptions 自动调用
}
