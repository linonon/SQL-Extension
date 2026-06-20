import * as vscode from 'vscode';
import * as os from 'os';
import type { WebviewMessage } from '../types/messages.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { QueryService } from '../services/query-service.js';
import { buildBatchDelete } from '../utils/sql-builder.js';
import { buildAlterTableStatements } from '../utils/alter-table-builder.js';
import { isWholeTableWrite } from '../utils/destructive-sql.js';
import { sanitizeErrorMessage } from '../utils/sanitize-error.js';

// SQL (MySQL/PostgreSQL) CRUD 消息处理. 与 handleMongoMessage / handleRedisMessage 等对齐:
// 由 provider 解析依赖后调用, 返回 true 表示已处理 (provider 即停止路由), false 表示非 SQL 消息.
// 错误处理自包含: 各 case 自管特定回执 (queryResult/batchUpdateResult/...), 其余统一兜底 {type:error}.
export interface SqlMessageContext {
  readonly getDriver: () => IDatabaseDriver;
  readonly queryService: QueryService;
  readonly post: (msg: unknown) => void;
  readonly panel: vscode.WebviewPanel;
  readonly pendingCancels: Map<vscode.WebviewPanel, () => void>;
  // executeQuery 优先用 panel context 绑定的 database (raw SQL 不自动加前缀)
  readonly database?: string;
  // schema 缓存读取 (缓存归 provider 所有, 跟随其生命周期); forceRefresh 对应 refreshSchema
  readonly getSchema: (database: string, forceRefresh: boolean) => Promise<Record<string, string[]>>;
}

