import { MongoClient, ObjectId } from 'mongodb';
import { EJSON } from 'bson';
import type { ConnectionConfig } from '../types/connection.js';
import type { IDatabaseDriver } from '../types/driver.js';
import type { ColumnInfo, DetailedColumnInfo, QueryResult, TableInfo } from '../types/query.js';
import { parseMongoQuery } from '../utils/mongo-query-parser.js';
import { convertEjsonToBson, assertValidBson } from '../utils/mongo-shell-to-json.js';
import { summarizeExplain, type ExplainSummary } from '../utils/mongo-explain.js';

export class MongoDriver implements IDatabaseDriver {
  readonly driverType = 'mongodb';
  private client: MongoClient | null = null;
  private configDatabase = '';

  async connect(config: ConnectionConfig & { readonly password: string }): Promise<void> {
    this.configDatabase = config.database ?? '';
    const uri = buildUri(config);
    this.client = new MongoClient(uri, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
    await this.client.connect();
    // ping 验证连接
    await this.client.db('admin').command({ ping: 1 });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async ping(): Promise<void> {
    this.assertConnected();
    await this.client!.db('admin').command({ ping: 1 });
  }

  async listDatabases(): Promise<string[]> {
    this.assertConnected();
    try {
      const result = await this.client!.db('admin').admin().listDatabases();
      return result.databases.map((d) => d.name);
    } catch {
      // 无 admin 权限时 (远端受限用户), 回退到配置的数据库
      return this.configDatabase ? [this.configDatabase] : [];
    }
  }

  async listTables(database: string): Promise<TableInfo[]> {
    this.assertConnected();
    const db = this.client!.db(database);
    const collections = await db.listCollections().toArray();
    const filtered = collections.filter((c) => !c.name.startsWith('system.'));

    // 并行获取所有 collection 的 count, 单次 RTT 代替串行 N 次
    const counts = await Promise.allSettled(
      filtered.map((col) => db.collection(col.name).estimatedDocumentCount())
    );

    const tables: TableInfo[] = filtered.map((col, i) => ({
      name: col.name,
      schema: database,
      rowCount: counts[i].status === 'fulfilled' ? (counts[i] as PromiseFulfilledResult<number>).value : 0,
    }));

    return tables.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listColumns(database: string, collection: string): Promise<ColumnInfo[]> {
    this.assertConnected();
    const coll = this.client!.db(database).collection(collection);
    const docs = await coll.find({}).limit(100).toArray();
    return inferSchema(docs);
  }

  async getTableDDL(database: string, collection: string): Promise<string> {
    this.assertConnected();
    const db = this.client!.db(database);
    try {
      const info = await db.listCollections({ name: collection }).next();
      if (info?.options?.validator) {
        return JSON.stringify(info.options.validator, null, 2);
      }
    } catch {
      // intentionally swallowed: schema validator is optional
    }
    return `// Collection "${collection}" has no schema validator defined.`;
  }

  async getDetailedColumns(database: string, collection: string): Promise<DetailedColumnInfo[]> {
    const columns = await this.listColumns(database, collection);
    return columns.map((c) => ({ ...c, comment: '' }));
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.executeCancellable(sql, params).promise;
  }

  executeCancellable(
    query: string,
    _params?: unknown[],
    database?: string,
    options?: { readonly autoConvertIds?: boolean }
  ): { promise: Promise<QueryResult>; cancel: () => void } {
    let cancelled = false;

    const promise = (async (): Promise<QueryResult> => {
      const cmd = parseMongoQuery(query);
      const dbName = database ?? 'test';
      const start = Date.now();

      const result = await this.dispatchToCollection(dbName, cmd.collection, cmd.method, cmd.args, {
        autoConvertIds: options?.autoConvertIds,
      });

      if (cancelled) {
        return { columns: [], rows: [], affectedRows: 0, executionTime: 0 };
      }

      const executionTime = Date.now() - start;

      if ('affectedRows' in result) {
        return { columns: [], rows: [], affectedRows: result.affectedRows, executionTime };
      }

      const docs = result.docs;
      const rows = docs.map(flattenDocument);
      const columns = inferSchema(docs);
      return { columns, rows, affectedRows: 0, executionTime };
    })();

    const cancel = () => { cancelled = true; };

    return { promise, cancel };
  }

  // explain 浏览查询的 find (filter + sort 决定索引选择), 返回精简摘要供 UI 展示索引使用情况.
  async explainFind(
    database: string,
    collection: string,
    filter: Record<string, unknown>,
    sort?: Record<string, unknown>,
  ): Promise<ExplainSummary> {
    this.assertConnected();
    const coll = this.client!.db(database).collection(collection);
    const f = autoConvertIds(convertEjsonToBson(filter ?? {}) as Record<string, unknown>);
    const cursor = coll.find(f);
    if (sort && Object.keys(sort).length > 0) {
      cursor.sort(convertEjsonToBson(sort) as Record<string, number>);
    }
    const raw = await cursor.explain('executionStats');
    return summarizeExplain(raw);
  }

  async createCollection(database: string, collectionName: string): Promise<void> {
    this.assertConnected();
    const db = this.client!.db(database);
    await db.createCollection(collectionName);
  }

  async dropCollection(database: string, collectionName: string): Promise<void> {
    this.assertConnected();
    const db = this.client!.db(database);
    await db.dropCollection(collectionName);
  }

  async exportDocuments(
    database: string,
    collection: string,
    pipeline: unknown[]
  ): Promise<{ json: string; count: number }> {
    this.assertConnected();
    // 还原 pipeline 内 EJSON 标记为 BSON, 否则 $match 过滤 (ObjectId/$date 等) 当字面子文档恒不命中,
    // 导致导出空集或错集 (与 findDocumentsForBrowser 对齐).
    const bsonPipeline = convertEjsonToBson(pipeline) as unknown[];
    const docs = await this.client!.db(database).collection(collection).aggregate(bsonPipeline).toArray();
    const json = EJSON.stringify(docs, undefined, 2);
    return { json, count: docs.length };
  }

  async findDocumentsForBrowser(
    database: string,
    collection: string,
    pipeline: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; columns: ColumnInfo[] }> {
    this.assertConnected();
    // 还原 pipeline 内的 EJSON 标记 ($oid/$date/$numberLong 等) 为 BSON, 否则按 ObjectId/Long
    // 过滤的 $match 会被当字面子文档匹配而恒不命中 (与 explainFind 对齐).
    // 并对 $match 跑 autoConvertIds: 裸 24-hex 串 _id 自动转 ObjectId, 使浏览结果与 count/explain 一致 (M2/M3).
    const bsonPipeline = (convertEjsonToBson(pipeline) as Record<string, unknown>[]).map((stage) => {
      if (stage !== null && typeof stage === 'object' && '$match' in stage) {
        return { ...stage, $match: autoConvertIds(stage.$match as Record<string, unknown>) };
      }
      return stage;
    });
    const docs = await this.client!.db(database).collection(collection)
      .aggregate(bsonPipeline).toArray();
    return { rows: docs.map(deepFormatDocument), columns: inferSchema(docs) };
  }

  async importDocuments(
    database: string,
    collection: string,
    content: string
  ): Promise<number> {
    this.assertConnected();
    const trimmed = content.trim();
    let docs: Record<string, unknown>[];
    if (trimmed.startsWith('[')) {
      docs = EJSON.parse(trimmed) as Record<string, unknown>[];
    } else {
      docs = trimmed.split('\n')
        .filter((l) => l.trim())
        .map((line) => EJSON.parse(line) as Record<string, unknown>);
    }

    // EJSON.parse 不校验 $date 合法性 (非法日期产出 Invalid Date -> 落库变 epoch 0),
    // 与编辑/CRUD 路径一致: 写库前显式拒绝非法值, 不静默污染.
    assertValidBson(docs);

    let inserted = 0;
    const BATCH = 500;
    const coll = this.client!.db(database).collection(collection);
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH);
      const result = await coll.insertMany(batch);
      inserted += result.insertedCount;
    }
    return inserted;
  }

  async dispatchToCollection(
    database: string,
    collection: string,
    method: string,
    args: readonly unknown[],
    options?: { limit?: number; autoConvertIds?: boolean },
  ): Promise<DispatchResult> {
    this.assertConnected();
    const coll = this.client!.db(database).collection(collection);
    // 把 filter 还原成 BSON. autoConvertIds (24-hex 字符串 -> ObjectId) 是查询编辑器手敲裸字符串的
    // 便利; CRUD 路径 (filter 经 buildIdFilter 已显式带类型) 传 autoConvertIds:false 跳过它,
    // 否则真字符串 _id (恰好 24-hex) 会被误转成 ObjectId 而匹配不上.
    const ac = options?.autoConvertIds !== false;
    const toFilter = (a: unknown): Record<string, unknown> => {
      const f = convertEjsonToBson(a ?? {}) as Record<string, unknown>;
      return ac ? autoConvertIds(f) : f;
    };
    switch (method) {
      case 'find': {
        const filter = toFilter(args[0]);
        const opts = (args[1] ?? {}) as Record<string, unknown>;
        const limit = options?.limit ?? 1000;
        const docs = await coll.find(filter, { projection: opts.projection }).limit(limit).toArray();
        return { docs };
      }
      case 'findOne': {
        const filter = toFilter(args[0]);
        const doc = await coll.findOne(filter);
        return { docs: doc ? [doc] : [] };
      }
      case 'insertOne': {
        const doc = convertEjsonToBson(args[0] ?? {}) as Record<string, unknown>;
        await coll.insertOne(doc);
        return { affectedRows: 1 };
      }
      case 'insertMany': {
        const docs = (convertEjsonToBson(args[0] ?? []) as unknown[]);
        const result = await coll.insertMany(docs);
        return { affectedRows: result.insertedCount };
      }
      case 'updateOne': {
        // affectedRows 取 matchedCount (是否命中): 无改动的局部更新不应误判为"未匹配".
        const filter = toFilter(args[0]);
        const update = convertEjsonToBson(args[1] as Record<string, unknown>) as Record<string, unknown>;
        const result = await coll.updateOne(filter, update);
        return { affectedRows: result.matchedCount };
      }
      case 'updateMany': {
        const filter = toFilter(args[0]);
        // 与 updateOne 一致还原 EJSON 类型 ($oid/$date/$numberLong 等), 否则写入畸形子文档
        const update = convertEjsonToBson(args[1] as Record<string, unknown>) as Record<string, unknown>;
        const result = await coll.updateMany(filter, update);
        return { affectedRows: result.modifiedCount };
      }
      case 'replaceOne': {
        // 整文档替换: 替换文档不含 _id, _id 由 filter 保持; 不在 replacement 内的字段被移除.
        // affectedRows 取 matchedCount (是否命中), 而非 modifiedCount, 以便无改动的保存仍判定为成功.
        const filter = toFilter(args[0]);
        const replacement = convertEjsonToBson(args[1] ?? {}) as Record<string, unknown>;
        const result = await coll.replaceOne(filter, replacement);
        return { affectedRows: result.matchedCount };
      }
      case 'deleteOne': {
        const filter = toFilter(args[0]);
        const result = await coll.deleteOne(filter);
        return { affectedRows: result.deletedCount };
      }
      case 'deleteMany': {
        const filter = toFilter(args[0]);
        const result = await coll.deleteMany(filter);
        return { affectedRows: result.deletedCount };
      }
      case 'aggregate': {
        const pipeline = convertEjsonToBson(args[0] ?? []) as unknown[];
        let docs = await coll.aggregate(pipeline).toArray();
        if (options?.limit && docs.length > options.limit) {
          docs = docs.slice(0, options.limit);
        }
        return { docs };
      }
      case 'countDocuments': {
        const filter = toFilter(args[0]);
        const count = await coll.countDocuments(filter);
        return { docs: [{ count }] };
      }
      case 'createIndex': {
        const keys = args[0] as Record<string, number>;
        const indexOptions = (args[1] ?? {}) as Record<string, unknown>;
        await coll.createIndex(keys, indexOptions);
        return { affectedRows: 1 };
      }
      case 'dropIndex': {
        const indexName = args[0] as string;
        await coll.dropIndex(indexName);
        return { affectedRows: 1 };
      }
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }

  private assertConnected(): void {
    if (!this.client) {
      throw new Error('MongoDB driver is not connected');
    }
  }
}

// --- URI 构建 ---

function buildUri(config: ConnectionConfig & { readonly password: string }): string {
  const { host, port, username, password, database } = config;
  let auth = '';
  if (username) {
    auth = password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(username)}@`;
  }
  const dbPart = database ? `/${database}` : '';
  const authSource = config.authSource;
  const query = authSource ? `?authSource=${encodeURIComponent(authSource)}` : '';
  return `mongodb://${auth}${host}:${port}${dbPart}${query}`;
}

// --- method 分发 ---

export type DispatchResult =
  | { readonly docs: Record<string, unknown>[] }
  | { readonly affectedRows: number };

// --- ObjectId 自动转换 ---

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const ID_LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

// 把 _id 上下文里的 24-hex 字符串转 ObjectId. 覆盖裸值与 {$in/$nin:[...]} 数组;
// 已是 BSON 实例 (ObjectId/Long 等) 的确定类型原样保留, 不当作 operator 子文档拆解.
function convertIdValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return OBJECT_ID_REGEX.test(value) ? new ObjectId(value) : value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return value; }
  if (value instanceof ObjectId || '_bsontype' in (value as Record<string, unknown>)) { return value; }
  const out: Record<string, unknown> = {};
  for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
    if ((op === '$in' || op === '$nin') && Array.isArray(opVal)) {
      out[op] = opVal.map((el) => (typeof el === 'string' && OBJECT_ID_REGEX.test(el)) ? new ObjectId(el) : el);
    } else {
      out[op] = opVal;
    }
  }
  return out;
}

