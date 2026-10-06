// raw SQL 编辑器的破坏性操作确认网 (best-effort 启发式, 非完整解析器).
// 目标: 在执行前提示用户确认 DROP/TRUNCATE, ALTER TABLE 删列 / 约束 / 分区, 以及无 WHERE 的整表 DELETE/UPDATE.
// 注意: 这是 UX 防误删/误改护栏, 不是安全边界 (用户本就能自由写 SQL).

// 单条语句是否为需要确认的破坏性写操作:
// - DROP / TRUNCATE: 总是
// - ALTER TABLE 带 DROP (列 / 索引 / 约束 / 分区) 或 TRUNCATE PARTITION: 与 Edit Table 删列同样确认;
//   ALTER COLUMN 的 DROP DEFAULT / NOT NULL / EXPRESSION / IDENTITY 只改列属性, 不算
// - DELETE FROM / UPDATE: 仅当本语句无 WHERE 子句 (整表操作) 时
function isDestructiveStatement(stmt: string): boolean {
  const s = stmt.trim();
  if (/^(DROP|TRUNCATE)\b/i.test(s)) {
    return true;
  }
  if (/^ALTER\s+TABLE\b/i.test(s)) {
    return /\bDROP\b(?!\s+(?:DEFAULT|NOT\s+NULL|EXPRESSION|IDENTITY)\b)|\bTRUNCATE\s+PARTITION\b/i.test(s);
  }
  if (/^(DELETE\s+FROM|UPDATE)\b/i.test(s)) {
    return !/\bWHERE\b/i.test(s);
  }
  return false;
}

export type SqlDialect = 'mysql' | 'postgresql';

