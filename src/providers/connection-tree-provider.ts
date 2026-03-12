import * as vscode from 'vscode';
import type { ConnectionManager } from '../services/connection-manager.js';
import { ConnectionTreeItem } from './tree-items.js';

const DRAG_MIME = 'application/vnd.code.tree.databaseConnections';

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionTreeItem>, vscode.TreeDragAndDropController<ConnectionTreeItem> {
  readonly dropMimeTypes = [DRAG_MIME];
  readonly dragMimeTypes = [DRAG_MIME];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ConnectionTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly connectionManager: ConnectionManager) {
    connectionManager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  handleDrag(source: readonly ConnectionTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const connections = source.filter((s) => s instanceof ConnectionTreeItem);
    if (connections.length === 0) { return; }
    dataTransfer.set(
      DRAG_MIME,
      new vscode.DataTransferItem(connections.map((c) => c.connectionId))
    );
  }

  async handleDrop(target: ConnectionTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DRAG_MIME);
    if (!item) { return; }
    const ids = item.value as string[];
    if (!ids || ids.length === 0) { return; }

    const beforeId = target instanceof ConnectionTreeItem ? target.connectionId : null;
    for (const id of ids) {
      await this.connectionManager.reorderConnection(id, beforeId);
    }
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ConnectionTreeItem): Promise<ConnectionTreeItem[]> {
    if (element) {
      return [];
    }
    return this.getRootItems();
  }

  private getRootItems(): ConnectionTreeItem[] {
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
}
