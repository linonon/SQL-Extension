const dialectMap: Record<string, 'mysql' | 'postgresql'> = {
  mysql: 'mysql',
  postgresql: 'postgresql',
};

export async function formatSql(sql: string, driverType?: string): Promise<string> {
  if (driverType === 'mongodb') {
    return formatMongoQuery(sql);
  }
  const { format } = await import('sql-formatter');
  return format(sql, {
    language: dialectMap[driverType ?? ''] ?? 'sql',
    tabWidth: 2,
    keywordCase: 'upper',
  });
}

// mongo shell 语法: db.<collection>.<method>(<args>)
// 策略: 短于 80 字符保持单行, 否则每个 arg 缩进 2 格换行
const MONGO_QUERY_RE = /^(db\.[\w$]+\.\w+)\s*\(([\s\S]*)\)\s*;?\s*$/;
const MAX_SINGLE_LINE = 80;

export function formatMongoQuery(query: string): string {
  const match = query.trim().match(MONGO_QUERY_RE);
  if (!match) {
    return query;
  }

  const [, methodCall, argsStr] = match;
  const trimmedArgs = argsStr.trim();

  // 无参数: db.users.countDocuments()
  if (!trimmedArgs) {
    return `${methodCall}()`;
  }

  let parsed: unknown[];
  try {
    parsed = JSON.parse(`[${trimmedArgs}]`);
  } catch {
    return query;
  }

  // 尝试单行: 总长度 <= 80 就不换行
  const compactArgs = parsed.map((a) => JSON.stringify(a)).join(', ');
  const singleLine = `${methodCall}(${compactArgs})`;
  if (singleLine.length <= MAX_SINGLE_LINE) {
    return singleLine;
  }

  // 多行: 每个 arg 用 2 格缩进
  const formattedArgs = parsed
    .map((a) => indent(JSON.stringify(a, null, 2), 2))
    .join(',\n');
  return `${methodCall}(\n${formattedArgs}\n)`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}
