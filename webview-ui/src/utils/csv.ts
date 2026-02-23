import type { ColumnInfo } from '../types/database';

// RFC 4180: 字段包含逗号, 双引号, 换行时需要用双引号包裹, 内部双引号转义为两个双引号
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateCsv(
  columns: readonly ColumnInfo[],
  rows: readonly Record<string, unknown>[]
): string {
  const header = columns.map((col) => escapeField(col.name)).join(',');
  const body = rows.map((row) =>
    columns.map((col) => escapeField(row[col.name])).join(',')
  );
  return [header, ...body].join('\r\n');
}
