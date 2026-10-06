// readonly SQL 预检: best-effort, 只为给出友好报错. 真正的只读边界是 driver.executeReadOnly 的只读事务和 DB 账号权限,
// 文本检查挡不全 (如带引号的函数名 "pg_terminate_backend"(1), dblink_send_query), 不要靠逐条加黑名单正则来补
// 只允许 SELECT/SHOW/DESCRIBE/DESC/EXPLAIN/WITH 开头的语句: 挡住 MySQL DDL (DDL 会隐式提交, 只读事务挡不住)
// 拒绝任何 INTO: 只读事务挡不住 MySQL INTO OUTFILE/DUMPFILE; 在原文上查, 宁可误杀字面量里的 into
// 多语句由调用方先用 isMultiStatement 拒绝 (db_read 与 db_execute 都要挡)

import { splitSqlStatements, type SqlDialect } from '../utils/destructive-sql.js';

const ALLOWED_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];

const MAX_LIMIT = 500;

// 只读事务管不到的会话级 / 跨会话副作用的常见写法: 命名锁, advisory lock, 杀连接, 远程执行 (best-effort, 不是完整清单)
const SIDE_EFFECT_FUNCS = /\b(get_lock|pg_(try_)?advisory_(xact_)?lock(_shared)?|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|dblink(_exec)?)\s*\(/i;

// 按方言切分后多于一条: 注释与字符串里的 ; 不算; PG 的 'a\' 结束字符串, 其后的 ; 是真分隔符
export function isMultiStatement(sql: string, dialect: SqlDialect): boolean {
  return splitSqlStatements(sql, dialect).length > 1;
}

export function isReadonlySQL(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  if (!ALLOWED_PREFIXES.some(p => trimmed.startsWith(p))) {
    return false;
  }
  return !/\bINTO\b/i.test(sql) && !SIDE_EFFECT_FUNCS.test(sql);
}

// 强制追加或替换 LIMIT, 不超过 MAX_LIMIT
// 返回处理后的 SQL
export function enforceLimit(sql: string, requestedLimit?: number, isMysql = true): string {
  const limit = Math.min(requestedLimit ?? MAX_LIMIT, MAX_LIMIT);
  const trimmed = sql.trim().replace(/;$/, '');
  // 屏蔽字符串后切掉末尾行注释, 在正文上找 LIMIT: 注释里的 "LIMIT n" 不算数.
  // MySQL 行注释是 "-- " 或 "#"; PG 是 "--" ("#" 在 PG 是运算符)
  const masked = trimmed.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, m => ' '.repeat(m.length));
  const cut = masked.search(isMysql ? /(?:--(?:\s|$)|#)[^\n]*$/ : /--[^\n]*$/);
  const body = (cut >= 0 ? trimmed.slice(0, cut) : trimmed).trimEnd();
  // 已有 LIMIT n / LIMIT n OFFSET m / LIMIT m, n: 只把行数 n 压到上限
  const limitMatch = body.match(/\bLIMIT\s+(\d+)(\s*,\s*(\d+))?(\s+OFFSET\s+\d+)?\s*$/i);
  if (limitMatch) {
    const countIdx = limitMatch[3] !== undefined ? 3 : 1;
    if (parseInt(limitMatch[countIdx], 10) <= limit) {
      return trimmed;
    }
    const capped = countIdx === 3
      ? `LIMIT ${limitMatch[1]}, ${limit}`
      : `LIMIT ${limit}${limitMatch[4] ?? ''}`;
    return body.slice(0, limitMatch.index) + capped;
  }
  // SHOW/DESCRIBE/DESC/EXPLAIN 不需要 LIMIT
  const upper = trimmed.toUpperCase();
  if (['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].some(p => upper.startsWith(p))) {
    return trimmed;
  }
  // 换行再追加: 原 SQL 以行注释结尾时 LIMIT 不会被注释吞掉
  return `${trimmed}\nLIMIT ${limit}`;
}