// 裸字符串 _id 自动转 ObjectId 的便利 (查询/浏览/count/explain 共用单一策略).
// 递归进 $and/$or/$nor 分支与 _id 的 $in/$nin 数组, 否则这些上下文里的 24-hex 串会静默不命中.
function autoConvertIds(filter: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_id') {
      result[key] = convertIdValue(value);
    } else if (ID_LOGICAL_OPS.has(key) && Array.isArray(value)) {
      result[key] = value.map((sub) =>
        (sub !== null && typeof sub === 'object' && !Array.isArray(sub))
          ? autoConvertIds(sub as Record<string, unknown>)
          : sub);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// --- document 扁平化 ---

function flattenDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    result[key] = flattenValue(value);
  }
  return result;
}

function flattenValue(value: unknown): unknown {
  if (value === null || value === undefined) { return null; }
  if (value instanceof ObjectId) { return `ObjectId("${value.toString()}")`; }
  if (value instanceof Date) { return `ISODate("${value.toISOString()}")`; }
  if (Array.isArray(value)) { return JSON.stringify(value.map(flattenValue)); }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('_bsontype' in obj) {
      return bsonToShellTag(obj);
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) { result[k] = flattenValue(v); }
    return JSON.stringify(result);
  }
  return value;
}

// BSON 实例 -> shell-tag 字符串. 未知类型回退 String(value) (展示路径不可抛错, 否则浏览崩溃).
function bsonToShellTag(obj: Record<string, unknown>): string {
  const bt = (obj as { _bsontype: string })._bsontype;
  if (bt === 'Long') { return `NumberLong("${String(obj)}")`; }
  if (bt === 'Int32') { return `NumberInt(${String(obj)})`; }
  if (bt === 'Decimal128') { return `NumberDecimal("${String(obj)}")`; }
  if (bt === 'MinKey') { return 'MinKey()'; }
  if (bt === 'MaxKey') { return 'MaxKey()'; }
  if (bt === 'Binary') {
    // sub_type 4 即 UUID, 用 UUID("...") 展示; 其余 Binary 用 BinData(sub,"base64") 保留原值.
    if ((obj as { sub_type?: number }).sub_type === 4) { return `UUID("${String(obj)}")`; }
    const sub = (obj as { sub_type?: number }).sub_type ?? 0;
    const b64 = (obj as { buffer?: { toString(enc: string): string } }).buffer?.toString('base64') ?? '';
    return `BinData(${sub},"${b64}")`;
  }
  if (bt === 'Timestamp') {
    const ext = (obj as { toExtendedJSON?: () => { $timestamp?: { t: number; i: number } } }).toExtendedJSON?.();
    const ts = ext?.$timestamp ?? { t: 0, i: 0 };
    return `Timestamp(${ts.t},${ts.i})`;
  }
  return String(obj);
}

