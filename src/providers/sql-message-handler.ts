import * as vscode from 'vscode';
import * as os from 'os';
import type { WebviewMessage } from '../types/messages.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { QueryService } from '../services/query-service.js';
import { buildBatchDelete } from '../utils/sql-builder.js';
import { buildAlterTableStatements } from '../utils/alter-table-builder.js';
import { isWholeTableWrite, splitSqlStatements } from '../utils/destructive-sql.js';
import type { ExtensionMessage, QueryHistoryEntry, StatementResult } from '../types/messages.js';
import type { SchemaColumn } from '../types/query.js';
import { sanitizeErrorMessage } from '../utils/sanitize-error.js';
import { cancelAiAsk, listAiModels, runAiAsk, setAiModel } from '../services/ai-assist.js';

// SQL (MySQL/PostgreSQL) CRUD 消息处理. 与 handleMongoMessage / handleRedisMessage 等对齐:
// 由 provider 解析依赖后调用, 返回 true 表示已处理 (provider 即停止路由), false 表示非 SQL 消息.
// 错误处理自包含: 各 case 自管特定回执 (queryResult/batchUpdateResult/...), 其余统一兜底 {type:error}.
export interface SqlMessageContext {
  readonly getDriver: () => IDatabaseDriver;
  readonly queryService: QueryService;
  readonly post: (msg: ExtensionMessage) => void;
  readonly panel: vscode.WebviewPanel;
  readonly pendingCancels: Map<vscode.WebviewPanel, () => void>;
  // executeQuery 优先用 panel context 绑定的 database (raw SQL 不自动加前缀)
  readonly database?: string;
  // schema 缓存读取 (缓存归 provider 所有, 跟随其生命周期); forceRefresh 对应 refreshSchema
  readonly getSchema: (database: string, forceRefresh: boolean) => Promise<Record<string, SchemaColumn[]>>;
  // 只读连接: executeQuery 在只读会话里执行 (写消息已由 provider 在进入这里之前拒绝)
  readonly readOnly: boolean;
  // 本连接的查询历史 (跨会话保留): executeQuery 每次执行记一条, listQueryHistory 读出
  readonly queryHistory: {
    readonly list: () => readonly QueryHistoryEntry[];
    readonly add: (entry: QueryHistoryEntry) => Promise<void>;
  };
}

