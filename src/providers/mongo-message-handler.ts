import * as vscode from 'vscode';
import type { Document } from 'mongodb';
import type { ExtensionMessage, WebviewMessage } from '../types/messages.js';
import { BROWSE_TIMEOUT_MS, fieldPathTypes, userFilter, type MongoDriver } from '../drivers/mongo-driver.js';
import { buildMongoAiPrompt, streamAiAnswer } from '../services/ai-assist.js';
import { convertEjsonToBson } from '../utils/mongo-shell-to-json.js';
import { parseShellJson } from '../utils/mongo-shell-syntax.js';
import { buildClone, buildUpdate, castLike, changedSinceLoaded, diffDocuments, isEmptyDiff, type DocumentDiff } from '../utils/mongo-update.js';

const NOT_FOUND = 'document not found (deleted or _id changed)';

// 返回 true 表示已处理, false 表示不是 mongo 消息. 删除 / 删集合 / 导入的确认在执行它的 case 里.
// aiKey: 进行中提问的取消 key, 须与 aiCancel / panel 关闭时 cancelAiAsk 用的同一个 (panel)
export async function handleMongoMessage(
  message: WebviewMessage,
  mongo: MongoDriver,
  post: (msg: ExtensionMessage) => void,
  aiKey: object
): Promise<boolean> {
  switch (message.type) {
    case 'mongoListAllCollections': {
      await postRefreshedCollections(mongo, post);
      return true;
    }

    case 'mongoFindDocuments': {
      // 回执 (含出错) 带回 requestId, webview 只认最近一次查询的回执.
      // 总数只在 count=true (Apply / 切集合) 时算, 与取数并发但另发一条回执: 慢 count 不拖住文档
      const { requestId, database, collection, filter, sort, projection, skip, limit, count } = message;
      try {
        const pipeline = buildAggregatePipeline(filter, sort, projection, skip, limit);
        const counting = count ? browserCount(mongo, database, collection, userFilter(parseShell('Filter', filter))) : null;
        const docsResult = await mongo.findDocumentsForBrowser(database, collection, pipeline);
        post({ type: 'mongoDocumentList', requestId, columns: docsResult.columns, rows: docsResult.rows });
        if (counting) { post({ type: 'mongoDocumentCount', requestId, total: await counting }); }
      } catch (err) {
        // 50 = MaxTimeMSExpired: 浏览查询撞到服务端超时
        const errorMsg = (err as { code?: unknown } | null)?.code === 50
          ? `Query exceeded ${BROWSE_TIMEOUT_MS / 1000}s; filter on an indexed field`
          : err instanceof Error ? err.message : String(err);
        post({ type: 'mongoDocumentList', requestId, columns: [], rows: [], error: errorMsg });
      }
      return true;
    }

    // 写操作: _id filter 由 webview 送来的 EJSON _id 还原 (复合 / ObjectId / Date _id 保留类型), 不做 24-hex 自动转换
    case 'mongoInsertDocument':
    case 'mongoUpdateDocument':
    case 'mongoCloneDocument':
    case 'mongoDeleteDocument': {
      if (message.type === 'mongoDeleteDocument') {
        // 点名库 / 集合 / _id: 删的是这条消息里的目标, 让用户能核对它是否就是界面上看到的那条
        const confirmDelete = await vscode.window.showWarningMessage(
          `Delete document ${JSON.stringify(message.id)} from ${message.database}.${message.collection}?`, { modal: true }, 'Delete'
        );
        if (confirmDelete !== 'Delete') { return true; }
      }
      try {
        const outcome = await writeDocument(message, mongo);
        // 成功的提示在宿主侧, 失败由 webview 行内显示; 回执照常发给 webview
        if (outcome.success && outcome.message) { void vscode.window.showInformationMessage(outcome.message); }
        post({ type: 'mongoOperationResult', ...outcome });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoOperationResult', success: false, error: errorMsg });
      }
      return true;
    }

    case 'mongoExplainQuery': {
      const { database, collection, filter, sort } = message;
      try {
        const sortObj = sort.trim() ? parseShell('Sort', sort) as Record<string, unknown> : undefined;
        const summary = await mongo.explainFind(database, collection, parseShell('Filter', filter) as Record<string, unknown>, sortObj);
        post({ type: 'mongoExplainResult', summary });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoExplainResult', error: errorMsg });
      }
      return true;
    }

    case 'mongoAiAsk': {
      // 字段类型取自随机采样的文档 (promoteValues:false 保住 Int32 / Long / Double), 只进 key 与类型, 不进值
      const { database, collection } = message;
      await streamAiAnswer(aiKey, message.id, post, async () => {
        // 采样失败 (含连接已断时 aggregate 同步抛错) 只是少了字段清单, 不让提问失败
        const samples = await Promise.resolve()
          .then(() => mongo.aggregate(database, collection, [{ $sample: { size: 20 } }], { promoteValues: false, maxTimeMS: 5000 }))
          .catch(() => []);
        return buildMongoAiPrompt({
          database,
          collection,
          question: message.question,
          filter: message.filter,
          sort: message.sort,
          projection: message.projection,
          limit: message.limit,
          skip: message.skip,
          lastError: message.lastError,
          fields: fieldPathTypes(samples),
          now: new Date(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      });
      return true;
    }

    case 'mongoCreateCollection': {
      const { database } = message;
      const input = await vscode.window.showInputBox({
        prompt: `New collection in "${database}"`,
        placeHolder: 'collection_name',
        validateInput: (v) => {
          if (!v.trim()) { return 'Collection name is required'; }
          if (/[.$]/.test(v)) { return 'Cannot contain . or $'; }
          return undefined;
        },
      });
      if (!input) { return true; }
      const collection = input.trim();
      try {
        await mongo.createCollection(database, collection);
        post({ type: 'mongoCollectionCreated', success: true });
        await postRefreshedCollections(mongo, post);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoCollectionCreated', success: false, error: errorMsg });
      }
      return true;
    }

    case 'mongoDropCollection': {
      const { database, collection } = message;
      const confirm = await vscode.window.showWarningMessage(
        `Drop collection "${database}.${collection}"? This cannot be undone.`,
        { modal: true },
        'Drop'
      );
      if (confirm !== 'Drop') { return true; }
      try {
        await mongo.dropCollection(database, collection);
        post({ type: 'mongoCollectionDropped', success: true, database, collection });
        await postRefreshedCollections(mongo, post);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoCollectionDropped', success: false, error: errorMsg });
      }
      return true;
    }

    case 'mongoExportCollection': {
      const { database, collection, filter, sort, projection } = message;
      const aborter = new AbortController();
      try {
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'], 'JSONL Files': ['jsonl'] },
          defaultUri: vscode.Uri.file(`${collection}.json`),
        });
        if (!uri) { return true; }
        const jsonl = uri.path.toLowerCase().endsWith('.jsonl');
        const pipeline = buildExportPipeline(filter, sort, projection);
        // 边读游标边写文件 (save dialog 给的是 file scheme); 取消或出错时 driver 已删掉写了一半的文件
        const count = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Exporting ${database}.${collection}`, cancellable: true },
          (progress, token) => {
            token.onCancellationRequested(() => aborter.abort());
            return mongo.exportDocuments(database, collection, pipeline, uri.fsPath, jsonl, {
              signal: aborter.signal,
              onProgress: (n) => progress.report({ message: `${n} document(s)` }),
            });
          },
        );
        vscode.window.showInformationMessage(`Exported ${count} document(s) to ${uri.fsPath}`);
      } catch (e) {
        if (aborter.signal.aborted) {
          vscode.window.showInformationMessage('Export cancelled');
          return true;
        }
        const errMsg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Export failed: ${errMsg}`);
      }
      return true;
    }

    case 'mongoImportCollection': {
      const { database, collection } = message;
      let attempted = false;
      try {
        const fileUris = await vscode.window.showOpenDialog({
          filters: { 'JSON/JSONL Files': ['json', 'jsonl'] },
          canSelectMany: false,
        });
        if (!fileUris || fileUris.length === 0) { return true; }
        const content = Buffer.from(await vscode.workspace.fs.readFile(fileUris[0])).toString('utf-8');
        const lineCount = content.trim().startsWith('[')
          ? (JSON.parse(content.trim()) as unknown[]).length
          : content.trim().split('\n').filter((l) => l.trim()).length;
        const confirm = await vscode.window.showWarningMessage(
          `Import will insert ${lineCount} document(s) into "${database}.${collection}". Continue?`,
          { modal: true },
          'Insert'
        );
        if (confirm !== 'Insert') { return true; }
        attempted = true;
        const inserted = await mongo.importDocuments(database, collection, content);
        vscode.window.showInformationMessage(`Imported ${inserted} document(s) into "${database}.${collection}"`);
        post({ type: 'mongoImportResult', success: true, inserted });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Import failed: ${errMsg}`);
        post({ type: 'mongoImportResult', success: false, error: errMsg });
      }
      // 开始写入后成功或中途失败都可能改了文档数: 刷新集合列表的计数. 导入结果已提示过, 刷新本身失败不再报
      if (attempted) { await postRefreshedCollections(mongo, post).catch(() => {}); }
      return true;
    }

    default:
      return false;
  }
}

async function postRefreshedCollections(
  mongo: MongoDriver,
  post: (msg: ExtensionMessage) => void
): Promise<void> {
  const databases = await mongo.listDatabases();
  // 并行获取所有 database 的 collections, 总耗时 max(T) 而非 N*T
  const results = await Promise.allSettled(
    databases.map((db) => mongo.listTables(db))
  );
  const all: { database: string; name: string; count: number }[] = [];
  for (let i = 0; i < databases.length; i++) {
    const r = results[i];
    // rejected: 跳过无权限或报错的 database
    if (r.status === 'fulfilled') {
      for (const t of r.value) {
        all.push({ database: databases[i], name: t.name, count: t.rowCount ?? 0 });
      }
    }
  }
  post({ type: 'mongoAllCollectionList', collections: all });
}

type WriteMessage = Extract<WebviewMessage, { type: 'mongoInsertDocument' | 'mongoUpdateDocument' | 'mongoCloneDocument' | 'mongoDeleteDocument' }>;
type WriteOutcome = { success: boolean; affectedRows?: number; error?: string; message?: string };

async function writeDocument(message: WriteMessage, mongo: MongoDriver): Promise<WriteOutcome> {
  const { database, collection } = message;
  switch (message.type) {
    case 'mongoInsertDocument':
      // 没有原文档作类型模板: 裸数字按 castLike 的无模板规则落库
      await mongo.insertOne(database, collection, castLike(undefined, convertEjsonToBson(message.document)) as Document);
      return { success: true, affectedRows: 1 };

    case 'mongoUpdateDocument': {
      // 只写用户改过的 path, 没动的字段不被旧快照覆盖
      const original = convertEjsonToBson(message.original) as Record<string, unknown>;
      const diff = diffDocuments(original, convertEjsonToBson(message.document) as Record<string, unknown>);
      if (isEmptyDiff(diff)) { return { success: true, affectedRows: 0, message: 'No changes' }; }
      const filter = { _id: convertEjsonToBson(message.id) };
      // 重读库内文档: 要写的 path 期间被别人 (如游戏服) 改过就拒绝, 否则沿用原值的 BSON 数值类型写入.
      // 重读到 updateOne 之间仍有毫秒级窗口
      const current = await mongo.findOneTyped(database, collection, filter);
      if (!current) { return { success: false, error: NOT_FOUND }; }
      const changed = changedSinceLoaded(original, current, diff);
      if (changed.length > 0) {
        // projection 只裁顶层字段: 原文档缺而库里有的顶层字段, 也可能只是被 projection 隐藏了
        const maybeHidden = changed.some((p) => !Object.hasOwn(original, p.split('.')[0]));
        return {
          success: false,
          error: `Field(s) ${changed.join(', ')} changed since the document was loaded; reload and edit again`
            + (maybeHidden ? ' (fields hidden by the projection count as changed; clear the projection first)' : ''),
        };
      }
      const matched = await mongo.updateOne(database, collection, filter, buildUpdate(current, diff));
      return matched ? { success: true, affectedRows: matched } : { success: false, error: NOT_FOUND };
    }

    case 'mongoCloneDocument': {
      const source = await mongo.findOneTyped(database, collection, { _id: convertEjsonToBson(message.sourceId) });
      if (!source) { return { success: false, error: NOT_FOUND }; }
      await mongo.insertOne(database, collection, buildClone(source, editDiff(message.original, message.document)));
      return { success: true, affectedRows: 1 };
    }

    case 'mongoDeleteDocument': {
      const deleted = await mongo.deleteOne(database, collection, { _id: convertEjsonToBson(message.id) });
      return deleted ? { success: true, affectedRows: deleted } : { success: false, error: NOT_FOUND };
    }
  }
}

// original 是编辑器打开时的文档, document 是编辑结果, 都是 EJSON
function editDiff(original: unknown, document: unknown): DocumentDiff {
  return diffDocuments(
    convertEjsonToBson(original) as Record<string, unknown>,
    convertEjsonToBson(document) as Record<string, unknown>,
  );
}

const COUNT_TIMEOUT_MS = 15_000;

// 浏览器的总数: 空 filter 用 estimatedDocumentCount (读集合元数据, 不扫表), 否则 countDocuments.
// 带服务端超时; 失败或超时回 null (总数未知), 不影响文档展示
function browserCount(mongo: MongoDriver, database: string, collection: string, filter: Document): Promise<number | null> {
  const options = { maxTimeMS: COUNT_TIMEOUT_MS };
  const counting = Object.keys(filter).length === 0
    ? mongo.estimatedCount(database, collection, options)
    : mongo.count(database, collection, filter, options);
  return counting.catch(() => null);
}

// 空串当 {}; 出错时标明是哪个输入框, 位置是用户原文的行列
function parseShell(label: string, text: string): unknown {
  if (!text.trim()) { return {}; }
  try {
    return parseShellJson(text);
  } catch (e) {
    throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// $match / $sort / $project, 空串与 {} 不生成 stage.
// $project 在 $sort 后: sort 可能依赖被 projection 排除的字段
function buildExportPipeline(
  filter: string,
  sort: string,
  projection?: string
): unknown[] {
  const pipeline: unknown[] = [];

  const trimmedFilter = filter.trim();
  if (trimmedFilter && trimmedFilter !== '{}') {
    pipeline.push({ $match: parseShell('Filter', filter) });
  }

  const trimmedSort = sort.trim();
  if (trimmedSort && trimmedSort !== '{}') {
    pipeline.push({ $sort: parseShell('Sort', sort) });
  }

  const trimmedProjection = projection?.trim() ?? '';
  if (trimmedProjection && trimmedProjection !== '{}') {
    pipeline.push({ $project: parseShell('Projection', projection ?? '') });
  }

  return pipeline;
}

// 浏览器的一页: 导出 pipeline 之后接 $skip / $limit
function buildAggregatePipeline(
  filter: string,
  sort: string,
  projection: string | undefined,
  skip: number,
  limit: number
): unknown[] {
  return [...buildExportPipeline(filter, sort, projection), ...(skip > 0 ? [{ $skip: skip }] : []), { $limit: limit }];
}
