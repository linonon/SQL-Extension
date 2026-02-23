// SQL 词法分析器, 纯函数, 单遍扫描, 零依赖

export type TokenType =
  | 'keyword' | 'string' | 'number' | 'comment'
  | 'operator' | 'punctuation' | 'identifier' | 'whitespace';

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly start: number;
}

export const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
  'AS', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'DROP', 'ALTER', 'TABLE', 'INDEX', 'VIEW', 'DATABASE',
  'TRUNCATE', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
  'DISTINCT', 'ALL', 'UNION', 'INTERSECT', 'EXCEPT',
  'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'IF', 'BEGIN', 'COMMIT', 'ROLLBACK', 'GRANT', 'REVOKE',
  'TRUE', 'FALSE', 'WITH', 'RECURSIVE', 'REPLACE', 'EXPLAIN',
  'CONSTRAINT', 'UNIQUE', 'CHECK', 'DEFAULT', 'CASCADE',
]);

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

const TWO_CHAR_OPERATORS = new Set(['<>', '>=', '<=', '!=', '||']);
const SINGLE_OPERATORS = new Set(['=', '<', '>', '+', '-', '*', '/', '%']);
const PUNCTUATION = new Set(['(', ')', ',', ';', '.']);

export function tokenize(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    const ch = sql[i];

    // whitespace
    if (isWhitespace(ch)) {
      const start = i;
      while (i < len && isWhitespace(sql[i])) i++;
      tokens.push({ type: 'whitespace', value: sql.slice(start, i), start });
      continue;
    }

    // 单行注释 --
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      const start = i;
      while (i < len && sql[i] !== '\n') i++;
      tokens.push({ type: 'comment', value: sql.slice(start, i), start });
      continue;
    }

    // 多行注释 /* */
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(sql[i - 1] === '*' && sql[i] === '/')) i++;
      if (i < len) i++; // 跳过闭合的 /
      tokens.push({ type: 'comment', value: sql.slice(start, i), start });
      continue;
    }

    // 字符串 ' 或 "
    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i++;
      while (i < len && sql[i] !== quote) {
        if (sql[i] === '\\') i++; // 跳过转义
        i++;
      }
      if (i < len) i++; // 跳过闭合引号
      tokens.push({ type: 'string', value: sql.slice(start, i), start });
      continue;
    }

    // 反引号 identifier (MySQL)
    if (ch === '`') {
      const start = i;
      i++;
      while (i < len && sql[i] !== '`') i++;
      if (i < len) i++;
      tokens.push({ type: 'identifier', value: sql.slice(start, i), start });
      continue;
    }

    // 数字 (含小数点)
    if (isDigit(ch)) {
      const start = i;
      while (i < len && isDigit(sql[i])) i++;
      if (i < len && sql[i] === '.') {
        i++;
        while (i < len && isDigit(sql[i])) i++;
      }
      tokens.push({ type: 'number', value: sql.slice(start, i), start });
      continue;
    }

    // 标识符 / 关键字
    if (isIdentStart(ch)) {
      const start = i;
      while (i < len && isIdentChar(sql[i])) i++;
      const word = sql.slice(start, i);
      const type = SQL_KEYWORDS.has(word.toUpperCase()) ? 'keyword' : 'identifier';
      tokens.push({ type, value: word, start });
      continue;
    }

    // 两字符 operator
    if (i + 1 < len) {
      const two = sql.slice(i, i + 2);
      if (TWO_CHAR_OPERATORS.has(two)) {
        tokens.push({ type: 'operator', value: two, start: i });
        i += 2;
        continue;
      }
    }

    // 单字符 operator
    if (SINGLE_OPERATORS.has(ch)) {
      tokens.push({ type: 'operator', value: ch, start: i });
      i++;
      continue;
    }

    // punctuation
    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: 'punctuation', value: ch, start: i });
      i++;
      continue;
    }

    // 未识别字符, 当作 identifier
    tokens.push({ type: 'identifier', value: ch, start: i });
    i++;
  }

  return tokens;
}