export async function handleSqlMessage(
  message: WebviewMessage,
  ctx: SqlMessageContext
): Promise<boolean> {
  try {
    switch (message.type) {
      case 'fetchRows': {
        const result = await ctx.queryService.fetchRows(
          ctx.getDriver(),
          message.database,
          message.table,
          message.offset,
          message.limit
        );
        ctx.post({
          type: 'tableData',
          columns: result.columns,
          rows: result.rows,
          total: result.total,
          offset: result.page.offset,
          limit: result.page.limit,
        });
        return true;
      }

      case 'insertRow': {
        try {
          await ctx.queryService.insertRow(ctx.getDriver(), message.database, message.table, message.row);
          ctx.post({ type: 'insertRowResult', success: true });
        } catch (err) {
          ctx.post({
            type: 'insertRowResult',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      case 'updateRow': {
        try {
          await ctx.queryService.updateRow(
            ctx.getDriver(),
            message.database,
            message.table,
            message.primaryKeys,
            message.changes
          );
          ctx.post({ type: 'updateRowResult', success: true });
        } catch (err) {
          ctx.post({
            type: 'updateRowResult',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      case 'deleteRows': {
        const count = message.primaryKeys.length;
        const confirmDelete = await vscode.window.showWarningMessage(
          `Delete ${count} row(s)?`, { modal: true }, 'Delete'
        );
        if (confirmDelete !== 'Delete') {
          // 用户取消: 回执 cancelled, 让前端停止等待而不刷新/不报错
          ctx.post({ type: 'deleteRowsResult', success: false, cancelled: true });
          return true;
        }
        try {
          const driver = ctx.getDriver();
          const batchQuery = buildBatchDelete(driver.driverType, message.table, message.primaryKeys, message.database);
          if (batchQuery.sql) {
            await driver.execute(batchQuery.sql, batchQuery.params);
          }
          ctx.post({ type: 'deleteRowsResult', success: true });
        } catch (err) {
          ctx.post({
            type: 'deleteRowsResult',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      case 'listColumns': {
        const cols = await ctx.getDriver().listColumns(message.database, message.table);
        ctx.post({ type: 'columnsResult', columns: cols });
        return true;
      }

      case 'batchUpdate': {
        // 整批在单个事务内执行, 任一行失败全部回滚
        try {
          await ctx.queryService.batchUpdate(
            ctx.getDriver(),
            message.database,
            message.table,
            message.updates
          );
          ctx.post({ type: 'batchUpdateResult', success: true });
        } catch (err) {
          ctx.post({ type: 'batchUpdateResult', success: false, error: sanitizeErrorMessage(err) });
        }
        return true;
      }

      case 'executeQuery': {
        // 破坏性操作确认网: DROP/TRUNCATE 及无 WHERE 的整表 DELETE/UPDATE
        if (isWholeTableWrite(message.sql)) {
          const confirm = await vscode.window.showWarningMessage(
            'This query contains a destructive operation (DROP/TRUNCATE, or DELETE/UPDATE without WHERE). Continue?',
            { modal: true },
            'Execute'
          );
          if (confirm !== 'Execute') {
            // 取消: 回空结果, 形状与成功/错误分支一致 (queryResult 字段是 affectedRows/executionTime)
            ctx.post({ type: 'queryResult', columns: [], rows: [], affectedRows: 0, executionTime: 0 });
            return true;
          }
        }
        const db = ctx.database ?? message.database;
        const { promise, cancel } = ctx.getDriver().executeCancellable(message.sql, undefined, db);
        ctx.pendingCancels.set(ctx.panel, cancel);
        try {
          const result = await promise;
          ctx.post({
            type: 'queryResult',
            columns: result.columns,
            rows: result.rows,
            affectedRows: result.affectedRows,
            executionTime: result.executionTime,
          });
        } catch (err) {
          ctx.post({
            type: 'queryResult',
            columns: [], rows: [], affectedRows: 0, executionTime: 0,
            error: sanitizeErrorMessage(err),
          });
        } finally {
          ctx.pendingCancels.delete(ctx.panel);
        }
        return true;
      }

      case 'cancelQuery': {
        const cancel = ctx.pendingCancels.get(ctx.panel);
        if (cancel) { cancel(); }
        return true;
      }

      case 'fetchTableDetails': {
        const columns = await ctx.getDriver().getDetailedColumns(message.database, message.table);
        ctx.post({ type: 'tableDetails', columns, tableName: message.table });
        return true;
      }

      case 'previewAlterTable': {
        const stmts = buildAlterTableStatements(ctx.getDriver().driverType, message.table, message.changes);
        ctx.post({ type: 'alterTableResult', success: true, ddlPreview: stmts.join('\n') });
        return true;
      }

      case 'alterTable': {
        const driver = ctx.getDriver();
        const stmts = buildAlterTableStatements(driver.driverType, message.table, message.changes);
        let executed = 0;
        try {
          for (const stmt of stmts) {
            const { promise } = driver.executeCancellable(stmt, undefined, message.database);
            await promise;
            executed++;
          }
          ctx.post({ type: 'alterTableResult', success: true });
        } catch (err) {
          const base = err instanceof Error ? err.message : String(err);
          // 多条 DDL 非原子 (MySQL DDL 隐式提交无法回滚): 明确回报已执行/未执行边界,
          // 防用户基于陈旧结构重试重复已落库的改动
          const detail = stmts.length > 1
            ? `${base} (已执行 ${executed}/${stmts.length} 条, 表结构可能部分变更)`
            : base;
          ctx.post({ type: 'alterTableResult', success: false, error: detail });
        }
        // 无论成败都刷新列信息, 让 UI 基线与 DB 实际状态一致 (rename 后用新表名)
        const refreshTable = message.changes.renamedTable ?? message.table;
        try {
          const freshColumns = await driver.getDetailedColumns(message.database, refreshTable);
          ctx.post({ type: 'tableDetails', columns: freshColumns, tableName: refreshTable });
        } catch { /* 刷新失败忽略: 主操作结果已回报 */ }
        return true;
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
        return true;
      }

      case 'requestSchema': {
        const schema = await ctx.getSchema(message.database, false);
        ctx.post({ type: 'schemaInfo', schema });
        return true;
      }

      case 'refreshSchema': {
        const schema = await ctx.getSchema(message.database, true);
        ctx.post({ type: 'schemaInfo', schema });
        return true;
      }

      case 'listDatabasesAndTables':
      case 'refreshDatabases': {
        try {
          const databases = await listDatabasesWithTables(ctx.getDriver());
          ctx.post({ type: 'databaseTableList', databases });
        } catch (err) {
          ctx.post({
            type: 'databaseTableList',
            databases: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      case 'dumpTable': {
        const { database, table, includeData } = message as { database: string; table: string; includeData: boolean };
        const driver = ctx.getDriver();
        const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const uri = await vscode.window.showSaveDialog({
          filters: { 'SQL Files': ['sql'] },
          defaultUri: vscode.Uri.file(`${baseDir}/${table}_${ts}.sql`),
        });
        if (!uri) { return true; }
        const { DumpService } = await import('../services/dump-service.js');
        const dumpService = new DumpService();
        if (includeData) {
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
          const content = await dumpService.dumpStruct(driver, database, table);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
          vscode.window.showInformationMessage(`Struct dumped to ${uri.fsPath}`);
        }
        return true;
      }

      case 'importSql': {
        const { database } = message as { database: string; table?: string };
        const uris = await vscode.window.showOpenDialog({
          filters: { 'SQL Files': ['sql'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) { return true; }
        const fileContent = await vscode.workspace.fs.readFile(uris[0]);
        const sql = Buffer.from(fileContent).toString('utf-8');
        const driver = ctx.getDriver();
        try {
          const { promise } = driver.executeCancellable(sql, undefined, database);
          const result = await promise;
          vscode.window.showInformationMessage(`SQL imported. Affected rows: ${result.affectedRows}`);
          // 刷新左侧列表
          const databases = await listDatabasesWithTables(driver);
          ctx.post({ type: 'databaseTableList', databases });
        } catch (err) {
          vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    // 兜底: 未自管回执的 SQL case 抛错 -> 通用 error (脱敏)
    ctx.post({ type: 'error', message: sanitizeErrorMessage(err) });
    return true;
  }
}

// db-browser 左侧列表: 列出所有 database 及其 table
async function listDatabasesWithTables(
  driver: IDatabaseDriver
): Promise<{ name: string; tables: { name: string; rowCount: number }[] }[]> {
  const dbNames = await driver.listDatabases();
  return Promise.all(
    dbNames.map(async (name) => {
      const tables = await driver.listTables(name);
      return { name, tables: tables.map((t) => ({ name: t.name, rowCount: t.rowCount })) };
    })
  );
}