// 从引号起点 i 跳到配对的收尾引号之后: 认双写转义, backslash 为 true 时也认反斜杠转义
function skipQuoted(sql: string, i: number, quote: string, backslash: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    if (backslash && sql[j] === '\\') { j += 2; continue; }
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

// 从块注释起点 i 跳到它的 */ 之后; nested (PG) 时内层 /* */ 成对计数
function skipBlockComment(sql: string, i: number, nested: boolean): number {
  let depth = 1;
  let j = i + 2;
  while (j < sql.length) {
    if (nested && sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
    else if (sql[j] === '*' && sql[j + 1] === '/') { j += 2; if (--depth === 0) return j; }
    else j++;
  }
  return sql.length;
}

// i 处是注释时返回注释之后的位置, 否则原样返回 i. 只有 MySQL 认 # 行注释, PG 的块注释可嵌套
function skipComment(sql: string, i: number, dialect: SqlDialect): number {
  if ((sql[i] === '-' && sql[i + 1] === '-') || (sql[i] === '#' && dialect === 'mysql')) {
    const nl = sql.indexOf('\n', i);
    return nl < 0 ? sql.length : nl;
  }
  if (sql[i] === '/' && sql[i + 1] === '*') return skipBlockComment(sql, i, dialect === 'postgresql');
  return i;
}

// 标识符 / 关键字整段吃掉: PG 标识符里的 $ 不是 dollar quote 的开头 (a$b$ 是一个标识符)
const IDENTIFIER = /[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/y;
// PG dollar quote 的开头 $tag$ (tag 可空, 不以数字开头)
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;

// 从 i 跳过一个代码 token (字符串 / 带引号的标识符 / dollar quote / 标识符 / 单个字符), 返回它之后的位置.
// MySQL: '..' 与 ".." 是字符串, 认反斜杠转义; `..` 是标识符.
// PG (standard_conforming_strings, 9.1 起默认开): 只有 E'..' 认反斜杠; ".." 是标识符; $tag$..$tag$ 是字符串
function skipToken(sql: string, i: number, dialect: SqlDialect): number {
  const c = sql[i];
  const pg = dialect === 'postgresql';
  if (c === "'" || c === '"') return skipQuoted(sql, i, c, !pg);
  if (c === '`' && !pg) return skipQuoted(sql, i, c, false);
  if (c === '$' && pg) {
    DOLLAR_TAG.lastIndex = i;
    const tag = DOLLAR_TAG.exec(sql)?.[0];
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      return close < 0 ? sql.length : close + tag.length;
    }
  }
  IDENTIFIER.lastIndex = i;
  const word = IDENTIFIER.exec(sql)?.[0];
  if (word) {
    const j = i + word.length;
    if (pg && (word === 'E' || word === 'e') && sql[j] === "'") return skipQuoted(sql, j, "'", true);
    return j;
  }
  return i + 1;
}

interface StatementRange {
  // [start, end): 语句原文去掉首尾空白, 不含 ;
  readonly start: number;
  readonly end: number;
  // 第一个代码字符 (跳过开头的注释)
  readonly code: number;
}

// 按引号 / 注释 / dollar quote 之外的 ; 切分, 丢掉只剩空白或注释的段.
// Execute 多语句, 破坏性确认网, MCP 单语句校验与 webview 的光标所在语句共用
function statementRanges(sql: string, dialect: SqlDialect): StatementRange[] {
  const ranges: StatementRange[] = [];
  let start = 0;
  let code = -1;
  const close = (to: number) => {
    if (code < 0) return;
    let end = to;
    while (/\s/.test(sql[end - 1])) end--;
    ranges.push({ start: start + sql.slice(start, code + 1).search(/\S/), end, code });
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const afterComment = skipComment(sql, i, dialect);
    if (afterComment > i) {
      i = afterComment;
    } else if (c === ';') {
      close(i);
      start = ++i;
      code = -1;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      if (code < 0) code = i;
      i = skipToken(sql, i, dialect);
    }
  }
  close(sql.length);
  return ranges;
}

// 语句的代码部分, 与切分同一套词法: 注释换成空格, 字符串 / dollar quote / 带引号的标识符换成 '', 去掉首尾空白.
// 只用来看开头关键字和有没有 WHERE, 引号与注释里的文字不算数
function codeOnly(stmt: string, dialect: SqlDialect): string {
  let out = '';
  let i = 0;
  while (i < stmt.length) {
    const afterComment = skipComment(stmt, i, dialect);
    if (afterComment > i) {
      out += ' ';
      i = afterComment;
      continue;
    }
    const j = skipToken(stmt, i, dialect);
    const token = stmt.slice(i, j);
    out += token.length > 1 && /^(?:[Ee]?['"`]|\$)/.test(token) ? "''" : token;
    i = j;
  }
  return out.trim();
}

// 切分后的语句原文 (要拿去执行, 不能是去掉字符串后的文本)
export function splitSqlStatements(sql: string, dialect: SqlDialect): string[] {
  return statementRanges(sql, dialect).map(({ start, end }) => sql.slice(start, end));
}

// 光标所在的那条语句 (原文, 去掉首尾空白): 光标在语句内, 或在它的 ; 之后到下一条的第一个代码字符之前
// (中间的空白和注释) 都算这一条; 落在第一条之前算第一条. 没有语句返回 undefined
export function statementAtCaret(sql: string, caret: number, dialect: SqlDialect): string | undefined {
  const ranges = statementRanges(sql, dialect);
  let pick = 0;
  ranges.forEach(({ code }, i) => { if (code <= caret) pick = i; });
  // ; 与下一条之间没有空白时, 光标紧贴 ; 之后仍算前一条
  if (pick > 0 && ranges[pick].code === caret && sql[caret - 1] === ';') pick--;
  const range = ranges[pick];
  return range && sql.slice(range.start, range.end);
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
    const s = codeOnly(stmt, 'mysql');
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

// 需要确认的语句在 sql 里的位置 [start, end) (去掉首尾空白, 不含 ;): 编辑器划线用, 与执行前的确认同一判定.
// 逐条判断, 避免别条的 WHERE/前缀掩盖某条整表操作
// (PG simple query protocol 单字符串可执行多语句, 按方言切分才能和服务端切得一样).
export function destructiveStatementRanges(sql: string, dialect: SqlDialect): { readonly start: number; readonly end: number }[] {
  return statementRanges(sql, dialect).filter(({ start, end }) => isDestructiveStatement(codeOnly(sql.slice(start, end), dialect)));
}

// 脚本中任一条语句命中即需确认
export function isWholeTableWrite(sql: string, dialect: SqlDialect): boolean {
  return destructiveStatementRanges(sql, dialect).length > 0;
}
