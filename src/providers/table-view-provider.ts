import * as vscode from 'vscode';
import { newConnectionId, openDriver, writeBlockedReason, type ConnectionManager } from '../services/connection-manager.js';
import { QueryService } from '../services/query-service.js';
import { CredentialStore } from '../services/credential-store.js';
import type { ExtensionMessage, WebviewMessage, ViewType, SaveConnectionConfig, UpdateConnectionConfig } from '../types/messages.js';
import type { ConnectionFormSSH } from '../types/messages.js';
import type { ConnectionConfig, DriverType, SSHTunnelConfig } from '../types/connection.js';
import type { SchemaColumn } from '../types/query.js';
import type { IDatabaseDriver } from '../types/driver.js';
import { handleRedisMessage } from './redis-message-handler.js';
import { handleKafkaMessage } from './kafka-message-handler.js';
import { handleMongoMessage } from './mongo-message-handler.js';
import { getWebviewContent, getWebviewOptions } from './webview-helper.js';
import { handleSqlMessage, type SqlMessageContext } from './sql-message-handler.js';
import { readOnlyRejection } from './read-only-gate.js';
import { cancelAiAsk } from '../services/ai-assist.js';
import { sanitizeErrorMessage } from '../utils/sanitize-error.js';

// 不碰数据库的消息: 连接掉线时不为它们重连
const OFFLINE_MESSAGES: ReadonlySet<WebviewMessage['type']> = new Set([
  'cancelQuery', 'aiCancel', 'aiListModels', 'aiSetModel', 'exportCsv', 'listQueryHistory',
]);

function buildSSHConfig(msg: ConnectionFormSSH): SSHTunnelConfig | undefined {
  if (!msg.sshEnabled) { return undefined; }
  return {
    enabled: true,
    host: msg.sshHost,
    port: msg.sshPort,
    username: msg.sshUsername,
    authType: msg.sshAuthType,
    privateKeyPath: msg.sshAuthType === 'privateKey' ? msg.sshPrivateKeyPath : undefined,
  };
}

