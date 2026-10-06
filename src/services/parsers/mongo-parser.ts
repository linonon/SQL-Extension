export const READ_METHODS = ['find', 'aggregate', 'countDocuments'] as const;
export const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'aggregate', 'createIndex', 'dropIndex',
] as const;

const ALL_METHODS = new Set<string>([...READ_METHODS, ...WRITE_METHODS]);

// 每个 method 认的字段 (collection / method 之外). 其余字段一律报错, 不静默忽略
const METHOD_FIELDS: Record<(typeof READ_METHODS)[number] | (typeof WRITE_METHODS)[number], readonly string[]> = {
  find: ['filter', 'projection', 'sort', 'skip', 'limit'],
  aggregate: ['pipeline', 'limit'],
  countDocuments: ['filter'],
  insertOne: ['document'],
  insertMany: ['documents'],
  updateOne: ['filter', 'update'],
  updateMany: ['filter', 'update'],
  deleteOne: ['filter'],
  deleteMany: ['filter'],
  createIndex: ['keys', 'options'],
  dropIndex: ['indexName'],
};

export interface MongoQueryParams {
  collection: string;
  method: string;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  projection?: Record<string, number>;
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  update?: Record<string, unknown>;
  keys?: Record<string, number>;
  options?: Record<string, unknown>;
  indexName?: string;
}

export function parseMongoQuery(query: string): MongoQueryParams {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error(
      `Invalid JSON in query. Expected format: {"collection":"...","method":"find","filter":{}}`,
    );
  }

  const collection = parsed.collection as string | undefined;
  const method = parsed.method as string | undefined;

  if (!collection || typeof collection !== 'string') {
    throw new Error('Missing required field: collection');
  }
  if (!method || typeof method !== 'string') {
    throw new Error('Missing required field: method');
  }
  if (!ALL_METHODS.has(method)) {
    throw new Error(
      `Unknown method '${method}'. Allowed: ${[...ALL_METHODS].join(', ')}`,
    );
  }
  const allowed = METHOD_FIELDS[method as keyof typeof METHOD_FIELDS];
  const unknown = Object.keys(parsed).filter((k) => k !== 'collection' && k !== 'method' && !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown field(s) for ${method}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }

  return {
    collection,
    method,
    filter: parsed.filter as Record<string, unknown> | undefined,
    pipeline: parsed.pipeline as Record<string, unknown>[] | undefined,
    projection: parsed.projection as Record<string, number> | undefined,
    sort: parsed.sort as Record<string, 1 | -1> | undefined,
    skip: parsed.skip as number | undefined,
    limit: parsed.limit as number | undefined,
    document: parsed.document as Record<string, unknown> | undefined,
    documents: parsed.documents as Record<string, unknown>[] | undefined,
    update: parsed.update as Record<string, unknown> | undefined,
    keys: parsed.keys as Record<string, number> | undefined,
    options: parsed.options as Record<string, unknown> | undefined,
    indexName: parsed.indexName as string | undefined,
  };
}
