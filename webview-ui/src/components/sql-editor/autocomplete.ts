// SQL 补全逻辑: 触发检测 + 候选项过滤

import { SQL_KEYWORDS } from './sql-tokenizer';

export interface AutocompleteContext {
  readonly triggerType: 'table' | 'column' | 'keyword' | null;
  readonly prefix: string;
  readonly tableName?: string;
  readonly quoted: boolean;
}

// 表名触发关键字 (支持可选反引号)
const TABLE_TRIGGERS = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"]?(\w*)$/i;
// 列名触发: tableName.prefix (支持反引号/双引号包裹的表名和列名前缀)
const COLUMN_TRIGGER = /[`"]?(\w+)[`"]?\.[`"]?(\w*)$/;

// 从完整 SQL 中提取 FROM 后的第一个表名
function extractTableName(sql: string): string | undefined {
  const m = sql.match(/\bFROM\s+[`"]?(\w+)[`"]?/i);
  return m?.[1];
}

// 判断 cursor 是否在列名位置 (SELECT 字段 / WHERE 条件 / ORDER BY 等), 返回 prefix
function getColumnContext(before: string): string | null {
  const upper = before.toUpperCase();
  // SELECT 字段位置: SELECT 存在且 FROM 还没出现
  if (upper.includes('SELECT') && !upper.includes('FROM')) {
    const m = before.match(/(?:SELECT\s+|,\s*)[`"]?(\w*)$/i);
    if (m) return m[1];
  }
  // WHERE / AND / OR / ON / HAVING / SET 后
  const clauseMatch = before.match(/\b(?:WHERE|AND|OR|ON|HAVING|SET)\s+[`"]?(\w*)$/i);
  if (clauseMatch) return clauseMatch[1];
  // ORDER BY / GROUP BY 后
  const byMatch = before.match(/\b(?:ORDER|GROUP)\s+BY\s+[`"]?(\w*)$/i);
  if (byMatch) return byMatch[1];
  return null;
}

// 判断 cursor 是否在字符串或注释内
function isInsideStringOrComment(text: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '-' && i + 1 < text.length && text[i + 1] === '-') {
        // 单行注释, cursor 在注释内
        return true;
      }
      if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
        // 多行注释开始, 如果没有闭合则 cursor 在内部
        const closeIdx = text.indexOf('*/', i + 2);
        if (closeIdx === -1) return true;
        i = closeIdx + 2;
        continue;
      }
      if (ch === "'") { inSingleQuote = true; i++; continue; }
      if (ch === '"') { inDoubleQuote = true; i++; continue; }
    } else if (inSingleQuote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") { inSingleQuote = false; }
    } else if (inDoubleQuote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inDoubleQuote = false; }
    }
    i++;
  }
  return inSingleQuote || inDoubleQuote;
}

export function getAutocompleteContext(text: string, cursorPos: number): AutocompleteContext {
  const before = text.slice(0, cursorPos);

  // 字符串/注释内不触发
  if (isInsideStringOrComment(before)) {
    return { triggerType: null, prefix: '', quoted: false };
  }

  // 检测 prefix 前是否有反引号
  const hasBacktick = (prefix: string): boolean => {
    const idx = before.lastIndexOf(prefix);
    return idx > 0 && before[idx - 1] === '`';
  };

  // 列补全: tableName.prefix
  const colMatch = before.match(COLUMN_TRIGGER);
  if (colMatch) {
    return { triggerType: 'column', prefix: colMatch[2], tableName: colMatch[1], quoted: hasBacktick(colMatch[2]) };
  }

  // 表补全: FROM/JOIN/INTO/UPDATE/TABLE + 空白 + prefix
  const tableMatch = before.match(TABLE_TRIGGERS);
  if (tableMatch) {
    return { triggerType: 'table', prefix: tableMatch[1], quoted: hasBacktick(tableMatch[1]) };
  }

  // clause 列补全: cursor 在列位置且能从 SQL 提取表名
  const columnPrefix = getColumnContext(before);
  if (columnPrefix !== null) {
    const tableName = extractTableName(text);
    if (tableName) {
      return { triggerType: 'column', prefix: columnPrefix, tableName, quoted: hasBacktick(columnPrefix) };
    }
  }

  // 关键字补全: >= 2 字符的标识符前缀
  const kwMatch = before.match(/\b(\w{2,})$/);
  if (kwMatch) {
    return { triggerType: 'keyword', prefix: kwMatch[1], quoted: false };
  }

  return { triggerType: null, prefix: '', quoted: false };
}

// 如果 ctx.quoted 为 true, 包装成 `item` 格式
function wrapQuoted(items: readonly string[], quoted: boolean): readonly string[] {
  return quoted ? items.map((item) => `\`${item}\``) : items;
}

export function getCompletionItems(
  ctx: AutocompleteContext,
  schema: Record<string, string[]>,
): readonly string[] {
  if (ctx.triggerType === null) return [];

  const prefix = ctx.prefix.toLowerCase();

  if (ctx.triggerType === 'table') {
    const tables = Object.keys(schema);
    const filtered = prefix
      ? tables.filter((t) => t.toLowerCase().startsWith(prefix))
      : tables;
    return wrapQuoted(filtered, ctx.quoted);
  }

  if (ctx.triggerType === 'column' && ctx.tableName) {
    const columns = schema[ctx.tableName] ?? schema[ctx.tableName.toLowerCase()] ?? [];
    const filtered = prefix
      ? columns.filter((c) => c.toLowerCase().startsWith(prefix))
      : columns;
    return wrapQuoted(filtered, ctx.quoted);
  }

  if (ctx.triggerType === 'keyword') {
    return [...SQL_KEYWORDS].filter((kw) => kw.toLowerCase().startsWith(prefix));
  }

  return [];
}
