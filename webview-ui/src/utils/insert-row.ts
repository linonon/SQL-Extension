import type { ColumnInfo } from '../types/database';

// 列由 DB 自动填充 (自增 / 序列 / identity): insert 时必须省略, 透传旧值会撞唯一键或干扰自增.
// MySQL 走 extra=auto_increment; PostgreSQL 走 default=nextval(...) 或 identity (extra 恒为空).
export function isAutoFilledColumn(col: ColumnInfo): boolean {
  const extra = col.extra?.toLowerCase() ?? '';
  if (extra.includes('auto_increment') || extra.includes('identity')) {
    return true;
  }
  const def = col.defaultValue?.toLowerCase() ?? '';
  return def.includes('nextval(') || def.includes('identity');
}

// 默认值是 SQL 表达式 (无参关键字或函数调用) 而非字面量: 当字面值写库会存进文本而非求值结果.
// information_schema 对这类列返回的是表达式文本 (如 "CURRENT_TIMESTAMP", "now()", "true").
// 关键字集与 ext-host alter-table-builder.EXPRESSION_DEFAULT_KEYWORDS 保持一致 (两端独立构建无法共享).
export function isExpressionDefault(value: string): boolean {
  const v = value.trim();
  if (/^(current_timestamp|current_date|current_time|localtime|localtimestamp|null|true|false)$/i.test(v)) {
    return true;
  }
  // 函数调用形态: ident(...) 如 now(), gen_random_uuid(), nextval('s')
  return /^[a-z_][a-z0-9_]*\s*\(.*\)$/i.test(v);
}

// 构造 "插入新行" 的初始 row.
// 自动填充列与表达式默认值列一律省略, 交给 DB 应用默认 (不把字面量/表达式文本透传写库);
// 字面量默认值预填供用户编辑; 无默认值的列省略 (nullable 由 DB 取 NULL, NOT NULL 则 DB 报缺值).
export function buildInsertRow(columns: readonly ColumnInfo[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    if (isAutoFilledColumn(col)) {
      continue;
    }
    const def = col.defaultValue;
    if (def === null || isExpressionDefault(def)) {
      continue;
    }
    row[col.name] = def;
  }
  return row;
}
