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

// 按引号 / 注释之外的 ; 切分, 返回每条语句在原文中的 [start, end) 区间 (去掉首尾空白, 不含 ;);
// 丢掉只剩空白或注释的段. Execute 多语句, 破坏性确认网与 webview 的光标所在语句共用.
function splitSqlStatementRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const push = (from: number, to: number) => {
    const part = sql.slice(from, to);
    const start = from + part.length - part.trimStart().length;
    const end = to - (part.length - part.trimEnd().length);
    if (stripCommentsAndStrings(sql.slice(start, end)).length > 0) ranges.push([start, end]);
  };
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
      push(start, i);
      start = ++i;
    } else {
      i++;
    }
  }
  push(start, sql.length);
  return ranges;
}

// 按引号 / 注释之外的 ; 切分, 返回原文片段 (要拿去执行, 不能是去掉字符串后的文本)
export function splitSqlStatements(sql: string): string[] {
  return splitSqlStatementRanges(sql).map(([start, end]) => sql.slice(start, end));
}

// 区间开头的空白与注释 (只用于定位代码起点, 不用于执行)
const LEADING_BLANK = /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*/;

// 光标所在的那条语句 (原文, 去掉首尾空白): 光标在语句内, 或在它的 ; 之后到下一条的第一个代码字符之前
// (中间的空白和注释) 都算这一条; 落在第一条之前算第一条. 没有语句返回 undefined
export function statementAtCaret(sql: string, caret: number): string | undefined {
  const ranges = splitSqlStatementRanges(sql);
  const codeStarts = ranges.map(([start, end]) => start + LEADING_BLANK.exec(sql.slice(start, end))![0].length);
  let pick = 0;
  codeStarts.forEach((codeStart, i) => { if (codeStart <= caret) pick = i; });
  // ; 与下一条之间没有空白时, 光标紧贴 ; 之后仍算前一条
  if (pick > 0 && codeStarts[pick] === caret && sql[caret - 1] === ';') pick--;
  const range = ranges[pick];
  return range && sql.slice(range[0], range[1]);
}

export const OPEN_TRANSACTION_WARNING =
  'Open transaction was rolled back when the session closed: each execution runs on its own connection, put COMMIT in the same execution.';

// MySQL executeBatch 结束即销毁会话: 已执行的语句留下未结束的事务 (BEGIN / START TRANSACTION 之后没有 COMMIT / ROLLBACK,
// 或 autocommit 关掉后又执行了语句), 这个事务已被服务端回滚, 返回提示文本.
// 只看语句开头的关键字 (best-effort, 不认 DDL 的隐式提交). PG 看服务端返回的命令标签, 不走这里
export function openTransactionWarning(executed: readonly string[]): string | undefined {
  let open = false;
  let autocommitOff = false;
  for (const stmt of executed) {
    const s = stripCommentsAndStrings(stmt);
    const autocommit = /^SET\s+(?:(?:SESSION|LOCAL)\s+|@@(?:(?:SESSION|LOCAL)\.)?)?autocommit\s*:?=\s*(\w+)/i.exec(s);
    if (autocommit) {
      autocommitOff = /^(0|OFF|FALSE)$/i.test(autocommit[1]);
      // autocommit 置回 1 会提交当前事务
      if (!autocommitOff) { open = false; }
    } else if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(s)) {
      open = true;
    } else if (/^(COMMIT|END|ROLLBACK)\b/i.test(s) && !/^ROLLBACK\s+(WORK\s+)?TO\b/i.test(s)) {
      open = false;
    } else if (autocommitOff) {
      open = true;
    }
  }
  return open ? OPEN_TRANSACTION_WARNING : undefined;
}

// 脚本中任一条语句命中即需确认. 逐条判断, 避免别条的 WHERE/前缀掩盖某条整表操作
// (PG simple query protocol 单字符串可执行多语句; 去掉字符串/注释后按 ; 切分是安全的).
export function isWholeTableWrite(sql: string): boolean {
  return splitSqlStatements(sql).some((stmt) => isDestructiveStatement(stripCommentsAndStrings(stmt)));
}
