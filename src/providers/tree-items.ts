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
    public readonly state: ConnectionState,
    readOnly = false
  ) {
    super(connectionName, vscode.TreeItemCollapsibleState.None);
    this.id = state === 'connected' ? connectionId : `${connectionId}-${state}`;
    this.contextValue = state === 'connected'
      ? `connection-connected-${driverType}`
      : `connection-${state}`;

    if (state === 'connecting') {
      // 不挂整行 command: 误点一下就会取消慢的 SSH 连接; 取消只走行内 Stop 按钮
      this.description = 'Connecting...';
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    } else {
      this.description = `${host}:${port}`;
      const iconState = state === 'connected' ? 'connected' : 'disconnected';
      this.iconPath = {
        light: vscode.Uri.file(path.join(resourcesPath, `${driverType}-${iconState}-light.svg`)),
        dark: vscode.Uri.file(path.join(resourcesPath, `${driverType}-${iconState}-dark.svg`)),
      };
      this.command = {
        command: 'sqlext.connect',
        title: 'Connect',
        arguments: [this],
      };
    }
    // 只读连接只在描述上标出 (每个 driver 的图标固定 4 个 SVG, 不另加只读图标)
    if (readOnly) {
      this.description += ' (read-only)';
    }
  }
}
