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
    super(connectionName, vscode.TreeItemCollapsibleState.None);
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
      this.command = {
        command: 'sqlext.connect',
        title: 'Connect',
        arguments: [this],
      };
    }
  }
}
