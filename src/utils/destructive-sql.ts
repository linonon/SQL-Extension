// raw SQL 编辑器的破坏性操作确认网 (best-effort 启发式, 非完整解析器).
// 目标: 在执行前提示用户确认 DROP/TRUNCATE, 以及无 WHERE 的整表 DELETE/UPDATE.
// 注意: 这是 UX 防误删/误改护栏, 不是安全边界 (用户本就能自由写 SQL).

// 去掉注释与字符串常量, 避免其中的 WHERE/分号/关键字干扰判断.
function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/--[^\n]*/g, ' ')           // 行注释
    .replace(/'(?:[^']|'')*'/g, "''")    // 单引号字符串
    .replace(/"(?:[^"]|"")*"/g, '""')    // 双引号 (PG 标识符 / 字符串)
    .trim();
}

// 单条语句是否为需要确认的破坏性写操作:
// - DROP / TRUNCATE: 总是
// - DELETE FROM / UPDATE: 仅当本语句无 WHERE 子句 (整表操作) 时
function isDestructiveStatement(stmt: string): boolean {
  const s = stmt.trim();
  if (/^(DROP|TRUNCATE)\b/i.test(s)) {
    return true;
  }
  if (/^(DELETE\s+FROM|UPDATE)\b/i.test(s)) {
    return !/\bWHERE\b/i.test(s);
  }
  return false;
}

// 从引号起点 i 跳到配对的收尾引号之后; 认 '' 双写与反斜杠转义 (MySQL 默认), 反引号标识符只认双写
function skipQuoted(sql: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === '\\' && quote !== '`') { j += 2; continue; }
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

// 按引号 / 注释之外的 ; 切分, 返回原文片段 (要拿去执行, 不能是去掉字符串后的文本);
// 丢掉只剩空白或注释的段. Execute 多语句与破坏性确认网共用.
export function splitSqlStatements(sql: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(sql, i, c);
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === ';') {
      parts.push(sql.slice(start, i));
      start = ++i;
    } else {
      i++;
    }
  }
  parts.push(sql.slice(start));
  return parts.map((p) => p.trim()).filter((p) => stripCommentsAndStrings(p).length > 0);
}

// 脚本中任一条语句命中即需确认. 逐条判断, 避免别条的 WHERE/前缀掩盖某条整表操作
// (PG simple query protocol 单字符串可执行多语句; 去掉字符串/注释后按 ; 切分是安全的).
export function isWholeTableWrite(sql: string): boolean {
  return splitSqlStatements(sql).some((stmt) => isDestructiveStatement(stripCommentsAndStrings(stmt)));
}
