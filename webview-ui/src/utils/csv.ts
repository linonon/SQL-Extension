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

// 开头带 UTF-8 BOM: Excel 没有 BOM 时按本地编码打开, 中文会乱码
export function generateCsv(
  columns: readonly ColumnInfo[],
  rows: readonly Record<string, unknown>[]
): string {
  const header = columns.map((col) => escapeField(col.name)).join(',');
  const body = rows.map((row) =>
    columns.map((col) => escapeField(row[col.name])).join(',')
  );
  return '\uFEFF' + [header, ...body].join('\r\n');
}
