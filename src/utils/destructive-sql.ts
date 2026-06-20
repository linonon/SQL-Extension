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

// 脚本中任一条语句命中即需确认. 逐条判断, 避免别条的 WHERE/前缀掩盖某条整表操作
// (PG simple query protocol 单字符串可执行多语句; 去掉字符串/注释后按 ; 切分是安全的).
export function isWholeTableWrite(sql: string): boolean {
  return stripCommentsAndStrings(sql).split(';').some(isDestructiveStatement);
}
