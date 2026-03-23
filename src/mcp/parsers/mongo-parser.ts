export const READ_METHODS = ['find', 'aggregate', 'countDocuments'] as const;
export const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'aggregate', 'createIndex', 'dropIndex',
] as const;

const ALL_METHODS = new Set([...READ_METHODS, ...WRITE_METHODS]);

export interface MongoQueryParams {
  collection: string;
  method: string;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  projection?: Record<string, number>;
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

  return {
    collection,
    method,
    filter: parsed.filter as Record<string, unknown> | undefined,
    pipeline: parsed.pipeline as Record<string, unknown>[] | undefined,
    projection: parsed.projection as Record<string, number> | undefined,
    limit: parsed.limit as number | undefined,
    document: parsed.document as Record<string, unknown> | undefined,
    documents: parsed.documents as Record<string, unknown>[] | undefined,
    update: parsed.update as Record<string, unknown> | undefined,
    keys: parsed.keys as Record<string, number> | undefined,
    options: parsed.options as Record<string, unknown> | undefined,
    indexName: parsed.indexName as string | undefined,
  };
}
