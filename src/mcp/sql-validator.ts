// readonly SQL 服务端校验
// 只允许 SELECT/SHOW/DESCRIBE/DESC/EXPLAIN/WITH 开头的语句
// 拒绝 SELECT ... INTO (MySQL 文件写入)
// 拒绝多语句 (去掉字符串常量后检查分号)

const ALLOWED_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];

const MAX_LIMIT = 500;

export function isMultiStatement(sql: string): boolean {
  const noStrings = sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  const semiIdx = noStrings.indexOf(';');
  return semiIdx >= 0 && noStrings.slice(semiIdx + 1).trim().length > 0;
}

export function isReadonlySQL(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  if (!ALLOWED_PREFIXES.some(p => trimmed.startsWith(p))) {
    return false;
  }
  // 拒绝 SELECT ... INTO (MySQL 文件写入 / PG INSERT)
  if (trimmed.startsWith('SELECT') && trimmed.includes(' INTO ')) {
    return false;
  }
  // 拒绝多语句: 去掉字符串常量后检查分号
  if (isMultiStatement(sql)) {
    return false;
  }
  return true;
}

// 强制追加或替换 LIMIT, 不超过 MAX_LIMIT
// 返回处理后的 SQL
export function enforceLimit(sql: string, requestedLimit?: number): string {
  const limit = Math.min(requestedLimit ?? MAX_LIMIT, MAX_LIMIT);
  const trimmed = sql.trim().replace(/;$/, '');
  // 匹配已有的 LIMIT 子句 (忽略大小写)
  const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (limitMatch) {
    const existing = parseInt(limitMatch[1], 10);
    if (existing > limit) {
      return trimmed.replace(/\bLIMIT\s+\d+\s*$/i, `LIMIT ${limit}`);
    }
    return trimmed;
  }
  // SHOW/DESCRIBE/DESC/EXPLAIN 不需要 LIMIT
  const upper = trimmed.toUpperCase();
  if (['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].some(p => upper.startsWith(p))) {
    return trimmed;
  }
  return `${trimmed} LIMIT ${limit}`;
}
