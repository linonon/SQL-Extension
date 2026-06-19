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

// 是否为需要确认的破坏性写操作:
// - DROP / TRUNCATE: 总是
// - DELETE FROM / UPDATE: 仅当无顶层 WHERE 子句 (整表操作) 时
export function isWholeTableWrite(sql: string): boolean {
  const cleaned = stripCommentsAndStrings(sql);
  if (/^(DROP|TRUNCATE)\b/i.test(cleaned)) {
    return true;
  }
  if (/^(DELETE\s+FROM|UPDATE)\b/i.test(cleaned)) {
    return !/\bWHERE\b/i.test(cleaned);
  }
  return false;
}
