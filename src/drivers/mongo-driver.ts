import {
  BSON, MongoClient, ObjectId,
  type AggregateOptions, type CollectionInfo, type CountDocumentsOptions, type CreateIndexesOptions,
  type Document, type EstimatedDocumentCountOptions, type FindOptions, type IndexSpecification, type Sort,
} from 'mongodb';
import { access, constants as fsConstants, open, rename, rm } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline as pipeStreams } from 'stream/promises';
import type { ConnectionConfig } from '../types/connection.js';
import type { ColumnInfo, TableInfo } from '../types/query.js';
import { convertEjsonToBson, assertValidBson } from '../utils/mongo-shell-to-json.js';
import { summarizeExplain, type ExplainSummary } from '../utils/mongo-explain.js';

// 用 mongodb 自带的 bson 实例: 单独 import 'bson' 可能加载第二份, instanceof 跨实例不成立
const { EJSON } = BSON;

// 浏览查询的服务端超时. 导出不设: 整表导出可能合法地超过它
export const BROWSE_TIMEOUT_MS = 60_000;

// MongoDB driver: 不是 SQL driver (不实现 IDatabaseDriver), 集合名 / filter / 文档都作为数据传入.
export class MongoDriver {
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
      const info = await db.listCollections<CollectionInfo>({ name: collection }).next();
      if (info?.options?.validator) {
        return JSON.stringify(info.options.validator, null, 2);
      }
    } catch {
      // intentionally swallowed: schema validator is optional
    }
    return `// Collection "${collection}" has no schema validator defined.`;
  }

  // explain 浏览查询的 find (filter + sort 决定索引选择), 返回精简摘要供 UI 展示索引使用情况.
  // 只取 queryPlanner (选计划不执行): executionStats 会把查询跑满, 大集合上就是一次全表扫描
  async explainFind(
    database: string,
    collection: string,
    filter: Record<string, unknown>,
    sort?: Record<string, unknown>,
  ): Promise<ExplainSummary> {
    this.assertConnected();
    const coll = this.client!.db(database).collection(collection);
    const cursor = coll.find(userFilter(filter));
    if (sort && Object.keys(sort).length > 0) {
      cursor.sort(convertEjsonToBson(sort) as Sort);
    }
    const raw = await cursor.explain('queryPlanner');
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

  // 流式导出为 canonical EJSON 写入 filePath, 返回条数: 读时 promoteValues:false 保住 Int32 / Long / Double, 写出时带类型标记.
  // jsonl 时每行一个文档, 否则整体一个 JSON 数组 (每个文档一行). 每 1000 条回调一次 onProgress.
  // 目标打不开 (只读 / 目录不存在) 时直接抛出, 不动原文件; 打开后出错或 signal 取消时删掉写了一半的文件再抛出
  async exportDocuments(
    database: string,
    collection: string,
    pipeline: unknown[],
    filePath: string,
    jsonl: boolean,
    options: { signal?: AbortSignal; onProgress?: (count: number) => void } = {},
  ): Promise<number> {
    this.assertConnected();
    // 还原 pipeline 内 EJSON 标记为 BSON, 否则 $match 过滤 (ObjectId/$date 等) 当字面子文档恒不命中,
    // 导致导出空集或错集 (与 findDocumentsForBrowser 对齐).
    const bsonPipeline = convertEjsonToBson(pipeline) as Document[];
    const coll = this.client!.db(database).collection(collection);
    // 已有目标文件不可写时直接报错; 先写同目录的临时文件, 成功后 rename 覆盖目标,
    // 取消或失败只删临时文件, 用户选中要覆盖的旧文件保持原样
    await access(filePath, fsConstants.W_OK).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') { throw err; }
    });
    const tmpPath = `${filePath}.partial`;
    const out = await open(tmpPath, 'w');
    let count = 0;
    async function* chunks(): AsyncGenerator<string> {
      // signal 也交给游标: 取消时中断进行中的 getMore (大 $sort 可能很久才出第一批), 否则要等它返回才停
      const cursor = coll.aggregate(bsonPipeline, { promoteValues: false, allowDiskUse: true, signal: options.signal });
      if (!jsonl) { yield '['; }
      for await (const doc of cursor) {
        const text = EJSON.stringify(doc, { relaxed: false });
        yield jsonl ? `${text}\n` : `${count === 0 ? '\n' : ',\n'}${text}`;
        if (++count % 1000 === 0) { options.onProgress?.(count); }
      }
      if (!jsonl) { yield count === 0 ? ']\n' : '\n]\n'; }
    }
    try {
      // pipeline 按 backpressure 拉游标 (写入跟不上时暂停读取); 出错或取消时销毁两端, 提前退出的 for await 关闭游标
      await pipeStreams(Readable.from(chunks()), out.createWriteStream(), { signal: options.signal });
      await rename(tmpPath, filePath);
    } catch (err) {
      // 清理失败不掩盖原错误
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    return count;
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
    // allowDiskUse: 6.0 以下的大 $sort / 深页 $skip 不受 100MB 内存上限限制
    const docs = await this.client!.db(database).collection(collection)
      .aggregate(bsonPipeline, { maxTimeMS: BROWSE_TIMEOUT_MS, allowDiskUse: true }).toArray();
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
    // canonical 解析 (relaxed:false): 裸数字也按 Int32 / Long / Double 落库, 带类型标记的值原样还原
    if (trimmed.startsWith('[')) {
      docs = EJSON.parse(trimmed, { relaxed: false }) as Record<string, unknown>[];
    } else {
      docs = trimmed.split('\n')
        .filter((l) => l.trim())
        .map((line) => EJSON.parse(line, { relaxed: false }) as Record<string, unknown>);
    }

    // EJSON.parse 不校验 $date 合法性 (非法日期产出 Invalid Date -> 落库变 epoch 0),
    // 与编辑/CRUD 路径一致: 写库前显式拒绝非法值, 不静默污染.
    assertValidBson(docs);

    let inserted = 0;
    const BATCH = 500;
    const coll = this.client!.db(database).collection(collection);
    for (let i = 0; i < docs.length; i += BATCH) {
      try {
        inserted += (await coll.insertMany(docs.slice(i, i + BATCH))).insertedCount;
      } catch (err) {
        // ordered insertMany 停在出错的那条: 之前各批和本批出错前的文档已落库 (本批条数见 MongoBulkWriteError.insertedCount)
        const batchInserted = (err as { insertedCount?: unknown } | null)?.insertedCount;
        inserted += typeof batchInserted === 'number' ? batchInserted : 0;
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Imported ${inserted} of ${docs.length} documents before the error: ${reason}`);
      }
    }
    return inserted;
  }

  // --- 结构化集合操作 (浏览器 handler 与 MCP 路由共用) ---
  // 本组方法收的 filter 与文档须已是 BSON 值 (EJSON 由调用方经 convertEjsonToBson / userFilter 还原)

  find(database: string, collection: string, filter: Document, options: FindOptions): Promise<Document[]> {
    return this.coll(database, collection).find(filter, options).toArray();
  }

  aggregate(database: string, collection: string, pipeline: Document[], options: AggregateOptions = {}): Promise<Document[]> {
    return this.coll(database, collection).aggregate(pipeline, options).toArray();
  }

  count(database: string, collection: string, filter: Document, options: CountDocumentsOptions = {}): Promise<number> {
    return this.coll(database, collection).countDocuments(filter, options);
  }

  // 读集合元数据的近似总数, 不扫文档
  estimatedCount(database: string, collection: string, options: EstimatedDocumentCountOptions = {}): Promise<number> {
    return this.coll(database, collection).estimatedDocumentCount(options);
  }

  // 按库内原 BSON 类型取单个文档 (promoteValues:false: Int32 / Long / Double 不转成 JS number), 供写回时沿用类型
  findOneTyped(database: string, collection: string, filter: Document): Promise<Document | null> {
    return this.coll(database, collection).findOne(filter, { promoteValues: false });
  }

  async insertOne(database: string, collection: string, doc: Document): Promise<void> {
    await this.coll(database, collection).insertOne(doc);
  }

  async insertMany(database: string, collection: string, docs: Document[]): Promise<number> {
    return (await this.coll(database, collection).insertMany(docs)).insertedCount;
  }

  // 返回 matchedCount (是否命中): 命中但值未变也算成功
  async updateOne(database: string, collection: string, filter: Document, update: Document): Promise<number> {
    return (await this.coll(database, collection).updateOne(filter, update)).matchedCount;
  }

  async updateMany(database: string, collection: string, filter: Document, update: Document): Promise<number> {
    return (await this.coll(database, collection).updateMany(filter, update)).modifiedCount;
  }

  async deleteOne(database: string, collection: string, filter: Document): Promise<number> {
    return (await this.coll(database, collection).deleteOne(filter)).deletedCount;
  }

  async deleteMany(database: string, collection: string, filter: Document): Promise<number> {
    return (await this.coll(database, collection).deleteMany(filter)).deletedCount;
  }

  createIndex(database: string, collection: string, keys: IndexSpecification, options: CreateIndexesOptions): Promise<string> {
    return this.coll(database, collection).createIndex(keys, options);
  }

  async dropIndex(database: string, collection: string, indexName: string): Promise<void> {
    await this.coll(database, collection).dropIndex(indexName);
  }

  private coll(database: string, collection: string) {
    this.assertConnected();
    return this.client!.db(database).collection(collection);
  }

  private assertConnected(): void {
    if (!this.client) {
      throw new Error('MongoDB driver is not connected');
    }
  }
}

// --- URI 构建 ---

export function buildUri(config: ConnectionConfig & { readonly password: string }): string {
  const { host, port, username, password, database } = config;
  let auth = '';
  if (username) {
    auth = password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(username)}@`;
  }
  const dbPart = database ? `/${database}` : '';
  const params: string[] = [];
  if (config.authSource) {
    params.push(`authSource=${encodeURIComponent(config.authSource)}`);
  }
  // SSH tunnel 只暴露一个本地端口: 不直连的话 driver 会按副本集成员的内网地址做拓扑发现, 必然超时
  if (config.ssh?.enabled) {
    params.push('directConnection=true');
  }
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return `mongodb://${auth}${host}:${port}${dbPart}${query}`;
}

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

// 用户手写的 filter (浏览器输入框 / MCP 查询): 还原 EJSON 标记, 并把 _id 上下文里的裸 24-hex 串转 ObjectId.
// 按真实 _id 定位文档的写路径不用它: 恰好 24-hex 的字符串 _id 会被误转而匹配不上.
export function userFilter(filter: unknown): Document {
  return autoConvertIds(convertEjsonToBson(filter ?? {}) as Record<string, unknown>);
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
// 供文档浏览器渲染折叠树用.
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
