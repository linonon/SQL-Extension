// vscode module mock for unit tests

export class EventEmitter {
  private handlers: Function[] = [];
  event = (handler: Function) => {
    this.handlers.push(handler);
    return { dispose: () => { this.handlers = this.handlers.filter(h => h !== handler); } };
  };
  fire(data?: unknown) {
    for (const h of this.handlers) { h(data); }
  }
  dispose() { this.handlers = []; }
}

export class TreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;

  constructor(label: string, collapsibleState: number = 0) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class Uri {
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(`${base.path}/${parts.join('/')}`);
  }
  constructor(public readonly path: string) {}
  toString() { return this.path; }
}

export const window = {
  createWebviewPanel: () => ({
    webview: {
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: async () => true,
      asWebviewUri: (uri: Uri) => uri,
      cspSource: 'https://test',
    },
    onDidDispose: () => ({ dispose: () => {} }),
    reveal: () => {},
    dispose: () => {},
  }),
  createTreeView: () => ({ dispose: () => {} }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showSaveDialog: async () => undefined,
  showOpenDialog: async () => undefined,
  withProgress: async (_opts: unknown, task: Function) => task({ report: () => {} }, { isCancellationRequested: false }),
};

export enum ProgressLocation {
  Notification = 15,
}

export const commands = {
  registerCommand: (_id: string, _handler: Function) => ({ dispose: () => {} }),
};

export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
    update: async () => {},
  }),
  workspaceFolders: undefined,
  fs: {
    writeFile: async () => {},
    readFile: async () => new Uint8Array(),
  },
};
