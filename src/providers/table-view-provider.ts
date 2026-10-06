import * as vscode from 'vscode';
import { newConnectionId, type ConnectionManager } from '../services/connection-manager.js';
import { QueryService } from '../services/query-service.js';
import { CredentialStore } from '../services/credential-store.js';
import { createTunnel } from '../services/ssh-tunnel.js';
import type { WebviewMessage, ViewType, SaveConnectionConfig, UpdateConnectionConfig } from '../types/messages.js';
import type { ConnectionFormSSH } from '../types/messages.js';
import type { DriverType, SSHTunnelConfig } from '../types/connection.js';
import type { AlterTableChanges } from '../types/query.js';
import { handleRedisMessage, exportRedisKeys, importRedisKeys, validateTtlInput, parseCommandArgs } from './redis-message-handler.js';
import { handleKafkaMessage } from './kafka-message-handler.js';
import { handleMongoMessage, buildExportPipeline } from './mongo-message-handler.js';
import { getWebviewContent, getWebviewOptions } from './webview-helper.js';
import { handleSqlMessage, type SqlMessageContext } from './sql-message-handler.js';
import { cancelAiAsk } from '../services/ai-assist.js';
import { sanitizeErrorMessage } from '../utils/sanitize-error.js';

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
  private readonly pendingCancels = new Map<vscode.WebviewPanel, () => void>();
  private readonly queryService = new QueryService();
  private readonly disposables: vscode.Disposable[] = [];
  // schema 缓存: key = "connectionId:database"
  private readonly schemaCache = new Map<string, { schema: Record<string, string[]>; ts: number }>();
  private readonly SCHEMA_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionManager: ConnectionManager,
    private readonly credentialStore: CredentialStore
  ) {}

  // 独立 panel 的标题与 badge 带连接名: 不同环境的同名库 (test / release 的 game) 要能一眼分开
  private connectionName(connectionId: string): string {
    return this.connectionManager.getConnections().find((c) => c.id === connectionId)?.name ?? connectionId;
  }

  openQueryEditor(connectionId: string, database: string): void {
    const panelKey = `query:${connectionId}:${database}:${Date.now()}`;
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
    this.openBrowser(`kafka:${connectionId}`, 'Kafka Browser', 'kafka-browser', {
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
    this.openBrowser(`db-browser:${connectionId}`, `[${driverType.toUpperCase()}]${connectionName}`, 'db-browser', {
      connectionId,
      driverType,
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

    const password = (await this.credentialStore.getPassword(connectionId)) ?? '';
    const sshPassword = (await this.credentialStore.getSSHPassword(connectionId)) ?? '';

    this.createPanel(panelKey, 'Edit Connection', 'connection-form', {
      editConnection: {
        id: config.id,
        name: config.name,
        driverType: config.driverType,
        host: config.host,
        port: config.port,
        username: config.username,
        password,
        database: config.database,
        authSource: config.authSource,
        separator: config.separator ?? ':',
        sshEnabled: config.ssh?.enabled ?? false,
        sshHost: config.ssh?.host ?? '',
        sshPort: config.ssh?.port ?? 22,
        sshUsername: config.ssh?.username ?? '',
        sshAuthType: config.ssh?.authType ?? 'password',
        sshPassword,
        sshPrivateKeyPath: config.ssh?.privateKeyPath ?? '',
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
    const panel = vscode.window.createWebviewPanel(
      'sqlext.webview',
      title,
      vscode.ViewColumn.One,
      getWebviewOptions(this.extensionUri)
    );
    if (iconPath) {
      panel.iconPath = iconPath;
    }

    panel.webview.html = getWebviewContent(panel.webview, this.extensionUri);

    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(panel, message, context),
      undefined,
      this.disposables
    );

    panel.onDidDispose(() => {
      // 关 panel 时 webview 直接销毁, 卸载 effect 不跑, 由这里取消仍在执行的查询 (已结束时 cancel 为 no-op)
      this.pendingCancels.get(panel)?.();
      this.pendingCancels.delete(panel);
      this.panels.delete(panelKey);
      cancelAiAsk(panel);
    });

    this.panels.set(panelKey, panel);

    // webview ready 后发送初始化消息
    const readyHandler = panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg.type === 'ready') {
        panel.webview.postMessage({ type: 'viewInit', view: viewType, context });
        readyHandler.dispose();
      }
    });
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    message: WebviewMessage,
    context: Record<string, unknown>
  ): Promise<void> {
    const connectionId = context.connectionId as string | undefined;

    // SQL (MySQL/PostgreSQL) CRUD + db-browser 导航 + dump/import 由 sql-message-handler 处理
    const sqlCtx: SqlMessageContext = {
      getDriver: () => this.connectionManager.getDriver(connectionId!),
      queryService: this.queryService,
      post: (msg) => panel.webview.postMessage(msg),
      panel,
      pendingCancels: this.pendingCancels,
      database: context.database as string | undefined,
      getSchema: (database, forceRefresh) => this.getCachedSchema(connectionId!, database, forceRefresh),
    };
    if (await handleSqlMessage(message, sqlCtx)) { return; }

    try {
      switch (message.type) {
        case 'testConnection': {
          await this.testConnection(panel, message.config);
          break;
        }

        case 'saveConnection': {
          await this.saveConnection(panel, message.config);
          break;
        }

        case 'updateConnection': {
          await this.updateExistingConnection(panel, message.config);
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
            const kafkaDriver = this.connectionManager.getKafkaDriver(connectionId!);
            const post = (msg: unknown) => panel.webview.postMessage(msg);
            await handleKafkaMessage(message, kafkaDriver, post);
            return;
          }

          if (message.type.startsWith('mongo')) {
            const mongoDriver = this.connectionManager.getMongoDriver(connectionId!);
            if (message.type === 'mongoCreateCollection') {
              const { database } = message as { database: string; collection: string };
              const input = await vscode.window.showInputBox({
                prompt: `New collection in "${database}"`,
                placeHolder: 'collection_name',
                validateInput: (v) => {
                  if (!v.trim()) { return 'Collection name is required'; }
                  if (/[.$]/.test(v)) { return 'Cannot contain . or $'; }
                  return undefined;
                },
              });
              if (!input) { return; }
              const post = (msg: unknown) => panel.webview.postMessage(msg);
              await handleMongoMessage({ ...message, collection: input.trim() } as WebviewMessage, mongoDriver, post);
              return;
            }

            if (message.type === 'mongoDropCollection') {
              const { collection } = message as { database: string; collection: string };
              const confirm = await vscode.window.showWarningMessage(
                `Drop collection "${collection}"? This cannot be undone.`,
                { modal: true },
                'Drop'
              );
              if (confirm !== 'Drop') { return; }
              // fall through to handleMongoMessage
            }

            if (message.type === 'mongoDeleteDocument') {
              // 点名库 / 集合 / _id: 删的是这条消息里的目标, 让用户能核对它是否就是界面上看到的那条
              const { database, collection, id } = message;
              const confirmDelete = await vscode.window.showWarningMessage(
                `Delete document ${JSON.stringify(id)} from ${database}.${collection}?`, { modal: true }, 'Delete'
              );
              if (confirmDelete !== 'Delete') { return; }
            }

            if (message.type === 'mongoExportCollection') {
              const exportMsg = message as { database: string; collection: string; filter: string; sort: string; projection?: string };
              const post = (msg: unknown) => panel.webview.postMessage(msg);
              try {
                const uri = await vscode.window.showSaveDialog({
                  filters: { 'JSON Files': ['json'], 'JSONL Files': ['jsonl'] },
                  defaultUri: vscode.Uri.file(`${exportMsg.collection}.json`),
                });
                if (!uri) { return; }
                const pipeline = buildExportPipeline(exportMsg.filter, exportMsg.sort, exportMsg.projection);
                const jsonl = uri.path.toLowerCase().endsWith('.jsonl');
                const { json, count } = await mongoDriver.exportDocuments(exportMsg.database, exportMsg.collection, pipeline, jsonl);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
                vscode.window.showInformationMessage(`Exported ${count} document(s) to ${uri.fsPath}`);
                post({ type: 'mongoExportResult', success: true, count });
              } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Export failed: ${errMsg}`);
                panel.webview.postMessage({ type: 'mongoExportResult', success: false, error: errMsg });
              }
              return;
            }

            if (message.type === 'mongoImportCollection') {
              const importMsg = message as { database: string; collection: string };
              const post = (msg: unknown) => panel.webview.postMessage(msg);
              try {
                const fileUris = await vscode.window.showOpenDialog({
                  filters: { 'JSON/JSONL Files': ['json', 'jsonl'] },
                  canSelectMany: false,
                });
                if (!fileUris || fileUris.length === 0) { return; }
                const content = Buffer.from(await vscode.workspace.fs.readFile(fileUris[0])).toString('utf-8');
                const lineCount = content.trim().startsWith('[')
                  ? (JSON.parse(content.trim()) as unknown[]).length
                  : content.trim().split('\n').filter((l) => l.trim()).length;
                const confirm = await vscode.window.showWarningMessage(
                  `Import will insert ${lineCount} document(s) into "${importMsg.collection}". Continue?`,
                  { modal: true },
                  'Insert'
                );
                if (confirm !== 'Insert') { return; }
                const inserted = await mongoDriver.importDocuments(importMsg.database, importMsg.collection, content);
                vscode.window.showInformationMessage(`Imported ${inserted} document(s) into "${importMsg.collection}"`);
                post({ type: 'mongoImportResult', success: true, inserted });
              } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Import failed: ${errMsg}`);
                panel.webview.postMessage({ type: 'mongoImportResult', success: false, error: errMsg });
              }
              return;
            }

            // 文档写操作的结果在宿主侧提示 (webview sandbox 里 alert 不弹), 回执照常发给 webview
            const post = (msg: unknown) => {
              const m = msg as { type?: string; success?: boolean; error?: string; message?: string };
              if (m.type === 'mongoOperationResult') {
                if (!m.success) { void vscode.window.showErrorMessage(`MongoDB: ${m.error ?? 'operation failed'}`); }
                else if (m.message) { void vscode.window.showInformationMessage(m.message); }
              }
              return panel.webview.postMessage(msg);
            };
            await handleMongoMessage(message, mongoDriver, post);
            return;
          }

          if (message.type.startsWith('redis')) {
            const redisDriver = this.connectionManager.getRedisDriver(connectionId!);
            const post = (msg: unknown) => panel.webview.postMessage(msg);

            if (message.type === 'redisExportPattern' || message.type === 'redisExportKey') {
              const { database } = message;
              const target = message.type === 'redisExportKey' ? { key: message.key } : { pattern: message.pattern };
              try {
                const uri = await vscode.window.showSaveDialog({
                  filters: { 'JSON Files': ['json'] },
                  defaultUri: vscode.Uri.file(`redis-export-db${database}.json`),
                });
                if (!uri) { return; }
                const result = await vscode.window.withProgress(
                  { location: vscode.ProgressLocation.Notification, title: `Exporting Redis db ${database}`, cancellable: true },
                  (progress, token) => exportRedisKeys(redisDriver, database, target, (done, total) => {
                    if (token.isCancellationRequested) { throw new Error('Export cancelled'); }
                    if (done % 100 === 0 || done === total) { progress.report({ message: `${done}/${total} keys` }); }
                  })
                );
                await vscode.workspace.fs.writeFile(uri, Buffer.from(result.json, 'utf-8'));
                const summary = `Exported ${result.keyCount} key(s) from db ${database} to ${uri.fsPath}`;
                if (result.skipped) {
                  vscode.window.showWarningMessage(`${summary}; ${result.skipped}`);
                } else {
                  vscode.window.showInformationMessage(summary);
                }
                if (result.errors.length > 0) {
                  vscode.window.showWarningMessage(`Export completed with errors: ${result.errors.join('; ')}`);
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Export failed: ${msg}`);
              }
              return;
            }

            if (message.type === 'redisImport') {
              const { database } = message;
              try {
                const fileUris = await vscode.window.showOpenDialog({
                  filters: { 'JSON Files': ['json'] },
                  canSelectMany: false,
                });
                if (!fileUris || fileUris.length === 0) { return; }
                const content = Buffer.from(await vscode.workspace.fs.readFile(fileUris[0])).toString('utf-8');
                // 导入会先删后写同名 key: 有已存在的就在这里确认
                const result = await importRedisKeys(redisDriver, database, content, async (existing) => {
                  const confirm = await vscode.window.showWarningMessage(
                    `${existing} key(s) already exist in db ${database} and will be replaced. Continue?`,
                    { modal: true },
                    'Replace'
                  );
                  return confirm === 'Replace';
                });
                if (!result) { return; }
                if (result.errors.length > 0) {
                  vscode.window.showWarningMessage(`Import completed with errors: ${result.errors.join('; ')}`);
                }
                vscode.window.showInformationMessage(`Imported ${result.importedCount} key(s) into db ${database}`);
                post({ type: 'redisImportResult', success: true, importedCount: result.importedCount });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Import failed: ${msg}`);
                post({ type: 'redisImportResult', success: false, error: msg });
              }
              return;
            }

            if (message.type === 'redisAddKeyPrompt') {
              const addMsg = message as { database: number };
              const key = await vscode.window.showInputBox({
                prompt: 'Enter new key name',
                placeHolder: 'e.g. user:1234',
                validateInput: (v) => v.trim() ? undefined : 'Key name is required',
              });
              const name = key?.trim();
              if (!name) { return; }
              if (!(await redisDriver.createStringKey(addMsg.database, name))) {
                vscode.window.showErrorMessage(`Key already exists: ${name}`);
                return;
              }
              post({ type: 'redisAddKeyResult', key: name });
              return;
            }

            if (message.type === 'redisSetTTLPrompt') {
              const ttlMsg = message as { key: string; database: number };
              const input = await vscode.window.showInputBox({
                prompt: 'Enter TTL in seconds (-1 to remove)',
                validateInput: validateTtlInput,
              });
              if (input === undefined) { return; }
              const ttl = Number(input);
              if (ttl === -1) {
                await handleRedisMessage({ type: 'redisRemoveTTL', key: ttlMsg.key, database: ttlMsg.database }, redisDriver, post);
              } else {
                await handleRedisMessage({ type: 'redisSetTTL', key: ttlMsg.key, ttl, database: ttlMsg.database }, redisDriver, post);
              }
              return;
            }

            if (message.type === 'redisExecuteCommand') {
              // 命令栏可执行任意命令; 清库命令 (带不带 ASYNC / SYNC 参数) 先确认
              const cmd = parseCommandArgs(message.command)[0]?.toUpperCase();
              if (cmd === 'FLUSHDB' || cmd === 'FLUSHALL') {
                const scope = cmd === 'FLUSHALL' ? 'EVERY database' : `db ${message.database}`;
                const confirm = await vscode.window.showWarningMessage(
                  `${cmd} deletes all keys in ${scope}. Continue?`, { modal: true }, cmd
                );
                if (confirm !== cmd) {
                  post({ type: 'redisCommandResult', output: `${cmd} cancelled` });
                  return;
                }
              }
            }

            if (message.type === 'redisDeleteKeys') {
              const keyList = message.keys;
              const label = keyList.length === 1
                ? `Delete key "${keyList[0]}"?`
                : `Delete ${keyList.length} keys?`;
              const confirm = await vscode.window.showWarningMessage(label, { modal: true }, 'Delete');
              if (confirm !== 'Delete') { return; }
            }

            if (message.type === 'redisHashDelete') {
              const field = (message as { field: string }).field;
              const confirm = await vscode.window.showWarningMessage(
                `Delete field "${field}"?`, { modal: true }, 'Delete'
              );
              if (confirm !== 'Delete') { return; }
            }

            if (message.type === 'redisSetRemove') {
              const member = (message as { member: string }).member;
              const confirm = await vscode.window.showWarningMessage(
                `Remove member "${member}"?`, { modal: true }, 'Delete'
              );
              if (confirm !== 'Delete') { return; }
            }

            if (message.type === 'redisListRemove') {
              const idx = (message as { index: number }).index;
              const confirm = await vscode.window.showWarningMessage(
                `Delete list item at index ${idx}?`,
                { modal: true }, 'Delete'
              );
              if (confirm !== 'Delete') { return; }
            }

            if (message.type === 'redisZSetRemove') {
              const member = (message as { member: string }).member;
              const confirm = await vscode.window.showWarningMessage(
                `Remove member "${member}"?`, { modal: true }, 'Delete'
              );
              if (confirm !== 'Delete') { return; }
            }

            await handleRedisMessage(message, redisDriver, post);
            return;
          }
          break;
        }
      }
    } catch (err) {
      // 脱敏: 过滤可能包含凭证的 URL 格式错误消息 (单一实现见 utils/sanitize-error)
      // (SQL 路径的特定回执 queryResult/batchUpdateResult 已在 sql-message-handler 内自管)
      panel.webview.postMessage({ type: 'error', message: sanitizeErrorMessage(err) });
    }
  }

  // schema 读取 + 缓存 (供 sql-message-handler 的 requestSchema/refreshSchema 调用)
  private async getCachedSchema(
    connectionId: string,
    database: string,
    forceRefresh: boolean
  ): Promise<Record<string, string[]>> {
    const key = `${connectionId}:${database}`;
    if (forceRefresh) {
      this.schemaCache.delete(key);
    }
    const cached = this.schemaCache.get(key);
    if (cached && Date.now() - cached.ts < this.SCHEMA_CACHE_TTL) {
      return cached.schema;
    }
    const schema = await this.fetchSchema(connectionId, database);
    this.schemaCache.set(key, { schema, ts: Date.now() });
    return schema;
  }

  private async fetchSchema(connectionId: string, database: string): Promise<Record<string, string[]>> {
    const driver = this.connectionManager.getDriver(connectionId);
    const tables = await driver.listTables(database);
    const schema: Record<string, string[]> = {};
    // 并行获取列信息, 每批 10 个避免连接池压力
    const CHUNK_SIZE = 10;
    for (let i = 0; i < tables.length; i += CHUNK_SIZE) {
      const chunk = tables.slice(i, i + CHUNK_SIZE);
      const results = await Promise.all(
        chunk.map((t) => driver.listColumns(database, t.name))
      );
      for (let j = 0; j < chunk.length; j++) {
        schema[chunk[j].name] = results[j].map((c) => c.name);
      }
    }
    return schema;
  }

  private async testConnection(
    panel: vscode.WebviewPanel,
    config: { driverType: DriverType; host: string; port: number; username: string; password: string; database: string; authSource?: string } & ConnectionFormSSH
  ): Promise<void> {
    type TestableDriver = { connect(config: import('../types/connection.js').ConnectionConfig & { readonly password: string }): Promise<void>; disconnect(): Promise<void> };
    const DRIVER_FACTORIES: Record<string, () => Promise<TestableDriver>> = {
      mysql: async () => { const { MySQLDriver } = await import('../drivers/mysql-driver.js'); return new MySQLDriver(); },
      postgresql: async () => { const { PgDriver } = await import('../drivers/pg-driver.js'); return new PgDriver(); },
      redis: async () => { const { RedisDriver } = await import('../drivers/redis-driver.js'); return new RedisDriver(); },
      kafka: async () => { const { KafkaDriver } = await import('../drivers/kafka-driver.js'); return new KafkaDriver(); },
      mongodb: async () => { const { MongoDriver } = await import('../drivers/mongo-driver.js'); return new MongoDriver(); },
      rabbitmq: async () => { const { RabbitMQDriver } = await import('../drivers/rabbitmq-driver.js'); return new RabbitMQDriver(); },
    };
    const factory = DRIVER_FACTORIES[config.driverType];
    if (!factory) { throw new Error(`Unsupported driver type: ${config.driverType}`); }
    const driver = await factory();
    let tunnelClose: (() => void) | undefined;

    try {
      let connectHost = config.host;
      let connectPort = config.port;

      if (config.sshEnabled) {
        const sshConfig = buildSSHConfig(config)!;
        const tunnel = await createTunnel(sshConfig, config.sshPassword, config.host, config.port);
        tunnelClose = tunnel.close;
        connectHost = '127.0.0.1';
        connectPort = tunnel.localPort;
      }

      await driver.connect({
        id: '__test__',
        name: '__test__',
        driverType: config.driverType,
        host: connectHost,
        port: connectPort,
        username: config.username,
        password: config.password,
        database: config.database,
        authSource: config.authSource,
        // driver 据此判断是否走 tunnel (如 Mongo 需 directConnection)
        ssh: buildSSHConfig(config),
      });
      await driver.disconnect();
      panel.webview.postMessage({ type: 'connectionTestResult', success: true });
    } catch (err) {
      panel.webview.postMessage({
        type: 'connectionTestResult',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (tunnelClose) { tunnelClose(); }
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
      },
      config.password,
      config.sshEnabled ? config.sshPassword : undefined
    );
    panel.dispose();
    vscode.window.showInformationMessage(`Connection "${config.name}" saved`);
  }

  private async updateExistingConnection(
    panel: vscode.WebviewPanel,
    config: UpdateConnectionConfig
  ): Promise<void> {
    await this.connectionManager.updateConnection(
      config.id,
      {
        id: config.id,
        name: config.name,
        driverType: config.driverType,
        host: config.host,
        port: config.port,
        username: config.username,
        database: config.database,
        authSource: config.authSource,
        separator: config.separator,
        ssh: buildSSHConfig(config),
      },
      config.password,
      config.sshEnabled ? config.sshPassword : undefined
    );
    panel.dispose();
    vscode.window.showInformationMessage(`Connection "${config.name}" updated`);
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.schemaCache.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