// deep 格式化: 保留嵌套结构 (object/array 不 JSON.stringify), 叶子 BSON 转 shell-tag 字符串.
// 供文档浏览器渲染折叠树用; flattenValue 仍服务于查询编辑器的扁平表格.
export function deepFormatValue(value: unknown): unknown {
  if (value === null || value === undefined) { return null; }
  if (value instanceof ObjectId) { return `ObjectId("${value.toString()}")`; }
  if (value instanceof Date) { return `ISODate("${value.toISOString()}")`; }
  if (Array.isArray(value)) { return value.map(deepFormatValue); }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('_bsontype' in obj) {
      return bsonToShellTag(obj);
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) { result[k] = deepFormatValue(v); }
    return result;
  }
  return value;
}

export function deepFormatDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    result[key] = deepFormatValue(value);
  }
  return result;
}

// --- schema 推断 ---

function inferSchema(docs: Record<string, unknown>[]): ColumnInfo[] {
  if (docs.length === 0) {
    return [{ name: '_id', dataType: 'ObjectId', nullable: false, isPrimaryKey: true, defaultValue: null, extra: '' }];
  }

  const fieldMap = new Map<string, { types: Set<string>; count: number }>();

  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const entry = fieldMap.get(key);
      const typeName = bsonTypeName(value);
      if (entry) {
        entry.types.add(typeName);
        entry.count++;
      } else {
        fieldMap.set(key, { types: new Set([typeName]), count: 1 });
      }
    }
  }

  const columns: ColumnInfo[] = [];

  // _id 排第一
  const idEntry = fieldMap.get('_id');
  if (idEntry) {
    columns.push({
      name: '_id',
      dataType: [...idEntry.types].join(' | '),
      nullable: false,
      isPrimaryKey: true,
      defaultValue: null,
      extra: '',
    });
    fieldMap.delete('_id');
  }

  for (const [name, entry] of fieldMap) {
    columns.push({
      name,
      dataType: [...entry.types].join(' | '),
      nullable: entry.count < docs.length,
      isPrimaryKey: false,
      defaultValue: null,
      extra: '',
    });
  }

  return columns;
}

function bsonTypeName(value: unknown): string {
  if (value === null || value === undefined) { return 'null'; }
  if (value instanceof ObjectId) { return 'ObjectId'; }
  if (value instanceof Date) { return 'date'; }
  if (Array.isArray(value)) { return 'array'; }
  // 包装类型 (Long/Int32/Decimal128/Binary/Timestamp 等) 报告真实 BSON 类型, 而非笼统 object
  if (value !== null && typeof value === 'object' && '_bsontype' in value) {
    return (value as { _bsontype: string })._bsontype;
  }
  if (typeof value === 'object') { return 'object'; }
  if (typeof value === 'number') { return 'number'; }
  if (typeof value === 'boolean') { return 'boolean'; }
  return 'string';
}
