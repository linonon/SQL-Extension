export interface MongoCommand {
  readonly collection: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

const SUPPORTED_METHODS = new Set([
  'find',
  'findOne',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'aggregate',
  'countDocuments',
]);

// 匹配 db.<collection>.<method>(...)
// collection 用贪婪 .+ 以支持含 . 和 - 的合法 Mongo 集合名 (如 my-app.events);
// 贪婪回溯到最后一个 .<method>( 处切分. 允许末尾分号和空白.
const QUERY_PATTERN = /^\s*db\.(.+)\.(\w+)\s*\(([\s\S]*)\)\s*;?\s*$/;

export function parseMongoQuery(input: string): MongoCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty query');
  }

  const match = trimmed.match(QUERY_PATTERN);
  if (!match) {
    throw new Error(`Invalid mongo query syntax. Expected: db.<collection>.<method>(...)`);
  }

  const [, collection, method, argsStr] = match;

  if (!SUPPORTED_METHODS.has(method)) {
    throw new Error(
      `Unsupported method: ${method}. Supported: ${[...SUPPORTED_METHODS].join(', ')}`
    );
  }

  let args: unknown[];
  const trimmedArgs = argsStr.trim();
  if (trimmedArgs === '') {
    args = [];
  } else {
    try {
      args = JSON.parse(`[${trimmedArgs}]`);
    } catch {
      throw new Error(`Failed to parse arguments: ${trimmedArgs}`);
    }
  }

  return { collection, method, args };
}