export class TableViewProvider implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  // Query panel 可同库多开, key 用递增序号区分
  private queryPanelSeq = 0;
  private readonly pendingCancels = new Map<vscode.WebviewPanel, () => void>();
  private readonly queryService = new QueryService();
  // schema 缓存挂在 driver 实例上, 按库存进行中的 promise: 同时打开的多个 panel 共用一次查询.
  // 每次连接都新建 driver, 断开 / 重连 / 改连接配置后旧缓存随之作废
  private readonly schemaCache = new WeakMap<IDatabaseDriver, Map<string, { schema: Promise<Record<string, SchemaColumn[]>>; ts: number }>>();
  private readonly SCHEMA_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionManager: ConnectionManager,
    private readonly credentialStore: CredentialStore
  ) {}

  private connectionConfig(connectionId: string): ConnectionConfig | undefined {
    return this.connectionManager.getConnections().find((c) => c.id === connectionId);
  }

  // 独立 panel 的标题与 badge 带连接名: 不同环境的同名库 (test / release 的 game) 要能一眼分开
  private connectionName(connectionId: string): string {
    return this.connectionConfig(connectionId)?.name ?? connectionId;
  }

  openQueryEditor(connectionId: string, database: string): void {
    const panelKey = `query:${connectionId}:${database}:${++this.queryPanelSeq}`;
    const driver = this.connectionManager.getDriver(connectionId);
    const connectionName = this.connectionName(connectionId);
    this.createPanel(panelKey, `Query - ${connectionName}/${database}`, 'query', {
      connectionId,
      connectionName,
      database,
      driverType: driver.driverType,
    });
  }

  openEditTable(connectionId: string, database: string, table: string): void {
    const panelKey = `edit-table:${connectionId}:${database}:${table}`;
    const existing = this.panels.get(panelKey);
    if (existing) {
      existing.reveal();
      return;
    }

    const driver = this.connectionManager.getDriver(connectionId);
    this.createPanel(panelKey, `Edit - ${this.connectionName(connectionId)}/${database}.${table}`, 'edit-table', {
      connectionId,
      database,
      table,
      driverType: driver.driverType,
    });
  }

  showTableDDL(connectionId: string, database: string, table: string): void {
    const panelKey = `ddl:${connectionId}:${database}:${table}`;
    const existing = this.panels.get(panelKey);
    if (existing) {
      existing.reveal();
      return;
    }

    const driver = this.connectionManager.getDriver(connectionId);
    driver.getTableDDL(database, table).then((ddl) => {
      const connectionName = this.connectionName(connectionId);
      this.createPanel(panelKey, `DDL - ${connectionName}/${database}.${table}`, 'query', {
        connectionId,
        connectionName,
        database,
        driverType: driver.driverType,
        initialSql: ddl,
        autoExecute: false,
      });
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to get DDL: ${msg}`);
    });
  }

  openConnectionForm(existingId?: string): void {
    const panelKey = `conn-form:${existingId ?? Date.now()}`;
    const existing = this.panels.get(panelKey);
    if (existing) {
      existing.reveal();
      return;
    }

    if (existingId) {
      this.openEditForm(panelKey, existingId);
    } else {
      this.createPanel(panelKey, 'New Connection', 'connection-form', {});
    }
  }

  // 打开时落在连接配置的 DB index 上
  openRedisBrowser(connectionId: string): void {
    const config = this.connectionManager.getConnections().find((c) => c.id === connectionId);
    this.openBrowser(`redis-browser:${connectionId}`, `Redis - ${config?.name ?? connectionId}`, 'redis-browser', {
      connectionId,
      database: Number(config?.database) || 0,
      separator: config?.separator ?? ':',
    });
  }

  openKafkaBrowser(connectionId: string): void {
    this.openBrowser(`kafka:${connectionId}`, `Kafka - ${this.connectionName(connectionId)}`, 'kafka-browser', {
      connectionId,
    });
  }

  openMongoBrowser(connectionId: string, connectionName: string, driverType: string): void {
    const iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'resources', `${driverType}-connected-light.svg`),
      dark: vscode.Uri.joinPath(this.extensionUri, 'resources', `${driverType}-connected-dark.svg`),
    };
    this.openBrowser(`mongo:${connectionId}`, `[MongoDB]${connectionName}`, 'mongo-browser', {
      connectionId,
    }, iconPath);
  }

  openDbBrowser(connectionId: string, connectionName: string, driverType: string): void {
    const iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'resources', `${driverType}-connected-light.svg`),
      dark: vscode.Uri.joinPath(this.extensionUri, 'resources', `${driverType}-connected-dark.svg`),
    };
    // defaultDatabase: 连接表单里填的 Database, 浏览器默认只列这个库
    this.openBrowser(`db-browser:${connectionId}`, `[${driverType.toUpperCase()}]${connectionName}`, 'db-browser', {
      connectionId,
      driverType,
      defaultDatabase: this.connectionConfig(connectionId)?.database || undefined,
    }, iconPath);
  }

  private openBrowser(
    panelKey: string,
    title: string,
    viewType: ViewType,
    context: Record<string, unknown>,
    iconPath?: { light: vscode.Uri; dark: vscode.Uri }
  ): void {
    const existing = this.panels.get(panelKey);
    if (existing) {
      existing.reveal();
      return;
    }
    this.createPanel(panelKey, title, viewType, context, iconPath);
  }

  private async openEditForm(panelKey: string, connectionId: string): Promise<void> {
    const config = this.connectionManager.getConnections().find((c) => c.id === connectionId);
    if (!config) { return; }

    // 已存的密码不进 webview, 只告诉表单有没有; 表单里留空即沿用已存的值
    const hasPassword = !!(await this.credentialStore.getPassword(connectionId));
    const hasSshPassword = !!(await this.credentialStore.getSSHPassword(connectionId));

    this.createPanel(panelKey, 'Edit Connection', 'connection-form', {
      editConnection: {
        id: config.id,
        name: config.name,
        driverType: config.driverType,
        host: config.host,
        port: config.port,
        username: config.username,
        hasPassword,
        database: config.database,
        authSource: config.authSource,
        separator: config.separator ?? ':',
        sshEnabled: config.ssh?.enabled ?? false,
        sshHost: config.ssh?.host ?? '',
        sshPort: config.ssh?.port ?? 22,
        sshUsername: config.ssh?.username ?? '',
        sshAuthType: config.ssh?.authType ?? 'password',
        hasSshPassword,
        sshPrivateKeyPath: config.ssh?.privateKeyPath ?? '',
        readOnly: config.readOnly ?? false,
      },
    });
  }

  private createPanel(
    panelKey: string,
    title: string,
    viewType: ViewType,
    context: Record<string, unknown>,
    iconPath?: { light: vscode.Uri; dark: vscode.Uri }
  ): void {
    // 只读连接: 标题带标记, webview 据 context.readOnly 隐藏写控件 (拦截在 handleMessage)
    const connectionId = context.connectionId as string | undefined;
    const readOnly = connectionId !== undefined && this.connectionConfig(connectionId)?.readOnly === true;
    const viewContext = readOnly ? { ...context, readOnly: true } : context;
    const panel = vscode.window.createWebviewPanel(
      'sqlext.webview',
      readOnly ? `${title} (read-only)` : title,
      vscode.ViewColumn.One,
      getWebviewOptions(this.extensionUri)
    );
    if (iconPath) {
      panel.iconPath = iconPath;
    }

    panel.webview.html = getWebviewContent(panel.webview, this.extensionUri);

    // 每次 ready 都回 viewInit: Developer: Reload Webviews 后页面重新加载, 会再发一次 ready
    const viewInit: ExtensionMessage = { type: 'viewInit', view: viewType, context: viewContext };
    const listener = panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'ready') {
        return panel.webview.postMessage(viewInit);
      }
      return this.handleMessage(panel, message, context);
    });

    panel.onDidDispose(() => {
      listener.dispose();
      // 关 panel 时 webview 直接销毁, 卸载 effect 不跑, 由这里取消仍在执行的查询 (已结束时 cancel 为 no-op)
      this.pendingCancels.get(panel)?.();
      this.pendingCancels.delete(panel);
      this.panels.delete(panelKey);
      cancelAiAsk(panel);
    });

    this.panels.set(panelKey, panel);
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    message: WebviewMessage,
    context: Record<string, unknown>
  ): Promise<void> {
    const connectionId = context.connectionId as string | undefined;
    const post = (msg: ExtensionMessage) => panel.webview.postMessage(msg);

    // 只读连接的写消息统一在这里拒绝 (每条消息现读配置): 宿主是边界, webview 只是隐藏写控件
    const blocked = connectionId ? writeBlockedReason(this.connectionConfig(connectionId)) : undefined;
    const rejection = blocked ? readOnlyRejection(message, blocked) : undefined;
    if (rejection !== undefined) {
      // 命令栏的拒绝写在命令输出里, 其余弹提示
      if (rejection?.type !== 'redisCommandResult') { void vscode.window.showErrorMessage(blocked!); }
      if (rejection) { post(rejection); }
      return;
    }

    // panel 的连接被心跳拆掉 (睡眠 / VPN) 或因 Edit Connection 断开后, 下一条消息先按需重连再处理;
    // 只连接, 不打开 browser (browser 只由 UI 的 connect 命令打开)
    if (connectionId && !OFFLINE_MESSAGES.has(message.type) && this.connectionManager.getState(connectionId) !== 'connected') {
      try {
        await this.connectionManager.connect(connectionId);
      } catch (err) {
        post({ type: 'error', message: `Failed to connect: ${sanitizeErrorMessage(err)}` });
        return;
      }
    }

    // SQL (MySQL/PostgreSQL) CRUD + db-browser 导航 + dump/import 由 sql-message-handler 处理
    const sqlCtx: SqlMessageContext = {
      getDriver: () => this.connectionManager.getDriver(connectionId!),
      queryService: this.queryService,
      post,
      panel,
      pendingCancels: this.pendingCancels,
      database: context.database as string | undefined,
      getSchema: (database, forceRefresh) => this.getCachedSchema(connectionId!, database, forceRefresh),
      readOnly: blocked !== undefined,
      queryHistory: {
        list: () => this.connectionManager.getQueryHistory(connectionId!),
        add: (entry) => this.connectionManager.addQueryHistory(connectionId!, entry),
      },
    };
    if (await handleSqlMessage(message, sqlCtx)) { return; }

    try {
      switch (message.type) {
        case 'testConnection': {
          // 编辑表单的 panel context 带被编辑连接的 id: 表单里留空的密码用它的已存值
          await this.testConnection(post, message.config, (context.editConnection as { id: string } | undefined)?.id);
          break;
        }

        case 'saveConnection': {
          await this.saveConnection(panel, message.config);
          break;
        }

        case 'updateConnection': {
          // 被改的连接只认编辑表单 panel 的 context, 不信消息里的 id: 其他 panel 不能把已存密码指向别的 host
          const editId = (context.editConnection as { id: string } | undefined)?.id;
          if (editId) { await this.updateExistingConnection(panel, editId, message.config); }
          break;
        }

        default: {
          if (message.type === 'showTableDDL') {
            const { database, table } = message as { database: string; table: string };
            this.showTableDDL(connectionId!, database, table);
            return;
          }

          if (message.type === 'editTable') {
            const { database, table } = message as { database: string; table: string };
            this.openEditTable(connectionId!, database, table);
            return;
          }

          if (message.type === 'newQuery') {
            const { database } = message as { database: string };
            this.openQueryEditor(connectionId!, database);
            return;
          }

          if (message.type.startsWith('kafka')) {
            await handleKafkaMessage(message, this.connectionManager.getKafkaDriver(connectionId!), post);
            return;
          }

          if (message.type.startsWith('mongo')) {
            await handleMongoMessage(message, this.connectionManager.getMongoDriver(connectionId!), post);
            return;
          }

          if (message.type.startsWith('redis')) {
            await handleRedisMessage(message, this.connectionManager.getRedisDriver(connectionId!), post);
            return;
          }
          break;
        }
      }
    } catch (err) {
      // 脱敏: 过滤可能包含凭证的 URL 格式错误消息 (单一实现见 utils/sanitize-error)
      // (SQL 路径的特定回执 queryResult/batchUpdateResult 已在 sql-message-handler 内自管)
      post({ type: 'error', message: sanitizeErrorMessage(err) });
    }
  }

  // 库结构 (表名 -> 列) 读取 + 缓存, 供自动补全与 Ask AI; forceRefresh 对应 Refresh Schema. 查询失败不缓存
  private getCachedSchema(
    connectionId: string,
    database: string,
    forceRefresh: boolean
  ): Promise<Record<string, SchemaColumn[]>> {
    const driver = this.connectionManager.getDriver(connectionId);
    const byDatabase = this.schemaCache.get(driver) ?? new Map();
    this.schemaCache.set(driver, byDatabase);
    const cached = byDatabase.get(database);
    if (cached && !forceRefresh && Date.now() - cached.ts < this.SCHEMA_CACHE_TTL) {
      return cached.schema;
    }
    const entry = { schema: fetchSchema(driver, database), ts: Date.now() };
    byDatabase.set(database, entry);
    entry.schema.catch(() => { if (byDatabase.get(database) === entry) { byDatabase.delete(database); } });
    return entry.schema;
  }

  private async testConnection(
    post: (msg: ExtensionMessage) => void,
    config: { driverType: DriverType; host: string; port: number; username: string; password: string; database: string; authSource?: string } & ConnectionFormSSH,
    editId?: string
  ): Promise<void> {
    let { password, sshPassword } = config;
    if (editId) {
      if (!password) { password = (await this.credentialStore.getPassword(editId)) ?? ''; }
      if (!sshPassword) { sshPassword = (await this.credentialStore.getSSHPassword(editId)) ?? ''; }
    }

    try {
      const handle = await openDriver({
        id: '__test__',
        name: '__test__',
        driverType: config.driverType,
        host: config.host,
        port: config.port,
        username: config.username,
        database: config.database,
        authSource: config.authSource,
        ssh: buildSSHConfig(config),
      }, password, sshPassword);
      await handle.close();
      post({ type: 'connectionTestResult', success: true });
    } catch (err) {
      post({ type: 'connectionTestResult', success: false, error: sanitizeErrorMessage(err) });
    }
  }

  private async saveConnection(
    panel: vscode.WebviewPanel,
    config: SaveConnectionConfig
  ): Promise<void> {
    await this.connectionManager.addConnection(
      {
        id: newConnectionId(config),
        name: config.name,
        driverType: config.driverType,
        host: config.host,
        port: config.port,
        username: config.username,
        database: config.database,
        authSource: config.authSource,
        separator: config.separator,
        ssh: buildSSHConfig(config),
        readOnly: config.readOnly,
      },
      config.password,
      config.sshEnabled ? config.sshPassword : undefined
    );
    panel.dispose();
    vscode.window.showInformationMessage(`Connection "${config.name}" saved`);
  }

  private async updateExistingConnection(
    panel: vscode.WebviewPanel,
    id: string,
    config: UpdateConnectionConfig
  ): Promise<void> {
    const readOnlyChanged = (this.connectionConfig(id)?.readOnly ?? false) !== (config.readOnly ?? false);
    await this.connectionManager.updateConnection(
      id,
      {
        id,
        name: config.name,
        driverType: config.driverType,
        host: config.host,
        port: config.port,
        username: config.username,
        database: config.database,
        authSource: config.authSource,
        separator: config.separator,
        ssh: buildSSHConfig(config),
        readOnly: config.readOnly,
      },
      // 空串 = 表单没改, 保留已存的值; 关掉 SSH 时 updateConnection 删掉已存的 SSH 密码
      config.password || undefined,
      config.sshPassword || undefined
    );
    panel.dispose();
    if (readOnlyChanged) { this.disposeConnectionPanels(id); }
    vscode.window.showInformationMessage(`Connection "${config.name}" updated`);
  }

  // 只读标题与 webview 的写控件在建 panel 时定下, 切换只读后关掉该连接已开的 panel, 重开时按新配置生成.
  // panel key 形如 `<kind>:<connectionId>` 或 `<kind>:<connectionId>:...`
  private disposeConnectionPanels(connectionId: string): void {
    for (const [key, panel] of [...this.panels]) {
      const rest = key.slice(key.indexOf(':') + 1);
      if (rest === connectionId || rest.startsWith(`${connectionId}:`)) { panel.dispose(); }
    }
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

// 一条 information_schema 查询取完整个库的列, 按表分组 (保持表内顺序)
async function fetchSchema(driver: IDatabaseDriver, database: string): Promise<Record<string, SchemaColumn[]>> {
  const schema: Record<string, SchemaColumn[]> = {};
  for (const col of await driver.listSchemaColumns(database)) {
    (schema[col.table] ??= []).push(col);
  }
  return schema;
}
