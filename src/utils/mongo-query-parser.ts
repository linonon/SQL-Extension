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
// collection 用合法 Mongo 集合名字符集 [\w$.-] (支持 my-app.events 这类含 . 和 - 的名字),
// 而非贪婪 .+ — 后者会回溯进 args (如值里含 "a.b(c)") 而错误切分 method.
// 允许末尾分号和空白.
const QUERY_PATTERN = /^\s*db\.([A-Za-z_$][\w$.-]*)\.(\w+)\s*\(([\s\S]*)\)\s*;?\s*$/;

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
