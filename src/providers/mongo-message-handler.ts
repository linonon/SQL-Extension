import type { WebviewMessage } from '../types/messages.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { MongoDriver } from '../drivers/mongo-driver.js';
import { convertShellToJson } from '../utils/mongo-shell-to-json.js';

export async function handleMongoMessage(
  message: WebviewMessage,
  driver: IDatabaseDriver,
  post: (msg: unknown) => void
): Promise<boolean> {
  switch (message.type) {
    case 'mongoListDatabases': {
      const databases = await driver.listDatabases();
      post({ type: 'mongoDatabaseList', databases });
      return true;
    }

    case 'mongoListAllCollections': {
      const databases = await driver.listDatabases();

      // 并行获取所有 database 的 collections, 总耗时从 N×T 降至 max(T)
      const results = await Promise.allSettled(
        databases.map((db) => driver.listTables(db))
      );

      const all: { database: string; name: string; count: number }[] = [];
      for (let i = 0; i < databases.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          for (const t of r.value) {
            all.push({ database: databases[i], name: t.name, count: t.rowCount ?? 0 });
          }
        }
        // rejected: 跳过无权限或报错的 database, 与原行为一致
      }

      post({ type: 'mongoAllCollectionList', collections: all });
      return true;
    }

    case 'mongoListCollections': {
      const tables = await driver.listTables(message.database);
      const collections = tables.map((t) => ({ name: t.name, count: t.rowCount ?? 0 }));
      post({ type: 'mongoCollectionList', collections });
      return true;
    }

    case 'mongoFindDocuments': {
      const { database, collection, filter, sort, projection, skip, limit } = message;
      try {
        const pipeline = buildAggregatePipeline(filter, sort, projection, skip, limit);
        const countFilter = filter.trim() ? convertShellToJson(filter.trim()) : '{}';
        const countQuery = `db.${collection}.countDocuments(${countFilter})`;

        const mongo = driver as unknown as MongoDriver;
        const [docsResult, countResult] = await Promise.all([
          mongo.findDocumentsForBrowser(database, collection, pipeline),
          driver.executeCancellable(countQuery, undefined, database).promise,
        ]);

        const total = countResult.rows.length > 0
          ? Number((countResult.rows[0] as Record<string, unknown>).count ?? 0)
          : 0;

        post({
          type: 'mongoDocumentList',
          columns: docsResult.columns,
          rows: docsResult.rows,
          total,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoDocumentList', columns: [], rows: [], total: 0, error: errorMsg });
      }
      return true;
    }

    case 'mongoInsertDocument': {
      const { database, collection, document } = message;
      try {
        const query = `db.${collection}.insertOne(${JSON.stringify(document)})`;
        await driver.executeCancellable(query, undefined, database).promise;
        post({ type: 'mongoOperationResult', success: true });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoOperationResult', success: false, error: errorMsg });
      }
      return true;
    }

    case 'mongoUpdateDocument': {
      const { database, collection, id, document } = message;
      try {
        const query = `db.${collection}.updateOne({"_id":"${id}"},{"$set":${JSON.stringify(document)}})`;
        await driver.executeCancellable(query, undefined, database).promise;
        post({ type: 'mongoOperationResult', success: true });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoOperationResult', success: false, error: errorMsg });
      }
      return true;
    }

    case 'mongoDeleteDocument': {
      const { database, collection, id } = message;
      try {
        const query = `db.${collection}.deleteOne({"_id":"${id}"})`;
        await driver.executeCancellable(query, undefined, database).promise;
        post({ type: 'mongoOperationResult', success: true });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoOperationResult', success: false, error: errorMsg });
      }
      return true;
    }

    case 'mongoCountDocuments': {
      const { database, collection, filter } = message;
      try {
        const countFilter = filter.trim() ? convertShellToJson(filter.trim()) : '{}';
        const countQuery = `db.${collection}.countDocuments(${countFilter})`;
        const result = await driver.executeCancellable(countQuery, undefined, database).promise;
        const total = result.rows.length > 0
          ? Number((result.rows[0] as Record<string, unknown>).count ?? 0)
          : 0;
        post({ type: 'mongoDocumentList', columns: [], rows: [], total });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoDocumentList', columns: [], rows: [], total: 0, error: errorMsg });
      }
      return true;
    }

    case 'mongoCreateCollection': {
      const { database, collection } = message as { database: string; collection: string };
      try {
        const mongo = driver as unknown as MongoDriver;
        await mongo.createCollection(database, collection);
        post({ type: 'mongoCollectionCreated', success: true });
        await postRefreshedCollections(driver, post);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoCollectionCreated', success: false, error: errorMsg });
      }
      return true;
    }

    case 'mongoDropCollection': {
      const { database, collection } = message as { database: string; collection: string };
      try {
        const mongo = driver as unknown as MongoDriver;
        await mongo.dropCollection(database, collection);
        post({ type: 'mongoCollectionDropped', success: true, database, collection });
        await postRefreshedCollections(driver, post);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        post({ type: 'mongoCollectionDropped', success: false, error: errorMsg });
      }
      return true;
    }

    default:
      return false;
  }
}

async function postRefreshedCollections(
  driver: IDatabaseDriver,
  post: (msg: unknown) => void
): Promise<void> {
  const databases = await driver.listDatabases();
  const results = await Promise.allSettled(
    databases.map((db) => driver.listTables(db))
  );
  const all: { database: string; name: string; count: number }[] = [];
  for (let i = 0; i < databases.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      for (const t of r.value) {
        all.push({ database: databases[i], name: t.name, count: t.rowCount ?? 0 });
      }
    }
  }
  post({ type: 'mongoAllCollectionList', collections: all });
}

export function buildExportPipeline(
  filter: string,
  sort: string,
  projection?: string
): unknown[] {
  const pipeline: unknown[] = [];

  const trimmedFilter = filter.trim();
  if (trimmedFilter && trimmedFilter !== '{}') {
    const parsed = JSON.parse(convertShellToJson(trimmedFilter));
    pipeline.push({ $match: parsed });
  }

  const trimmedSort = sort.trim();
  if (trimmedSort && trimmedSort !== '{}') {
    const parsed = JSON.parse(convertShellToJson(trimmedSort));
    pipeline.push({ $sort: parsed });
  }

  const trimmedProjection = projection?.trim() ?? '';
  if (trimmedProjection && trimmedProjection !== '{}') {
    const parsed = JSON.parse(convertShellToJson(trimmedProjection));
    pipeline.push({ $project: parsed });
  }

  return pipeline;
}

function buildAggregatePipeline(
  filter: string,
  sort: string,
  projection: string | undefined,
  skip: number,
  limit: number
): unknown[] {
  const pipeline: unknown[] = [];

  const trimmedFilter = filter.trim();
  if (trimmedFilter && trimmedFilter !== '{}') {
    const parsed = JSON.parse(convertShellToJson(trimmedFilter));
    pipeline.push({ $match: parsed });
  }

  const trimmedSort = sort.trim();
  if (trimmedSort && trimmedSort !== '{}') {
    const parsed = JSON.parse(convertShellToJson(trimmedSort));
    pipeline.push({ $sort: parsed });
  }

  // $project 在 $sort 后, $skip 前: sort 可能依赖被 projection 排除的字段
  const trimmedProjection = projection?.trim() ?? '';
  if (trimmedProjection && trimmedProjection !== '{}') {
    const parsed = JSON.parse(convertShellToJson(trimmedProjection));
    pipeline.push({ $project: parsed });
  }

  if (skip > 0) {
    pipeline.push({ $skip: skip });
  }

  pipeline.push({ $limit: limit });

  return pipeline;
}