export async function handleSqlMessage(
  message: WebviewMessage,
  ctx: SqlMessageContext
): Promise<boolean> {
  try {
    switch (message.type) {
      case 'insertRow': {
        try {
          await ctx.queryService.insertRow(ctx.getDriver(), message.database, message.table, message.row);
          ctx.post({ type: 'insertRowResult', success: true });
        } catch (err) {
          ctx.post({
            type: 'insertRowResult',
            success: false,
            error: sanitizeErrorMessage(err),
          });
        }
        return true;
      }

      case 'deleteRows': {
        const count = message.primaryKeys.length;
        const confirmDelete = await vscode.window.showWarningMessage(
          `Delete ${count} row(s) from ${message.database}.${message.table}?`, { modal: true }, 'Delete'
        );
        if (confirmDelete !== 'Delete') {
          // 用户取消: 回执 cancelled, 让前端停止等待而不刷新/不报错
          ctx.post({ type: 'deleteRowsResult', success: false, cancelled: true });
          return true;
        }
        try {
          const driver = ctx.getDriver();
          const batchQuery = buildBatchDelete(driver.driverType, message.table, message.primaryKeys, message.database);
          const deleted = batchQuery.sql
            ? (await driver.execute(batchQuery.sql, batchQuery.params, message.database)).affectedRows
            : 0;
          // 行可能已被别处删掉: 照常刷新, 但说清实际删了几行
          if (deleted < count) {
            void vscode.window.showWarningMessage(`Deleted ${deleted} of ${count} row(s); the others no longer exist`);
          }
          ctx.post({ type: 'deleteRowsResult', success: true });
        } catch (err) {
          ctx.post({
            type: 'deleteRowsResult',
            success: false,
            error: sanitizeErrorMessage(err),
          });
        }
        return true;
      }

      case 'listColumns': {
        // 失败也回 columnsResult 带 requestId: 笼统 error 会结束编辑器里同时在跑的查询的 loading
        const { requestId } = message;
        try {
          const columns = await ctx.getDriver().listColumns(message.database, message.table);
          ctx.post({ type: 'columnsResult', requestId, columns });
        } catch (err) {
          ctx.post({ type: 'columnsResult', requestId, columns: [], error: sanitizeErrorMessage(err) });
        }
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
        // 回执 (含出错) 一律带回 requestId, webview 只认最近一次请求的回执
        const database = ctx.database ?? message.database;
        const { requestId } = message;
        let reply: ExtensionMessage;
        // 执行过就记历史 (成功或失败); 破坏性确认被取消时没执行, 不记
        let ok: boolean | undefined;
        try {
          const batch = await runQuery(message.sql, database, ctx);
          if (batch.statements.length > 0) { ok = batch.statements.every((s) => s.status === 'ok'); }
          reply = { ...batch, requestId };
        } catch (err) {
          ok = false;
          reply = { type: 'queryResult', requestId, columns: [], rows: [], affectedRows: 0, executionTime: 0, error: sanitizeErrorMessage(err) };
        }
        if (ok !== undefined) {
          ctx.queryHistory.add({ sql: message.sql, database, ts: Date.now(), ok }).catch(() => { /* 历史写失败不影响查询回执 */ });
        }
        ctx.post(reply);
        return true;
      }

      case 'listQueryHistory': {
        ctx.post({ type: 'queryHistory', entries: ctx.queryHistory.list() });
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
        ctx.post({ type: 'alterTablePreview', ddl: stmts.join('\n') });
        return true;
      }

      case 'alterTable': {
        const dropped = message.changes.droppedColumns;
        if (dropped.length > 0) {
          const confirm = await vscode.window.showWarningMessage(
            `Drop column(s) ${dropped.join(', ')} from ${message.table}? Their data is deleted.`,
            { modal: true },
            'Drop'
          );
          if (confirm !== 'Drop') { return true; }
        }
        const driver = ctx.getDriver();
        const stmts = buildAlterTableStatements(driver.driverType, message.table, message.changes);
        try {
          const { error } = await driver.executeBatch(stmts, message.database).promise;
          if (error) {
            const base = sanitizeErrorMessage(error.cause);
            // 多条 DDL 非原子 (MySQL DDL 隐式提交无法回滚): 明确回报已执行/未执行边界,
            // 防用户基于陈旧结构重试重复已落库的改动
            const detail = stmts.length > 1
              ? `${base} (已执行 ${error.index}/${stmts.length} 条, 表结构可能部分变更)`
              : base;
            ctx.post({ type: 'alterTableResult', success: false, error: detail });
          } else {
            ctx.post({ type: 'alterTableResult', success: true });
          }
        } catch (err) {
          ctx.post({ type: 'alterTableResult', success: false, error: sanitizeErrorMessage(err) });
        }
        // 无论成败都刷新列信息, 让 UI 基线与 DB 实际状态一致
        try {
          const freshColumns = await driver.getDetailedColumns(message.database, message.table);
          ctx.post({ type: 'tableDetails', columns: freshColumns, tableName: message.table });
        } catch { /* 刷新失败忽略: 主操作结果已回报 */ }
        return true;
      }

      case 'exportCsv': {
        const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = await vscode.window.showSaveDialog({
          filters: { 'CSV Files': ['csv'] },
          defaultUri: vscode.Uri.file(`${baseDir}/${message.defaultFileName}`),
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(message.content, 'utf-8'));
          vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
        return true;
      }

      case 'aiAsk': {
        const db = ctx.database ?? message.database;
        const { id } = message;
        // panel 关闭后 webview.postMessage 会抛, 回执丢掉即可
        const send = (msg: ExtensionMessage) => { try { ctx.post(msg); } catch { /* panel 已关闭 */ } };
        try {
          const model = await runAiAsk(ctx.panel, async () => ({
            dialect: ctx.getDriver().driverType === 'postgresql' ? 'PostgreSQL' : 'MySQL',
            database: db,
            schema: await ctx.getSchema(db, false),
            question: message.question,
            sql: message.sql,
            selection: message.selection,
            lastError: message.lastError,
          }), (text) => send({ type: 'aiChunk', id, text }));
          send({ type: 'aiDone', id, model });
        } catch (err) {
          send({ type: 'aiDone', id, error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      case 'aiListModels': {
        try {
          ctx.post({ type: 'aiModels', ...(await listAiModels()) });
        } catch (err) {
          ctx.post({ type: 'aiModels', models: [], selected: '', error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      case 'aiSetModel': {
        await setAiModel(message.id);
        return true;
      }

      case 'aiCancel': {
        cancelAiAsk(ctx.panel);
        return true;
      }

      case 'requestSchema':
      case 'refreshSchema': {
        // 自动补全只用列名. 失败用通知报告, 不回笼统 error: 那会结束编辑器里同时在跑的查询的 loading
        let schema: Record<string, SchemaColumn[]>;
        try {
          schema = await ctx.getSchema(message.database, message.type === 'refreshSchema');
        } catch (err) {
          void vscode.window.showErrorMessage(`Failed to load schema for autocomplete: ${sanitizeErrorMessage(err)}`);
          return true;
        }
        ctx.post({ type: 'schemaInfo', schema: Object.fromEntries(Object.entries(schema).map(([t, cols]) => [t, cols.map((c) => c.name)])) });
        return true;
      }

      case 'listDatabasesAndTables': {
        try {
          const databases = await listDatabasesWithTables(ctx.getDriver());
          ctx.post({ type: 'databaseTableList', databases });
        } catch (err) {
          ctx.post({
            type: 'databaseTableList',
            databases: [],
            error: sanitizeErrorMessage(err),
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
              let content: string;
              try {
                content = await dumpService.dumpStructAndData(
                  driver, database, table,
                  (current, total) => { progress.report({ increment: 0, message: `${current}/${total} rows` }); },
                  token
                );
              } catch (err) {
                // 取消不写文件; 其余错误交给外层兜底
                if (!token.isCancellationRequested) { throw err; }
                vscode.window.showInformationMessage('Dump cancelled');
                return;
              }
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
        const { database } = message;
        const uris = await vscode.window.showOpenDialog({
          filters: { 'SQL Files': ['sql'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) { return true; }
        const fileContent = await vscode.workspace.fs.readFile(uris[0]);
        const sql = Buffer.from(fileContent).toString('utf-8');
        const driver = ctx.getDriver();
        // 自家 dump 以 DROP TABLE IF EXISTS 开头, 导入到已有的表上会先删表
        if (isWholeTableWrite(sql, driver.driverType)) {
          const confirm = await vscode.window.showWarningMessage(
            'This SQL file contains a destructive operation (DROP/TRUNCATE, ALTER TABLE ... DROP, or DELETE/UPDATE without WHERE). Import anyway?',
            { modal: true },
            'Import'
          );
          if (confirm !== 'Import') { return true; }
        }
        try {
          const stmts = statementsFor(driver, sql);
          const { results, error, warning } = await driver.executeBatch(stmts, database).promise;
          if (error) {
            // MySQL 逐条 autocommit, 失败点之前的语句已生效; PG 整段在隐式事务里, 出错整段回滚
            const at = stmts.length > 1
              ? ` at statement ${error.index + 1}/${stmts.length}${error.index > 0 ? ' (earlier statements were applied)' : ''}`
              : '';
            vscode.window.showErrorMessage(`Import failed${at}: ${sanitizeErrorMessage(error.cause)}`);
          } else {
            const affected = results.reduce((n, r) => n + r.affectedRows, 0);
            vscode.window.showInformationMessage(`SQL imported. Affected rows: ${affected}${warning ? `. ${warning}` : ''}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Import failed: ${sanitizeErrorMessage(err)}`);
        }
        // 刷新左侧列表 (失败时前面的语句也可能已建表). 刷新失败报在列表里, 导入结果仍是唯一的通知
        try {
          ctx.post({ type: 'databaseTableList', databases: await listDatabasesWithTables(driver) });
        } catch (err) {
          ctx.post({ type: 'databaseTableList', databases: [], error: sanitizeErrorMessage(err) });
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

// MySQL 在客户端按 ; 切分 (mysql2 未开 multipleStatements); PG 整段交给 simple protocol 由服务端切分,
// 整段在一个隐式事务里, 出错整段回滚
function statementsFor(driver: IDatabaseDriver, sql: string): string[] {
  return driver.driverType === 'mysql' ? splitSqlStatements(sql, 'mysql') : [sql];
}

// 网格展示的结果集最多发这么多行: 不带 LIMIT 的大查询整包 postMessage 会卡住所有扩展共用的 extension host
export const RESULT_ROW_CAP = 10_000;

// executeQuery 的执行体, 返回待发的 queryBatchResult (不含 requestId).
// 整次执行在一条专用连接上跑完 (executeBatch), 编辑器里的 USE / BEGIN 对同一次执行的后续语句生效.
// cancel 槽位每个 panel 一个: 执行结束只清自己放进去的 cancel, 晚结束的旧执行不能清掉新执行的
async function runQuery(
  sql: string,
  db: string,
  ctx: SqlMessageContext
): Promise<{ type: 'queryBatchResult'; statements: StatementResult[]; warning?: string }> {
  // 破坏性操作确认网: DROP/TRUNCATE, ALTER TABLE ... DROP 及无 WHERE 的整表 DELETE/UPDATE.
  // 只读连接通常不问 (只读会话本就拒绝这些语句); 但语句里出现 READ WRITE 时用户可能在解除只读, 照样问
  const driver = ctx.getDriver();
  const sessionStaysReadOnly = ctx.readOnly && !/\bREAD\s+WRITE\b/i.test(sql);
  if (!sessionStaysReadOnly && isWholeTableWrite(sql, driver.driverType)) {
    const confirm = await vscode.window.showWarningMessage(
      'This query contains a destructive operation (DROP/TRUNCATE, ALTER TABLE ... DROP, or DELETE/UPDATE without WHERE). Continue?',
      { modal: true },
      'Execute'
    );
    if (confirm !== 'Execute') {
      return { type: 'queryBatchResult', statements: [] };
    }
  }

  const stmts = statementsFor(driver, sql);
  const { promise, cancel } = driver.executeBatch(stmts, db, { readOnly: ctx.readOnly });
  ctx.pendingCancels.set(ctx.panel, cancel);
  try {
    const { results, error, warning, cancelled } = await promise;
    // 取消时在跑的是最后一条 (语句之间的取消走 error). 它返回的结果集按已取消报告 (KILL QUERY 打断的 SELECT SLEEP() 照常返回 1);
    // 写语句照常返回说明已生效, 照实报告
    const cancelledAt = !error && cancelled && results.at(-1)?.columns.length ? results.length - 1 : -1;
    // 网格只展示最后一个 ok 的结果集 (与 webview 的 lastResultSetFromBatch 同一判定): 只有它带行 (截到 RESULT_ROW_CAP),
    // 其余结果集只留行数给摘要
    let shown = -1;
    results.forEach((r, i) => { if (r.columns.length > 0 && i !== cancelledAt) { shown = i; } });
    const statements: StatementResult[] = results.map((r, i) => i === cancelledAt
      ? { index: i + 1, sql: r.sql, status: 'error', error: 'Query cancelled' }
      : {
        index: i + 1,
        sql: r.sql,
        status: 'ok',
        executionTime: r.executionTime,
        affectedRows: r.affectedRows,
        columns: [...r.columns],
        ...(r.columns.length > 0 ? { rowCount: r.rows.length } : {}),
        ...(i === shown ? { rows: r.rows.slice(0, RESULT_ROW_CAP), truncated: r.rows.length > RESULT_ROW_CAP } : {}),
      });
    if (error) {
      statements.push({ index: statements.length + 1, sql: stmts[error.index], status: 'error', error: sanitizeErrorMessage(error.cause) });
      for (const stmt of stmts.slice(error.index + 1)) {
        statements.push({ index: statements.length + 1, sql: stmt, status: 'skipped' });
      }
    }
    return { type: 'queryBatchResult', statements, warning };
  } finally {
    if (ctx.pendingCancels.get(ctx.panel) === cancel) { ctx.pendingCancels.delete(ctx.panel); }
  }
}

// PG 按库建连接, 连不上某个库时的 SQLSTATE: 无 CONNECT 权限 / 库已不存在 / pg_hba 拒绝 (如云托管的管理库)
const UNREACHABLE_DATABASE_CODES = new Set(['42501', '3D000', '28000']);

// db-browser 左侧列表: 列出所有 database 及其 table (webview 隐藏的系统库也在内, 切换显示时不用重取).
// MySQL 两条查询取完; PG 逐库查, 最多 4 个库并发: 每个库要新开一条连接, 库多时不能一次占满服务端 max_connections
async function listDatabasesWithTables(
  driver: IDatabaseDriver
): Promise<{ name: string; tables: { name: string; rowCount: number }[] }[]> {
  if (driver.listAllTables) {
    const [names, all] = await Promise.all([driver.listDatabases(), driver.listAllTables()]);
    const byDb = new Map<string, { name: string; rowCount: number }[]>();
    for (const t of all) {
      const list = byDb.get(t.schema) ?? [];
      list.push({ name: t.name, rowCount: t.rowCount });
      byDb.set(t.schema, list);
    }
    return names.map((name) => ({ name, tables: byDb.get(name) ?? [] }));
  }
  const dbNames = await driver.listDatabases();
  const out: { name: string; tables: { name: string; rowCount: number }[] }[] = new Array(dbNames.length);
  let next = 0;
  const worker = async () => {
    while (next < dbNames.length) {
      const i = next++;
      const name = dbNames[i];
      // 连不上的库列成空库, 不拖垮整个列表; 其他错误照常抛出
      const tables = await driver.listTables(name).catch((err: unknown) => {
        if (UNREACHABLE_DATABASE_CODES.has(String((err as { code?: unknown } | null)?.code))) { return []; }
        throw err;
      });
      out[i] = { name, tables: tables.map((t) => ({ name: t.name, rowCount: t.rowCount })) };
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}
