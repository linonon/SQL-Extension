import * as vscode from 'vscode';
import type { ConnectionManager } from '../services/connection-manager.js';
import { QueryService } from '../services/query-service.js';
import { CredentialStore } from '../services/credential-store.js';
// driver 按需动态加载, 避免 main bundle 包含所有 driver 依赖
import type { MongoDriver } from '../drivers/mongo-driver.js';
import { createTunnel } from '../services/ssh-tunnel.js';
import type { WebviewMessage, ViewType, SaveConnectionConfig, UpdateConnectionConfig } from '../types/messages.js';
import type { ConnectionFormSSH } from '../types/messages.js';
import type { DriverType, SSHTunnelConfig } from '../types/connection.js';
import type { AlterTableChanges } from '../types/query.js';
import { handleRedisMessage, exportRedisKeys, importRedisKeys } from './redis-message-handler.js';
import { handleKafkaMessage } from './kafka-message-handler.js';
import { handleRabbitMQMessage } from './rabbitmq-message-handler.js';
import { handleMongoMessage, buildExportPipeline } from './mongo-message-handler.js';
import { getWebviewContent, getWebviewOptions } from './webview-helper.js';
import { buildDefaultSelectSql, buildBatchDelete } from '../utils/sql-builder.js';
import { buildAlterTableStatements } from '../utils/alter-table-builder.js';

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

  openTableView(connectionId: string, database: string, table: string): void {
    const panelKey = `table:${connectionId}:${database}:${table}`;
    const existing = this.panels.get(panelKey);
    if (existing) {
      existing.reveal();
      return;
    }

    const driver = this.connectionManager.getDriver(connectionId);
    const initialSql = buildDefaultSelectSql(driver.driverType, table);

    this.createPanel(panelKey, `${table} - ${database}`, 'query', {
      connectionId,
      database,
      table,
      initialSql,
      autoExecute: true,
      driverType: driver.driverType,
    });
  }

  openQueryEditor(connectionId: string, database: string): void {
    const panelKey = `query:${connectionId}:${database}:${Date.now()}`;
    const driver = this.connectionManager.getDriver(connectionId);
    this.createPanel(panelKey, `Query - ${database}`, 'query', {
      connectionId,
      database,
      driverType: driver.driverType,
    });
  }

  openMongoQueryEditor(connectionId: string, database: string, connectionName: string): void {
    const panelKey = `mongo-query:${connectionId}:${database}:${Date.now()}`;
    this.createPanel(panelKey, `Query - ${connectionName}/${database}`, 'mongo-query', {
      connectionId,
      database,
      connectionName,
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
    this.createPanel(panelKey, `Edit - ${table}`, 'edit-table', {
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
      this.createPanel(panelKey, `DDL - ${table}`, 'query', {
        connectionId,
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

  openRedisBrowser(connectionId: string, database: number): void {
    const config = this.connectionManager.getConnections().find((c) => c.id === connectionId);
    this.openBrowser(`redis-browser:${connectionId}`, `Redis - ${config?.name ?? connectionId}`, 'redis-browser', {
      connectionId,
      database,
      separator: config?.separator ?? ':',
    });
  }

  openKafkaBrowser(connectionId: string, topic?: string): void {
    this.openBrowser(`kafka:${connectionId}`, 'Kafka Browser', 'kafka-browser', {
      connectionId,
      topic,
    });
  }

  openRabbitMQBrowser(connectionId: string, queue?: string): void {
    this.openBrowser(`rabbitmq:${connectionId}`, 'RabbitMQ Browser', 'rmq-browser', {
      connectionId,
      queue,
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
      this.pendingCancels.delete(panel);
      this.panels.delete(panelKey);
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

    try {
      switch (message.type) {
        case 'fetchRows': {
          const driver = this.connectionManager.getDriver(connectionId!);
          const result = await this.queryService.fetchRows(
            driver,
            message.database,
            message.table,
            message.offset,
            message.limit
          );
          panel.webview.postMessage({
            type: 'tableData',
            columns: result.columns,
            rows: result.rows,
            total: result.total,
            offset: result.page.offset,
            limit: result.page.limit,
          });
          break;
        }

        case 'insertRow': {
          try {
            const driver = this.connectionManager.getDriver(connectionId!);
            await this.queryService.insertRow(driver, message.database, message.table, message.row);
            panel.webview.postMessage({ type: 'insertRowResult', success: true });
          } catch (err) {
            panel.webview.postMessage({
              type: 'insertRowResult',
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'updateRow': {
          const driver = this.connectionManager.getDriver(connectionId!);
          await this.queryService.updateRow(
            driver,
            message.database,
            message.table,
            message.primaryKeys,
            message.changes
          );
          break;
        }

        case 'deleteRows': {
          const count = message.primaryKeys.length;
          const confirmDelete = await vscode.window.showWarningMessage(
            `Delete ${count} row(s)?`, { modal: true }, 'Delete'
          );
          if (confirmDelete !== 'Delete') { break; }
          const driver = this.connectionManager.getDriver(connectionId!);
          const batchQuery = buildBatchDelete(driver.driverType, message.table, message.primaryKeys, message.database);
          if (batchQuery.sql) {
            await driver.execute(batchQuery.sql, batchQuery.params);
          }
          break;
        }

        case 'listColumns': {
          const driver = this.connectionManager.getDriver(connectionId!);
          const cols = await driver.listColumns(message.database, message.table);
          panel.webview.postMessage({ type: 'columnsResult', columns: cols });
          break;
        }

        case 'batchUpdate': {
          const driver = this.connectionManager.getDriver(connectionId!);
          // 整批在单个事务内执行, 任一行失败全部回滚 (失败由外层 catch 回 batchUpdateResult)
          await this.queryService.batchUpdate(
            driver,
            message.database,
            message.table,
            message.updates
          );
          panel.webview.postMessage({ type: 'batchUpdateResult', success: true });
          break;
        }

        case 'executeQuery': {
          // 检查是否包含破坏性操作
          const DANGEROUS_PATTERN = /^\s*(DROP|TRUNCATE|DELETE\s+FROM\s+\w[\w.]*\s*(?:;|$))/im;
          if (DANGEROUS_PATTERN.test(message.sql)) {
            const confirm = await vscode.window.showWarningMessage(
              'This query contains a destructive operation (DROP/TRUNCATE/DELETE). Continue?',
              { modal: true },
              'Execute'
            );
            if (confirm !== 'Execute') {
              panel.webview.postMessage({ type: 'queryResult', columns: [], rows: [], rowCount: 0, truncated: false });
              break;
            }
          }
          const driver = this.connectionManager.getDriver(connectionId!);
          const db = (context.database as string) ?? message.database;
          const { promise, cancel } = driver.executeCancellable(message.sql, undefined, db);
          this.pendingCancels.set(panel, cancel);
          try {
            const result = await promise;
            panel.webview.postMessage({
              type: 'queryResult',
              columns: result.columns,
              rows: result.rows,
              affectedRows: result.affectedRows,
              executionTime: result.executionTime,
            });
          } finally {
            this.pendingCancels.delete(panel);
          }
          break;
        }

        case 'cancelQuery': {
          const cancel = this.pendingCancels.get(panel);
          if (cancel) { cancel(); }
          break;
        }

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

        case 'fetchTableDetails': {
          const driver = this.connectionManager.getDriver(connectionId!);
          const columns = await driver.getDetailedColumns(message.database, message.table);
          panel.webview.postMessage({ type: 'tableDetails', columns, tableName: message.table });
          break;
        }

        case 'previewAlterTable': {
          const driver = this.connectionManager.getDriver(connectionId!);
          const stmts = buildAlterTableStatements(driver.driverType, message.table, message.changes);
          panel.webview.postMessage({
            type: 'alterTableResult',
            success: true,
            ddlPreview: stmts.join('\n'),
          });
          break;
        }

        case 'alterTable': {
          const driver = this.connectionManager.getDriver(connectionId!);
          const stmts = buildAlterTableStatements(driver.driverType, message.table, message.changes);
          for (const stmt of stmts) {
            const { promise } = driver.executeCancellable(stmt, undefined, message.database);
            await promise;
          }
          panel.webview.postMessage({ type: 'alterTableResult', success: true });
          // 刷新列信息
          const freshColumns = await driver.getDetailedColumns(message.database, message.table);
          panel.webview.postMessage({ type: 'tableDetails', columns: freshColumns, tableName: message.table });
          break;
        }

        case 'exportCsv': {
          const uri = await vscode.window.showSaveDialog({
            filters: { 'CSV Files': ['csv'] },
            defaultUri: vscode.Uri.file(message.defaultFileName),
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(message.content, 'utf-8'));
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
          }
          break;
        }

        case 'requestSchema': {
          const cacheKey = `${connectionId}:${message.database}`;
          const cached = this.schemaCache.get(cacheKey);
          if (cached && Date.now() - cached.ts < this.SCHEMA_CACHE_TTL) {
            panel.webview.postMessage({ type: 'schemaInfo', schema: cached.schema });
            break;
          }
          const schema = await this.fetchSchema(connectionId!, message.database);
          this.schemaCache.set(cacheKey, { schema, ts: Date.now() });
          panel.webview.postMessage({ type: 'schemaInfo', schema });
          break;
        }

        case 'refreshSchema': {
          const refreshKey = `${connectionId}:${message.database}`;
          this.schemaCache.delete(refreshKey);
          const freshSchema = await this.fetchSchema(connectionId!, message.database);
          this.schemaCache.set(refreshKey, { schema: freshSchema, ts: Date.now() });
          panel.webview.postMessage({ type: 'schemaInfo', schema: freshSchema });
          break;
        }

        default: {
          // db-browser messages
          if (message.type === 'listDatabasesAndTables' || message.type === 'refreshDatabases') {
            const driver = this.connectionManager.getDriver(connectionId!);
            try {
              const dbNames = await driver.listDatabases();
              const databases = await Promise.all(
                dbNames.map(async (name) => {
                  const tables = await driver.listTables(name);
                  return {
                    name,
                    tables: tables.map((t) => ({ name: t.name, rowCount: t.rowCount })),
                  };
                })
              );
              panel.webview.postMessage({ type: 'databaseTableList', databases });
            } catch (err) {
              panel.webview.postMessage({
                type: 'databaseTableList',
                databases: [],
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return;
          }

          if (message.type === 'showTableDDL') {
            const { database, table } = message as { database: string; table: string };
            this.showTableDDL(connectionId!, database, table);
            return;
          }

          if (message.type === 'dumpTable') {
            const { database, table, includeData } = message as { database: string; table: string; includeData: boolean };
            const driver = this.connectionManager.getDriver(connectionId!);
            const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
            const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const uri = await vscode.window.showSaveDialog({
              filters: { 'SQL Files': ['sql'] },
              defaultUri: vscode.Uri.file(`${baseDir}/${table}_${ts}.sql`),
            });
            if (!uri) { return; }
            if (includeData) {
              const { DumpService } = await import('../services/dump-service.js');
              const dumpService = new DumpService();
              await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Dumping ${table}...`, cancellable: true },
                async (progress, token) => {
                  const content = await dumpService.dumpStructAndData(
                    driver, database, table,
                    (current, total) => { progress.report({ increment: 0, message: `${current}/${total} rows` }); },
                    token
                  );
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
                  vscode.window.showInformationMessage(`Data dumped to ${uri.fsPath}`);
                }
              );
            } else {
              const { DumpService } = await import('../services/dump-service.js');
              const dumpService = new DumpService();
              const content = await dumpService.dumpStruct(driver, database, table);
              await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
              vscode.window.showInformationMessage(`Struct dumped to ${uri.fsPath}`);
            }
            return;
          }

          if (message.type === 'importSql') {
            const { database } = message as { database: string; table?: string };
            const uris = await vscode.window.showOpenDialog({
              filters: { 'SQL Files': ['sql'] },
              canSelectMany: false,
            });
            if (!uris || uris.length === 0) { return; }
            const fileContent = await vscode.workspace.fs.readFile(uris[0]);
            const sql = Buffer.from(fileContent).toString('utf-8');
            const driver = this.connectionManager.getDriver(connectionId!);
            try {
              const { promise } = driver.executeCancellable(sql, undefined, database);
              const result = await promise;
              vscode.window.showInformationMessage(`SQL imported. Affected rows: ${result.affectedRows}`);
              // 刷新左侧列表
              const dbNames = await driver.listDatabases();
              const databases = await Promise.all(
                dbNames.map(async (name) => {
                  const tables = await driver.listTables(name);
                  return { name, tables: tables.map((t) => ({ name: t.name, rowCount: t.rowCount })) };
                })
              );
              panel.webview.postMessage({ type: 'databaseTableList', databases });
            } catch (err) {
              vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
            }
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

          if (message.type.startsWith('rmq')) {
            const rmqDriver = this.connectionManager.getRabbitMQDriver(connectionId!);
            const post = (msg: unknown) => panel.webview.postMessage(msg);
            await handleRabbitMQMessage(message, rmqDriver, post);
            return;
          }

          if (message.type.startsWith('kafka')) {
            const kafkaDriver = this.connectionManager.getKafkaDriver(connectionId!);
            const post = (msg: unknown) => panel.webview.postMessage(msg);
            await handleKafkaMessage(message, kafkaDriver, post);
            return;
          }

          if (message.type.startsWith('mongo')) {
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
              const mongoDriver = this.connectionManager.getDriver(connectionId!);
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

            if (message.type === 'mongoRunQuery') {
              const { database, query } = message as { database: string; query: string };
              const mongoDriver = this.connectionManager.getDriver(connectionId!);
              const { promise, cancel } = mongoDriver.executeCancellable(query, undefined, database);
              this.pendingCancels.set(panel, cancel);
              try {
                const result = await promise;
                const ROW_LIMIT = 500;
                const truncated = (result.rows?.length ?? 0) > ROW_LIMIT;
                panel.webview.postMessage({
                  type: 'mongoQueryResult',
                  columns: result.columns ?? [],
                  rows: truncated ? result.rows.slice(0, ROW_LIMIT) : (result.rows ?? []),
                  affectedRows: result.affectedRows ?? 0,
                  executionTime: result.executionTime ?? 0,
                  truncated,
                });
              } catch (err) {
                panel.webview.postMessage({
                  type: 'mongoQueryResult',
                  columns: [], rows: [], affectedRows: 0,
                  executionTime: 0, truncated: false,
                  error: err instanceof Error ? err.message : String(err),
                });
              } finally {
                this.pendingCancels.delete(panel);
              }
              return;
            }

            if (message.type === 'mongoCancelQuery') {
              const cancel = this.pendingCancels.get(panel);
              if (cancel) { cancel(); this.pendingCancels.delete(panel); }
              return;
            }

            if (message.type === 'mongoDeleteDocument') {
              const confirmDelete = await vscode.window.showWarningMessage(
                'Delete this document?', { modal: true }, 'Delete'
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
                const mongoDriver = this.connectionManager.getDriver(connectionId!) as unknown as MongoDriver;
                const pipeline = buildExportPipeline(exportMsg.filter, exportMsg.sort, exportMsg.projection);
                const { json, count } = await mongoDriver.exportDocuments(exportMsg.database, exportMsg.collection, pipeline);
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
                const mongoDriver = this.connectionManager.getDriver(connectionId!) as unknown as MongoDriver;
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

            const mongoDriver = this.connectionManager.getDriver(connectionId!);
            const post = (msg: unknown) => panel.webview.postMessage(msg);
            await handleMongoMessage(message, mongoDriver, post);
            return;
          }

          if (message.type.startsWith('redis')) {
            const redisDriver = this.connectionManager.getRedisDriver(connectionId!);
            const post = (msg: unknown) => panel.webview.postMessage(msg);

            if (message.type === 'redisExportKeys') {
              const exportMsg = message as { keys: readonly string[]; database: number };
              try {
                const result = await exportRedisKeys(redisDriver, exportMsg.database, exportMsg.keys);
                if (result.errors.length > 0) {
                  vscode.window.showWarningMessage(`Export completed with errors: ${result.errors.join('; ')}`);
                }
                const uri = await vscode.window.showSaveDialog({
                  filters: { 'JSON Files': ['json'] },
                  defaultUri: vscode.Uri.file(`redis-export-db${exportMsg.database}.json`),
                });
                if (uri) {
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(result.json, 'utf-8'));
                  vscode.window.showInformationMessage(`Exported ${result.keyCount} key(s) to ${uri.fsPath}`);
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Export failed: ${msg}`);
              }
              return;
            }

            if (message.type === 'redisImport') {
              const importMsg = message as { database: number };
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
                  `Import ${keyCount} key(s)? Existing keys will be overwritten.`,
                  { modal: true },
                  'Import'
                );
                if (confirm !== 'Import') { return; }
                const result = await importRedisKeys(redisDriver, importMsg.database, content);
                if (result.errors.length > 0) {
                  vscode.window.showWarningMessage(`Import completed with errors: ${result.errors.join('; ')}`);
                }
                vscode.window.showInformationMessage(`Imported ${result.importedCount} key(s)`);
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
              if (!key?.trim()) { return; }
              await handleRedisMessage({ type: 'redisSetString', key: key.trim(), value: '', database: addMsg.database }, redisDriver, post);
              post({ type: 'redisAddKeyResult', key: key.trim() });
              return;
            }

            if (message.type === 'redisSetTTLPrompt') {
              const ttlMsg = message as { key: string; database: number };
              const input = await vscode.window.showInputBox({
                prompt: 'Enter TTL in seconds (-1 to remove)',
                validateInput: (v) => {
                  if (v.trim() === '') { return 'TTL is required'; }
                  const n = Number(v);
                  if (isNaN(n) || !Number.isInteger(n)) { return 'Must be an integer'; }
                  if (n < -1) { return 'Must be -1 (remove) or >= 0'; }
                  return undefined;
                },
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

            if (message.type === 'redisDeleteKeys') {
              const keyList = (message as { keys: string[] }).keys;
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
      // 脱敏处理: 过滤可能包含凭证的 URL 格式错误消息
      const safeMessage = (err instanceof Error)
        ? err.message.replace(/([a-z][a-z0-9+\-.]*:\/\/)[^@\s]*@/gi, '$1***@')
        : String(err);

      if (message.type === 'executeQuery') {
        panel.webview.postMessage({
          type: 'queryResult',
          columns: [],
          rows: [],
          affectedRows: 0,
          executionTime: 0,
          error: safeMessage,
        });
      } else if (message.type === 'batchUpdate') {
        panel.webview.postMessage({ type: 'batchUpdateResult', success: false, error: safeMessage });
      } else {
        panel.webview.postMessage({ type: 'error', message: safeMessage });
      }
    }
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
    const id = `${config.driverType}-${config.host}-${config.port}-${Date.now()}`;
    await this.connectionManager.addConnection(
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
